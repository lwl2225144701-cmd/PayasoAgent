// 套件: Empty Turn Invariant — 模型没有可见输出时绝不静默"完成"
// 用法: npx tsx tests/empty-turn.test.ts
// 回归目标（v1.8）：DB 中 4/81 个 completed run 的 result 是空字符串（模型只输出
// reasoning，content 为空且无 tool_call）。内核必须按 Harness 策略有界恢复，
// 用尽后 fail loudly，而不是把空回答当成最终答案。

import assert from 'node:assert/strict';
import { DefaultContextHarness } from '../src/harness/context-harness.js';
import { loadCheckpoint } from '../src/persistence/file-checkpoint-store.js';
import { AgentEmptyAnswerError, AgentStalledError } from '../src/runtime/agent.js';
import { register } from '../src/tools/tools.js';
import {
  createTestWorkspaceRoot,
  emptyResponse,
  MOCK_MODEL_CONFIG,
  runMockAgent,
  textResponse,
  toolCallResponse,
} from './helpers/mock-runner.js';

const WORKSPACE = createTestWorkspaceRoot('payaso-empty-turn-');

// 仅验证 SDK 显式注入的兼容策略；默认 Harness 不再按文本措辞强制续跑。
class ExplicitRecoveryHarness extends DefaultContextHarness {
  override incompleteTurnPolicy(answer: string) {
    return answer.endsWith('：')
      ? {
          reason: 'explicit test policy',
          nudge: 'The explicit test policy requests recovery: did not call a tool.',
          maxRecoveries: 1,
        }
      : undefined;
  }
}
function explicitRecoveryHarness() {
  return new ExplicitRecoveryHarness({
    permissionMode: 'workspace-write',
    modelConfig: MOCK_MODEL_CONFIG,
  });
}

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

  // 模型必须看到"上一轮是空的"这条提示（v2.5 起提示非末尾，尾部还跟着 [Context]）
  const second = requestBodies[1] as { messages?: Array<{ role: string; content: string }> };
  assert.ok(
    second?.messages?.some((m) => m.role === 'user' && m.content.includes('no visible content')),
    '模型必须看到空回合提示',
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
  assert.ok(!result.traces.some((event) => event.type === 'final_answer'), '不得产生 final_answer');
});

await check('输出上限空回合 → 告知具体原因和用量，保留读取证据和工具选择', async () => {
  const bodies: Array<{
    messages: Array<{ role: string; content: string }>;
    tools: unknown[];
    max_tokens: number;
  }> = [];
  const result = await runMockAgent({
    runId: 'empty-turn-length-feedback',
    task: '检查后解释结果',
    workspaceRoot: WORKSPACE,
    onRequest: (body) => bodies.push(body as (typeof bodies)[number]),
    script: [
      () => toolCallResponse([{ id: 'read-evidence', name: 'empty-turn-probe', args: {} }]),
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: '', reasoning_content: 'do not replay this reasoning' },
                finish_reason: 'length',
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 32768 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      () => toolCallResponse([{ id: 'model-chosen-action', name: 'empty-turn-probe', args: {} }]),
      () => textResponse('已核对'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.answer, '已核对');
  const recoveryMessages = bodies[2].messages;
  const nudge =
    recoveryMessages.find((m) => m.role === 'user' && m.content.includes('no visible content'))
      ?.content ?? '';
  assert.match(nudge, /32768 output tokens/);
  assert.match(nudge, /output limit was reached/);
  assert.match(nudge, /Reuse established evidence/);
  assert.ok(recoveryMessages.some((m) => m.role === 'tool' && m.content.includes('probe-ok')));
  assert.ok(!JSON.stringify(recoveryMessages).includes('do not replay this reasoning'));
  assert.deepEqual(bodies[2].tools, bodies[1].tools, '恢复提示不能收起工具或规定下一工具');
  assert.equal(bodies[2].max_tokens, bodies[1].max_tokens, '恢复不调整模型配置');
  assert.ok(result.traces.some((e) => e.type === 'llm_call' && e.stopReason === 'length'));
});

await check('普通空回合不虚报输出上限', () => {
  const harness = new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelConfig: MOCK_MODEL_CONFIG,
  });
  const policy = harness.emptyTurnPolicy({ stopReason: 'stop', durationMs: 1250 });
  assert.match(policy.nudge, /1 seconds/);
  assert.ok(!policy.nudge.includes('output limit'));
  assert.ok(!policy.nudge.includes('output tokens'));
});

await check('实际 Loop 保留工具协议续传，checkpoint 可恢复且新任务不继承', async () => {
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  const result = await runMockAgent({
    runId: 'tool-reasoning-protocol-continuation',
    task: '核对结果',
    workspaceRoot: WORKSPACE,
    onRequest: (body) => requests.push(body as (typeof requests)[number]),
    script: [
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: '<think>inline-not-protocol</think>',
                  reasoning_content: 'provider-continuation',
                  tool_calls: [
                    {
                      id: 'protocol-probe',
                      type: 'function',
                      function: { name: 'empty-turn-probe', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      () => textResponse('已核对'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  const outgoing = requests[1].messages.find((m) => m.role === 'assistant');
  assert.equal(outgoing?.reasoning_content, 'provider-continuation');
  assert.equal(
    requests[1].messages.at(-1)?.role,
    'tool',
    'Harness 提示不能把工具续传变成新用户轮次',
  );
  assert.ok(!JSON.stringify(requests[1]).includes('inline-not-protocol'));
  const checkpoint = loadCheckpoint('tool-reasoning-protocol-continuation');
  assert.ok(checkpoint);
  const saved = checkpoint.messages.find((m) =>
    m.tool_calls?.some((t) => t.id === 'protocol-probe'),
  );
  assert.equal(saved?.reasoning_content, undefined, '展示用字段不进入 canonical 正文');
  assert.equal(saved?.providerContinuation?.text, 'provider-continuation');
  assert.ok(
    !checkpoint.messages
      .find((m) => m.tool_call_id === 'protocol-probe')
      ?.content.includes('[Context]'),
    '模型视图提示不改写 canonical 工具结果',
  );
  const harness = new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelConfig: MOCK_MODEL_CONFIG,
  });
  const next = harness.createTranscript('新任务', checkpoint.messages);
  assert.ok(
    next.every((m) => !m.providerContinuation),
    '新用户轮次不回传旧协议推理',
  );
});

await check('同 Run 在工具后中断，再从 checkpoint 恢复仍回传协议状态', async () => {
  const runId = 'tool-protocol-resume';
  const interrupted = await runMockAgent({
    runId,
    task: '检查',
    workspaceRoot: WORKSPACE,
    script: [
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: '',
                  reasoning_content: 'resume-protocol',
                  tool_calls: [
                    {
                      id: 'resume-probe',
                      type: 'function',
                      function: { name: 'empty-turn-probe', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      () => {
        throw new DOMException('cancelled', 'AbortError');
      },
    ],
  });
  assert.ok(interrupted.error, '模拟请求中断，保留工具完成后的 checkpoint');
  const checkpoint = loadCheckpoint(runId);
  assert.ok(checkpoint);
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  const resumed = await runMockAgent({
    runId,
    task: '检查',
    workspaceRoot: WORKSPACE,
    resume: checkpoint,
    onRequest: (body) => requests.push(body as (typeof requests)[number]),
    script: [() => textResponse('恢复完成')],
  });
  assert.equal(resumed.error, undefined, String(resumed.error));
  assert.equal(
    requests[0].messages.find((m) => m.role === 'assistant')?.reasoning_content,
    'resume-protocol',
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

await check('SDK 显式恢复策略仍可选择继续，不作为默认工作流', async () => {
  const requestBodies: unknown[] = [];
  const result = await runMockAgent({
    runId: 'finalization-guard-recover',
    contextHarness: explicitRecoveryHarness(),
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
  assert.ok(
    second?.messages?.some((m) => m.role === 'user' && m.content.includes('did not call a tool')),
    '模型必须看到 finalization guard 提示',
  );
});

await check('SDK 显式恢复策略耗尽仍保持有界', async () => {
  const result = await runMockAgent({
    runId: 'finalization-guard-exhausted',
    contextHarness: explicitRecoveryHarness(),
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

await check('默认 Harness 不因最终文本措辞强制续跑或判失败', async () => {
  const answer = '接下来运行 test:all：';
  const result = await runMockAgent({
    runId: 'finalization-disabled',
    task: '只返回给定文本',
    workspaceRoot: WORKSPACE,
    contextHarness: new DefaultContextHarness({
      permissionMode: 'read-only',
      modelConfig: MOCK_MODEL_CONFIG,
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
    contextHarness: explicitRecoveryHarness(),
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
