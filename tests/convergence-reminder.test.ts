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
import { resolveModelContextConfig } from '../src/harness/model-context.js';
import type { ChatMessage, ModelConfig } from '../src/llm/llm.js';
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
// 请求体原文（收尾额度 max_tokens 断言用）。
let requestBodies: string[] = [];
function script(
  messages: ChatMessage[],
  onRequest?: (index: number) => void,
  failFirstFetch = false,
  options: { delayMs?: number; alwaysFail?: boolean; slowAt?: number[] } = {},
) {
  requests = [];
  requestBodies = [];
  const delayMs = options.delayMs ?? 0;
  const slowAt = options.slowAt;
  // 轮次与 fetch 次数解耦：内部重试属于同一轮，必须重放同一条脚本消息。
  let turn = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = String(init?.body);
    requestBodies.push(body);
    requests.push(JSON.parse(body).messages);
    onRequest?.(requests.length);
    // slowAt（1 基请求序号）只拖慢指定请求；否则 delayMs 作用于全部请求。
    const wait = slowAt ? (slowAt.includes(requests.length) ? delayMs : 0) : delayMs;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    // 全部 5xx：chat() 内部重试耗尽后抛出——失败路径计量测试用。
    if (options.alwaysFail) {
      return new Response('boom', { status: 500 });
    }
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

function options(
  runId: string,
  contextHarness: DefaultContextHarness,
  modelConfig: ModelConfig = MODEL,
) {
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
    modelConfig,
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
// 仅配置累计活动时长上限：请求进行中的持续长输出约束专用。
const timeBudgetHarness = (maxActiveMs: number) =>
  new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelConfig: MODEL,
    executionBudget: { maxActiveMs, warnRatio: 0.7, convergeRatio: 0.9 },
  });
const goalReviewHarness = () =>
  new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelConfig: MODEL,
    // 3 个工具回合一审；时间阈值放到极大，隔离变量。
    goalReview: { everyTurns: 3, everyMs: 10_000_000 },
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

  // ---- 6c. 周期性目标审查：交替调用不同工具也触发（换参数绕不过）----
  {
    const run = options('goal-review', goalReviewHarness());
    script([
      read(),
      toolMessage(call({ mode: 'other' })),
      read(),
      toolMessage(call({ mode: 'other' })),
      done,
    ]);
    assert.equal(await runAgent('交替调用不同工具的调查', undefined, run), 'done');
    // 第 3 个已完成工具回合触发 → 注入第 4 轮请求的 [Context]
    assert.match(contextText(requests[3]), /\[Periodic goal review\]/);
    assert.match(contextText(requests[3]), /Original user goal: 交替调用不同工具的调查/);
    const reviews = run.events.filter((e) => e.type === 'goal_review_reminder');
    assert.equal(reviews.length, 1, '每周期只触发一次');
    assert.equal(reviews[0].toolTurns, 3);
    // 只提醒不阻断：正常调研走到终态答案
    assert.equal(run.events.filter((e) => e.type === 'tool_execution_skipped').length, 0);
  }

  // ---- 6d. 目标审查可关闭 ----
  {
    const disabled = new DefaultContextHarness({
      permissionMode: 'workspace-write',
      modelConfig: MODEL,
      goalReview: false,
    });
    const run = options('goal-review-off', disabled);
    script([read(), read(), read(), read(), done]);
    assert.equal(await runAgent('关闭审查的调查', undefined, run), 'done');
    assert.equal(run.events.filter((e) => e.type === 'goal_review_reminder').length, 0);
  }

  // ---- 6e. 预算强制收尾：模型无视收尾指令继续调工具 → 准入拦下并优雅停止 ----
  {
    const run = options('budget-enforce', budgetHarness());
    script([read(), read(), read(), read(), read(), read(), done]);
    const err = await runAgent('忽略收尾继续调用', undefined, run).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof AgentStopRequestedError, '耗尽且收尾被无视 → 优雅停止');
    assert.equal(err.stop?.code, 'budget_exhausted');
    assert.ok(err.stop?.notice && err.stop.notice.length > 0, 'Host 可落库的确定停止说明');
    const skipped = run.events.filter((e) => e.type === 'tool_execution_skipped');
    assert.equal(skipped.length, 2, '两轮工具调用被预算准入拦下');
    // 工具未执行：耗尽当轮的工具即被拦下，tool_call 事件只有前 3 次
    assert.equal(run.events.filter((e) => e.type === 'tool_call').length, 3);
    // 收尾指令注入过（第 5 轮请求可见）
    assert.ok(
      requests[4]?.some((m) => String(m.content).includes('[Execution budget exhausted]')),
      '耗尽后注入一次性收尾指令',
    );
  }

  // ---- 6f. 预算耗尽但模型配合收尾 → 正常完成（预留收尾生成生效）----
  {
    const run = options('budget-wrapup-ok', budgetHarness());
    script([read(), read(), read(), read(), done]);
    assert.equal(await runAgent('配合收尾', undefined, run), 'done');
    assert.ok(
      requests[4]?.some((m) => String(m.content).includes('[Execution budget exhausted]')),
      '耗尽后仍允许一次收尾生成',
    );
    // 耗尽当轮（第 4 次响应）已发起的工具调用同样被拦下；模型第 5 轮配合收尾
    assert.equal(run.events.filter((e) => e.type === 'tool_execution_skipped').length, 1);
    const decisions = run.events.filter((e) => e.type === 'budget_decision');
    assert.deepEqual(
      decisions.map((e) => e.level),
      ['warn', 'exhausted'],
    );
  }

  // ---- 6g. resume 后预算不清零（累计值从 checkpoint 延续）----
  {
    const stopHarness = budgetHarness();
    const stopping = options('budget-resume', stopHarness);
    Object.assign(stopHarness, {
      shouldStopAfterTurn: ({ iteration }: { iteration: number }) => iteration === 3,
    });
    script([read(), read(), read()]);
    await assert.rejects(
      runAgent('跑到预算边缘后停止', undefined, stopping),
      AgentStopRequestedError,
    );
    assert.equal(stopping.snapshots.at(-1)?.harnessState?.executionBudget?.usage?.modelCalls, 3);

    const resumed = options('budget-resume', budgetHarness());
    script([read(), done]);
    assert.equal(await runAgent('恢复后继续', stopping.snapshots.at(-1), resumed), 'done');
    // resume 后第 1 次响应即 4/4 耗尽：累计值延续，没有清零
    const decisions = resumed.events.filter((e) => e.type === 'budget_decision');
    assert.deepEqual(
      decisions.map((e) => e.level),
      ['exhausted'],
    );
    assert.equal(resumed.snapshots.at(-1)?.harnessState?.executionBudget?.usage?.modelCalls, 5);
  }

  // ---- 6h. 压缩摘要的模型调用也计入预算（Harness 自持请求统一计量）----
  {
    let summarizeCalls = 0;
    const harness = new DefaultContextHarness({
      permissionMode: 'workspace-write',
      modelConfig: MODEL,
      modelContext: resolveModelContextConfig({
        model: 'compact-test',
        contextWindowTokens: 600,
        maxOutputTokens: 200,
        safetyTokens: 100,
      }),
      executionBudget: { maxModelCalls: 3, warnRatio: 0.7, convergeRatio: 0.9 },
      summarizer: {
        summarize: async () => {
          summarizeCalls++;
          // 3 次模型调用：3/3 直接跨到 exhausted，决策必须回传
          return { summary: 's', outputTokens: 7, modelCalls: 3 };
        },
      },
    });
    // 构造一个必然触发压缩的 transcript：system + 大量历史轮。
    const transcript: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'y'.repeat(400) },
      { role: 'user', content: 'z'.repeat(400) },
    ];
    const padView = {
      task: 't',
      completedSteps: [],
      failedSteps: [],
      invalidSteps: [],
      nextStep: null,
      lastResult: '',
    };
    const prepared = await harness.prepareTurn(transcript, padView, []);
    assert.ok(summarizeCalls > 0, '确实走了压缩摘要');
    assert.ok(prepared.compaction, '压缩发生');
    // 摘要的 3 次模型调用计入预算：3/3 → exhausted 决策随 prepareTurn 回传
    assert.ok(
      prepared.budgetDecisions && prepared.budgetDecisions.length > 0,
      '预算决策回传 Runtime',
    );
    assert.equal(prepared.budgetDecisions?.[0]?.level, 'exhausted');
    assert.equal(prepared.budgetDecisions?.[0]?.state.usage.modelCalls, 3);
    assert.equal(harness.executionBudgetLevel(), 'exhausted');
  }

  // ---- 6i. 请求进行中的持续长输出：累计时间越限即在途中止（不等响应结束）----
  {
    const run = options('budget-midrequest', timeBudgetHarness(1_200));
    // 每个响应延迟 2.5s：第 1 个请求在 ~1.25s 处被看门狗中止
    script([read(), read(), done], undefined, false, { delayMs: 2_500 });
    const err = await runAgent('持续长输出的请求', undefined, run).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof AgentStopRequestedError, '请求进行中预算耗尽 → 优雅停止（非 failed）');
    assert.equal(err.stop?.code, 'budget_exhausted');
    assert.ok(err.stop?.notice?.includes('进行中'), '停止说明指明请求进行中耗尽');
    // 在途活动时长已入账（失败/中止路径不漏账）
    const usage = run.snapshots.at(-1)?.harnessState?.executionBudget?.usage;
    assert.ok((usage?.activeMs ?? 0) >= 1_200, '中止路径把在途时间计入预算');
    // 语义三分：不是执行失败（无 error 事件），也不是用户取消
    assert.equal(run.events.filter((e) => e.type === 'error').length, 0);
  }

  // ---- 6j. 预留收尾独立额度：收尾请求的输出上限被裁剪 ----
  {
    const run = options(
      'budget-wrapup-tokens',
      new DefaultContextHarness({
        permissionMode: 'workspace-write',
        modelConfig: { ...MODEL, maxOutputTokens: 4_096 },
        executionBudget: {
          maxModelCalls: 3,
          warnRatio: 0.7,
          convergeRatio: 0.9,
          wrapUpMaxOutputTokens: 64,
        },
      }),
      // runAgent 的 modelConfig 才是请求 max_tokens 的来源（harness 的那份只用于
      // 上下文预算）——收尾裁剪改的是前者。
      { ...MODEL, maxOutputTokens: 4_096 },
    );
    script([read(), read(), read(), done]);
    assert.equal(await runAgent('耗尽后收尾', undefined, run), 'done');
    const maxTokens = requestBodies.map((body) => {
      try {
        return (JSON.parse(body) as { max_tokens?: number }).max_tokens;
      } catch {
        return undefined;
      }
    });
    assert.equal(maxTokens[3], 64, '收尾请求使用独立小额输出额度（不是普通请求的 4096）');
    assert.equal(maxTokens[0], 4_096, '普通请求仍用完整上限');
  }

  // ---- 6k. 预留收尾独立时限：收尾请求本身也受小额时间预算约束 ----
  {
    const run = options(
      'budget-wrapup-time',
      new DefaultContextHarness({
        permissionMode: 'workspace-write',
        modelConfig: MODEL,
        executionBudget: {
          maxModelCalls: 3,
          warnRatio: 0.7,
          convergeRatio: 0.9,
          wrapUpMaxActiveMs: 800,
        },
      }),
    );
    // 只拖慢第 4 个请求（收尾请求）：2.5s > wrapUpMaxActiveMs 800ms → 收尾时限中止
    script([read(), read(), read(), done], undefined, false, { slowAt: [4], delayMs: 2_500 });
    const err = await runAgent('收尾也超时', undefined, run).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof AgentStopRequestedError, '收尾请求超独立时限 → 优雅停止');
    assert.equal(err.stop?.code, 'budget_exhausted');
    assert.equal(run.events.filter((e) => e.type === 'error').length, 0);
  }

  // ---- 6l. 主请求失败也入账：attempts（含内部重试）不丢 ----
  {
    const run = options('budget-fail-meter', budgetHarness());
    // 全部 5xx：chat() 内部重试 2 次后抛出
    script([read(), done], undefined, false, { alwaysFail: true });
    const err = await runAgent('全部请求失败', undefined, run).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(
      err instanceof Error && !(err instanceof AgentStopRequestedError),
      '执行失败（非优雅停止）',
    );
    const sent = run.events.filter((e) => e.type === 'llm_request_sent').length;
    const metered = run.snapshots.at(-1)?.harnessState?.executionBudget?.usage?.modelCalls;
    assert.ok(sent >= 1, '确实发出了请求');
    assert.equal(metered, sent, '失败路径的模型调用 attempts 全部入账');
  }

  // ---- 6m. 摘要请求失败也入账：压缩失败不跳过计量 ----
  {
    const harness = new DefaultContextHarness({
      permissionMode: 'workspace-write',
      modelConfig: MODEL,
      modelContext: resolveModelContextConfig({
        model: 'compact-fail',
        contextWindowTokens: 600,
        maxOutputTokens: 200,
        safetyTokens: 100,
      }),
      executionBudget: { maxModelCalls: 1, warnRatio: 0.7, convergeRatio: 0.9 },
      summarizer: {
        summarize: async (request) => {
          // 请求已发生（随后失败）：attempt 必须可被调用方入账
          request.onModelCall?.();
          throw new Error('summary upstream 500');
        },
      },
    });
    const transcript: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'y'.repeat(400) },
      { role: 'user', content: 'z'.repeat(400) },
    ];
    const padView = {
      task: 't',
      completedSteps: [],
      failedSteps: [],
      invalidSteps: [],
      nextStep: null,
      lastResult: '',
    };
    const prepared = await harness.prepareTurn(transcript, padView, []);
    assert.equal(prepared.compaction, undefined, '摘要失败不改写压缩状态');
    // 失败的尝试计入预算：1/1 → exhausted 决策随 prepareTurn 回传
    assert.ok(
      prepared.budgetDecisions && prepared.budgetDecisions.length > 0,
      '失败的摘要尝试入账并回传 Runtime',
    );
    assert.equal(prepared.budgetDecisions?.[0]?.level, 'exhausted');
    assert.equal(harness.executionBudgetLevel(), 'exhausted');
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
