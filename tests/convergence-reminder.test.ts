// 执行不收敛治理（v2.6）Loop 级集成验证：重复调用提醒与执行预算提醒
// 端到端到达模型视图、事件只发一次、checkpoint 可恢复。
//
// 为什么必须有 Loop 级测试：两个策略模块各自的纯函数测试覆盖不了**接线时序**。
// v2.6 首版曾把 observeExecution 放在 acknowledgeConvergenceReminders 之后——
// 预算提醒入队后立刻被清空，事件照发但模型永远收不到（agent.ts 顺序事故）。
// 本套件用脚本化 fetch 驱动真实 runAgent，把「提醒必须出现在下一轮请求的
// [Context] 里」变成机器契约，此类回归从此被守住。
//
// 模型由 fetch mock 驱动，不消耗 LLM；时长/阈值由 Harness 选项精确给定。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentExecutionContext } from '../src/bootstrap/runtime-bootstrap.js';
import { DefaultContextHarness } from '../src/harness/context-harness.js';
import type { ChatMessage } from '../src/llm/llm.js';
import { AgentStopRequestedError, runAgent } from '../src/runtime/agent.js';
import type { CheckpointSnapshot } from '../src/runtime/checkpoint-port.js';
import { silentRuntimeObserver } from '../src/runtime/observer-port.js';
import type { TraceEvent } from '../src/runtime/trace.js';
import { register } from '../src/tools/tools.js';

const MODEL = { baseUrl: 'https://provider.example/v1', apiKey: 'test-key', model: 'test-model' };
/** v2.5 起动态上下文（含收敛提醒）位于尾部 [Context] 消息。 */
function contextText(messages: Array<{ role: string; content: unknown }>): string {
  return String(
    messages.find((message) => String(message.content).startsWith('[Context]'))?.content ?? '',
  );
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-convergence-'));
process.env.SANDBOX_ROOT = ROOT;
const probe = 'convergence-probe';
register({
  name: probe,
  description: 'convergence probe',
  effect: 'idempotent',
  resolveEffect: (args) => (args.mode === 'write' ? 'idempotent' : 'read'),
  parameters: { type: 'object', required: ['mode'], properties: { mode: { type: 'string' } } },
  execute: async (args) => {
    if (args.mode === 'fail') throw new Error('probe failed');
    return 'ok';
  },
});
// 瞬时失败探针：ETIMEDOUT → 分类 transient → Runtime 内部自动重试（MAX_RETRY=2）。
register({
  name: 'convergence-flaky',
  description: 'always fails with a transient error',
  effect: 'idempotent',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    throw Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' });
  },
});
// 挂起探针：只有 deadline 信号能结束它，用于触发 TOOL_TIMEOUT 出口。
register({
  name: 'convergence-hang',
  description: 'hangs until the deadline aborts',
  effect: 'idempotent',
  parameters: { type: 'object', properties: {} },
  execute: (_args, ctx) =>
    new Promise((_resolve, reject) => {
      ctx.signal?.addEventListener('abort', () =>
        reject(ctx.signal?.reason ?? new Error('aborted')),
      );
    }),
});

let id = 0;
function callTool(name: string, args: Record<string, unknown> = {}) {
  return {
    id: `convergence-${++id}`,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}
function call(args: Record<string, unknown> = { mode: 'read' }) {
  return callTool(probe, args);
}
function toolMessage(...calls: ReturnType<typeof call>[]): ChatMessage {
  return { role: 'assistant', content: '', tool_calls: calls };
}
const read = () => toolMessage(call());
const done: ChatMessage = { role: 'assistant', content: 'done' };

const originalFetch = globalThis.fetch;
let requests: Array<Array<{ role: string; content: string }>> = [];
function script(
  messages: ChatMessage[],
  onRequest?: (index: number) => void,
  failFirstFetch = false,
) {
  requests = [];
  // 轮次与 fetch 次数解耦：内部重试属于同一轮，必须重放同一条脚本消息。
  let turn = 0;
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)).messages);
    onRequest?.(requests.length);
    // 瞬时 5xx：chat() 内部按 shouldRetry 自动重试，用于验证预算「含每次重试」。
    if (failFirstFetch && requests.length === 1) {
      return new Response('boom', { status: 500 });
    }
    const message = messages[turn];
    turn += 1;
    assert.ok(message, '出现意外的额外模型调用');
    const delta = {
      ...message,
      tool_calls: message.tool_calls?.map((tool, index) => ({ ...tool, index })),
    };
    const chunks = [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      {
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop',
          },
        ],
      },
    ];
    return new Response(
      `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }) as typeof fetch;
}

const hasRepeat = (messages: (typeof requests)[number]) =>
  contextText(messages).includes('[Repeated call review]');
const hasBudgetWarning = (messages: (typeof requests)[number]) =>
  contextText(messages).includes('[Execution budget warning]');
const hasBudgetConverge = (messages: (typeof requests)[number]) =>
  contextText(messages).includes('[Execution budget nearly exhausted]');

function options(runId: string, contextHarness: DefaultContextHarness) {
  const root = path.join(ROOT, runId);
  fs.mkdirSync(root, { recursive: true });
  const snapshots: CheckpointSnapshot[] = [];
  const events: TraceEvent[] = [];
  return {
    snapshots,
    events,
    executionContext: createAgentExecutionContext({ runId, workspaceRoot: root }),
    checkpointWriter: {
      save(snapshot: CheckpointSnapshot) {
        snapshots.push(structuredClone(snapshot));
        return 'memory';
      },
    },
    observer: silentRuntimeObserver,
    onTrace: (event: TraceEvent) => events.push(event),
    modelConfig: MODEL,
    contextHarness,
  };
}

const repeatHarness = () =>
  new DefaultContextHarness({ permissionMode: 'workspace-write', modelConfig: MODEL });
const budgetHarness = () =>
  new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelConfig: MODEL,
    // maxModelCalls=4：第 3 次响应跨 70% 预警线，第 4 次到 100% 耗尽。
    executionBudget: { maxModelCalls: 4, warnRatio: 0.7, convergeRatio: 0.9 },
  });

try {
  // ---- 1. 重复调用：同身份第 3 次触发提醒，出现在下一轮模型视图 ----
  {
    const run = options('repeat-warn', repeatHarness());
    script([read(), read(), read(), done]);
    assert.equal(await runAgent('反复读同一文件', undefined, run), 'done');
    assert.deepEqual(
      requests.map(hasRepeat),
      [false, false, false, true],
      '提醒在触发后的下一轮注入模型视图',
    );
    const reminders = run.events.filter((e) => e.type === 'repeat_call_reminder');
    assert.equal(reminders.length, 1, '每次跨阈只发一次事件');
    assert.equal(reminders[0].count, 3);
    assert.equal(reminders[0].level, 1);
    assert.match(reminders[0].preview, /mode=read/, '事件带脱敏预览，审计可重建');
    assert.equal(
      run.snapshots.at(-1)?.harnessState?.repeatCall?.count,
      3,
      '计数随 checkpoint 持久化',
    );
  }

  // ---- 2. 分级：3/5/8 各提醒一次，共三次，不重复打扰 ----
  {
    const run = options('repeat-escalate', repeatHarness());
    script([read(), read(), read(), read(), read(), read(), read(), read(), done]);
    assert.equal(await runAgent('轮询等待外部条件', undefined, run), 'done');
    assert.deepEqual(
      requests.map(hasRepeat),
      [false, false, false, true, false, true, false, false, true],
      '第 3/5/8 次触发后各注入一轮',
    );
    const reminders = run.events.filter((e) => e.type === 'repeat_call_reminder');
    assert.deepEqual(
      reminders.map((e) => e.level),
      [1, 2, 3],
    );
    assert.equal(run.snapshots.at(-1)?.harnessState?.repeatCall?.level, 3);
  }

  // ---- 3. 换参数重置连续性：合法轮询不被累计打扰 ----
  {
    const run = options('repeat-reset', repeatHarness());
    script([
      read(),
      toolMessage(call({ mode: 'other' })),
      read(),
      toolMessage(call({ mode: 'other' })),
      read(),
      toolMessage(call({ mode: 'other' })),
      done,
    ]);
    assert.equal(await runAgent('交替两种调用', undefined, run), 'done');
    assert.ok(
      requests.every((m) => !hasRepeat(m)),
      '从未连续三次相同 → 不提醒',
    );
    assert.equal(run.events.filter((e) => e.type === 'repeat_call_reminder').length, 0);
  }

  // ---- 4. 失败与被禁处置也计入（模型不能靠换时间重试绕过观察）----
  {
    const run = options('repeat-failed', repeatHarness());
    script([
      toolMessage(call({ mode: 'fail' })),
      toolMessage(call({ mode: 'fail' })),
      toolMessage(call({ mode: 'fail' })),
      done,
    ]);
    assert.equal(await runAgent('同一个失败命令反复执行', undefined, run), 'done');
    assert.equal(hasRepeat(requests[3]), true, '失败/被禁路径同样进入重复计数');
    assert.equal(run.events.filter((e) => e.type === 'repeat_call_reminder').length, 1);
  }

  // ---- 4b. 内部重试不放大重复计数：一次调用 3 次尝试，count 仍为 1 ----
  {
    const run = options('repeat-attempts', repeatHarness());
    script([toolMessage(callTool('convergence-flaky', {})), done]);
    assert.equal(await runAgent('瞬时失败自动重试', undefined, run), 'done');
    const state = run.snapshots.at(-1)?.harnessState?.repeatCall;
    assert.equal(state?.count, 1, '一次 tool_call 只计一次重复');
    assert.equal(state?.lastAttempts, 3, '内部重试的尝试次数单独记录（1 + MAX_RETRY）');
    assert.equal(state?.lastDisposition, 'failed');
    assert.equal(run.events.filter((e) => e.type === 'repeat_call_reminder').length, 0, '不提醒');
  }

  // ---- 4c. 超时出口：连续三次超时调用正确触发提醒（漏计回归）----
  {
    const previousTimeout = process.env.PAYASO_TOOL_TIMEOUT_MS;
    process.env.PAYASO_TOOL_TIMEOUT_MS = '1000'; // 下限 1s，三次约 3s
    try {
      const run = options('repeat-timeout', repeatHarness());
      script([
        toolMessage(callTool('convergence-hang', {})),
        toolMessage(callTool('convergence-hang', {})),
        toolMessage(callTool('convergence-hang', {})),
        done,
      ]);
      assert.equal(await runAgent('连续超时的调用', undefined, run), 'done');
      assert.equal(hasRepeat(requests[3]), true, '超时出口必须进入重复计数');
      const reminders = run.events.filter((e) => e.type === 'repeat_call_reminder');
      assert.equal(reminders.length, 1);
      assert.equal(reminders[0].count, 3);
      assert.equal(reminders[0].attempts, 1, '超时不重试，每次调用一次尝试');
      const state = run.snapshots.at(-1)?.harnessState?.repeatCall;
      assert.equal(state?.count, 3);
      assert.equal(state?.lastDisposition, 'failed');
    } finally {
      if (previousTimeout === undefined) delete process.env.PAYASO_TOOL_TIMEOUT_MS;
      else process.env.PAYASO_TOOL_TIMEOUT_MS = previousTimeout;
    }
  }

  // ---- 5. 恢复：checkpoint 保留计数，resume 后连续累计 ----
  {
    const stopHarness = repeatHarness();
    const stopping = options('repeat-resume', stopHarness);
    Object.assign(stopHarness, {
      shouldStopAfterTurn: ({ iteration }: { iteration: number }) => iteration === 2,
    });
    script([read(), read()]);
    await assert.rejects(runAgent('读两次后停止', undefined, stopping), AgentStopRequestedError);
    const checkpoint = stopping.snapshots.at(-1);
    assert.ok(checkpoint);
    assert.equal(checkpoint.harnessState?.repeatCall?.count, 2, '停机前计数已持久化');

    const resumed = options('repeat-resume', repeatHarness());
    script([read(), done]);
    assert.equal(await runAgent('继续读', checkpoint, resumed), 'done');
    assert.deepEqual(
      requests.map(hasRepeat),
      [false, true],
      'resume 后第 3 次相同调用触发提醒并注入下一轮',
    );
    assert.equal(resumed.snapshots.at(-1)?.harnessState?.repeatCall?.count, 3);
  }

  // ---- 6. 预算：跨阈后提醒必须到达模型视图（v2.6 接线时序回归）----
  {
    const run = options('budget-warn', budgetHarness());
    script([read(), read(), read(), read(), done]);
    assert.equal(await runAgent('有预算上限的运行', undefined, run), 'done');
    const decisions = run.events.filter((e) => e.type === 'budget_decision');
    assert.deepEqual(
      decisions.map((e) => e.level),
      ['warn', 'exhausted'],
      '70% 预警一次、100% 耗尽一次',
    );
    assert.equal(hasBudgetWarning(requests[3]), true, '预警文本注入跨阈后的下一轮（时序回归点）');
    assert.equal(hasBudgetWarning(requests[4]), false, '模型成功响应后消费，不重复注入');
    assert.ok(!hasBudgetConverge(requests[3]), 'warn 档不冒充 converge 文案');
    const last = run.snapshots.at(-1)?.harnessState?.executionBudget;
    assert.equal(last?.usage?.modelCalls, 5, '累计用量持久化（4 次工具轮 + 1 次终态回答）');
    assert.ok(last?.exhausted?.includes('modelCalls'), '耗尽档位持久化，resume 不重跑');
  }

  // ---- 6b. 预算按真实 Provider 请求计：内部重试也计数 ----
  {
    const run = options('budget-retry', budgetHarness());
    // 首个请求 500 → chat() 内部重试；3 个模型轮共发出 4 次 HTTP 请求。
    script([read(), read(), done], undefined, true);
    assert.equal(await runAgent('带重试的运行', undefined, run), 'done');
    assert.equal(
      run.events.filter((e) => e.type === 'llm_request_sent').length,
      4,
      '每次真实 HTTP 请求（含重试）都有打点',
    );
    const decisions = run.events.filter((e) => e.type === 'budget_decision');
    assert.deepEqual(
      decisions.map((e) => e.level),
      ['warn', 'exhausted'],
      '3 轮 4 次请求：第 3 次跨 70%、第 4 次耗尽',
    );
    assert.equal(hasBudgetWarning(requests[3]), true, '重试轮的累计同样驱动预警投递');
    assert.equal(run.snapshots.at(-1)?.harnessState?.executionBudget?.usage?.modelCalls, 4);
  }

  // ---- 7. 预算默认关闭：不配置上限时行为与引入前一致 ----
  {
    const run = options('budget-off', repeatHarness());
    script([read(), read(), read(), done]);
    assert.equal(await runAgent('无预算配置', undefined, run), 'done');
    assert.equal(run.events.filter((e) => e.type === 'budget_decision').length, 0);
    assert.ok(requests.every((m) => !hasBudgetWarning(m)));
    assert.equal(run.snapshots.at(-1)?.harnessState?.executionBudget, undefined);
  }

  // ---- 8. 显式关闭开关 ----
  {
    const disabled = new DefaultContextHarness({
      permissionMode: 'workspace-write',
      modelConfig: MODEL,
      repeatCall: false,
      executionBudget: false,
    });
    const run = options('repeat-off', disabled);
    script([read(), read(), read(), read(), done]);
    assert.equal(await runAgent('关闭后的运行', undefined, run), 'done');
    assert.equal(run.events.filter((e) => e.type === 'repeat_call_reminder').length, 0);
    assert.equal(run.events.filter((e) => e.type === 'budget_decision').length, 0);
  }
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(ROOT, { recursive: true, force: true });
}
console.log('Convergence reminder tests: PASS');
