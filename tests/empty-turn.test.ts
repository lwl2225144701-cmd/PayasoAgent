// 套件: Empty Turn Invariant — 模型没有可见输出时绝不静默"完成"
// 用法: npx tsx tests/empty-turn.test.ts
// 回归目标（v1.8）：DB 中 4/81 个 completed run 的 result 是空字符串（模型只输出
// reasoning，content 为空且无 tool_call）。内核必须按 Harness 策略有界恢复，
// 用尽后 fail loudly，而不是把空回答当成最终答案。

import assert from 'node:assert/strict';
import { AgentEmptyAnswerError } from '../src/runtime/agent.js';
import {
  createTestWorkspaceRoot,
  emptyResponse,
  runMockAgent,
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
