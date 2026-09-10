// 套件: Empty Turn Invariant — 模型没有可见输出时绝不静默"完成"
// 用法: npx tsx tests/empty-turn.test.ts
// 回归目标（v1.8）：DB 中 4/81 个 completed run 的 result 是空字符串（模型只输出
// reasoning，content 为空且无 tool_call）。内核必须按 Harness 策略有界恢复，
// 用尽后 fail loudly，而不是把空回答当成最终答案。

import assert from 'node:assert/strict';
import { DefaultContextHarness } from '../src/harness/context-harness.js';
import { AgentEmptyAnswerError, AgentStalledError } from '../src/runtime/agent.js';
import {
  createTestWorkspaceRoot,
  emptyResponse,
  runMockAgent,
  MOCK_MODEL_CONFIG,
  textResponse,
  toolCallResponse,
} from './helpers/mock-runner.js';
import { register } from '../src/tools/tools.js';

const WORKSPACE = createTestWorkspaceRoot('payaso-empty-turn-');

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

register({
  name: 'empty-turn-probe',
  description: 'deterministic tool for empty-turn tests',
  effect: 'read',
  parameters: { type: 'object', properties: {}, additionalProperties: true },
  execute: async () => 'probe-ok',
});

await check('空回答 → 追加 Harness 提示并恢复，第二次有内容则正常完成', async () => {
  const requestBodies: unknown[] = [];
  const result = await runMockAgent({
    runId: 'empty-turn-recover',
    task: '做点事',
    workspaceRoot: WORKSPACE,
    onRequest: (body) => requestBodies.push(body),
    script: [() => emptyResponse(), () => textResponse('这是最终答案')],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.answer, '这是最终答案');
  assert.equal(result.fetchCalls, 2, '空回答后必须再请求一次模型');

  const recovered = result.traces.filter((event) => event.type === 'empty_turn_recovered');
  assert.equal(recovered.length, 1, '应恰好发生一次恢复');
  const first = recovered[0];
  assert.equal(first.type === 'empty_turn_recovered' ? first.attempt : 0, 1);
  assert.equal(first.type === 'empty_turn_recovered' ? first.maxAttempts : 0, 2);

  // 模型必须看到"上一轮是空的"这条提示
  const second = requestBodies[1] as { messages?: Array<{ role: string; content: string }> };
  const lastMessage = second?.messages?.[second.messages.length - 1];
  assert.equal(lastMessage?.role, 'user');
  assert.ok(
    lastMessage?.content.includes('no visible content'),
    `提示内容不符: ${lastMessage?.content}`,
  );
});

await check('持续空回答 → 恢复次数用尽后 fail loudly（绝不 completed）', async () => {
  const result = await runMockAgent({
    runId: 'empty-turn-exhausted',
    task: '一直空着',
    workspaceRoot: WORKSPACE,
    script: [() => emptyResponse()], // 脚本耗尽后重复最后一条
  });
  assert.ok(result.error, '空回答耗尽后必须失败');
  assert.equal(result.error?.name, 'AgentEmptyAnswerError');
  assert.ok(result.error instanceof AgentEmptyAnswerError);
  assert.equal(result.fetchCalls, 3, '初始 1 次 + 2 次恢复');
  const recovered = result.traces.filter((event) => event.type === 'empty_turn_recovered');
  assert.equal(recovered.length, 2, '恢复次数应等于策略上限');
  assert.ok(
    !result.traces.some((event) => event.type === 'final_answer'),
    '不得产生 final_answer',
  );
});

await check('有 tool_calls 的空 content 是正常回合，不触发恢复', async () => {
  const result = await runMockAgent({
    runId: 'empty-turn-with-tools',
    task: '调工具',
    workspaceRoot: WORKSPACE,
    script: [
      () => toolCallResponse([{ id: 'e1', name: 'empty-turn-probe', args: {} }]),
      () => textResponse('工具跑完了'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.answer, '工具跑完了');
  assert.equal(
    result.traces.filter((event) => event.type === 'empty_turn_recovered').length,
    0,
    '工具回合不是空回合',
  );
});

await check('非空但承诺继续执行的回答 → Finalization Guard 恢复并继续调工具', async () => {
  const requestBodies: unknown[] = [];
  const result = await runMockAgent({
    runId: 'finalization-guard-recover',
    task: '核对测试结果',
    workspaceRoot: WORKSPACE,
    onRequest: (body) => requestBodies.push(body),
    script: [
      () => textResponse('为了严谨，再确认一下，把 test:all 的完整清单抓出来对照：'),
      () => toolCallResponse([{ id: 'fg1', name: 'empty-turn-probe', args: {} }]),
      () => textResponse('已经完成核对，结果如下：只读套件通过。'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.answer, '已经完成核对，结果如下：只读套件通过。');
  assert.equal(result.fetchCalls, 3, '未完成文本后应多请求一次，然后继续执行工具');

  const guards = result.traces.filter((event) => event.type === 'finalization_guard');
  assert.equal(guards.length, 1, '应恰好触发一次 finalization guard');
  assert.equal(guards[0]?.type === 'finalization_guard' ? guards[0].disposition : '', 'retry');
  const second = requestBodies[1] as { messages?: Array<{ role: string; content: string }> };
  const lastMessage = second?.messages?.[second.messages.length - 1];
  assert.equal(lastMessage?.role, 'user');
  assert.ok(lastMessage?.content.includes('did not call a tool'));
});

await check('未完成文本恢复耗尽 → stalled/fail，绝不 completed', async () => {
  const result = await runMockAgent({
    runId: 'finalization-guard-exhausted',
    task: '不要提前结束',
    workspaceRoot: WORKSPACE,
    script: [() => textResponse('接下来运行 test:all：')],
  });
  assert.ok(result.error, '恢复耗尽后必须失败');
  assert.equal(result.error?.name, 'AgentStalledError');
  assert.ok(result.error instanceof AgentStalledError);
  assert.equal(result.fetchCalls, 2, '初始 1 次 + 1 次 finalization 恢复');
  const guards = result.traces.filter((event) => event.type === 'finalization_guard');
  assert.equal(guards.length, 2, '应记录 retry 和 fail 两个 guard 事件');
  assert.equal(guards[0]?.type === 'finalization_guard' ? guards[0].disposition : '', 'retry');
  assert.equal(guards[1]?.type === 'finalization_guard' ? guards[1].disposition : '', 'fail');
  assert.ok(!result.traces.some((event) => event.type === 'final_answer'));
});

await check('正常结论、引用、代码示例和授权提问不触发继续执行', async () => {
  const answers = [
    '接下来运行测试是建议。当前审计已完成。',
    '下一步可以检查测试。\n日志字段名：',
    '> 接下来运行测试：',
    '示例文本：接下来运行测试：',
    '```text\n接下来运行测试：\n```',
    '当前为只读权限，接下来运行测试需要写入。是否授权？',
  ];
  for (const [index, answer] of answers.entries()) {
    const result = await runMockAgent({
      runId: `finalization-accepted-${index}`,
      task: '解释现状，不执行命令',
      workspaceRoot: WORKSPACE,
      script: [() => textResponse(answer)],
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.answer, answer);
    assert.equal(result.fetchCalls, 1);
  }
});

await check('自定义 Harness 可以关闭文本启发式，不被 Runtime 默认策略覆盖', async () => {
  class AcceptTextHarness extends DefaultContextHarness {
    override incompleteTurnPolicy() { return undefined; }
  }
  const answer = '接下来运行 test:all：';
  const result = await runMockAgent({
    runId: 'finalization-disabled',
    task: '只返回给定文本',
    workspaceRoot: WORKSPACE,
    contextHarness: new AcceptTextHarness({
      permissionMode: 'read-only', modelConfig: MOCK_MODEL_CONFIG,
    }),
    script: [() => textResponse(answer)],
  });
  assert.equal(result.answer, answer);
  assert.equal(result.fetchCalls, 1);
  assert.equal(result.error, undefined);
});

await check('恢复后报告权限阻塞可以正常结束，无须强制调工具', async () => {
  const answer = '测试需要写入工作区，当前只读权限下无法完成，需要用户授权。';
  const result = await runMockAgent({
    runId: 'finalization-blocker',
    task: '检查测试',
    workspaceRoot: WORKSPACE,
    script: [() => textResponse('接下来运行测试：'), () => textResponse(answer)],
  });
  assert.equal(result.error, undefined);
  assert.equal(result.answer, answer);
  assert.equal(result.fetchCalls, 2);
  assert.ok(!result.traces.some((event) => event.type === 'tool_call'));
});

await check('恢复提示是 user 消息（不污染 system 段，可被后续裁剪/摘要正常处理）', async () => {
  const requestBodies: unknown[] = [];
  await runMockAgent({
    runId: 'empty-turn-role',
    task: '角色检查',
    workspaceRoot: WORKSPACE,
    onRequest: (body) => requestBodies.push(body),
    script: [() => emptyResponse(), () => textResponse('ok')],
  });
  const second = requestBodies[1] as { messages?: Array<{ role: string }> };
  const roles = second?.messages?.map((message) => message.role) ?? [];
  assert.equal(roles.filter((role) => role === 'system').length, 1, 'system 消息只能有一条');
  assert.equal(roles[roles.length - 1], 'user', '恢复提示必须是最后一条 user 消息');
});

console.log(`\nempty-turn 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
