// 进展提醒：默认阈值、混合工具分类、只投影一次、取消/恢复和新 Run 隔离。
// 模型由 fetch mock 驱动，时长由纯策略输入，测试不等待两分钟也不消耗 LLM。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentExecutionContext } from '../src/bootstrap/runtime-bootstrap.js';
import { DefaultContextHarness } from '../src/harness/context-harness.js';
import {
  advanceProgressReminder,
  DEFAULT_PROGRESS_REMINDER_POLICY,
  normalizeProgressReminderState,
  type ProgressReminderState,
} from '../src/harness/progress-reminder.js';
import type { ChatMessage } from '../src/llm/llm.js';
import { AgentStopRequestedError, runAgent } from '../src/runtime/agent.js';
import type { CheckpointSnapshot } from '../src/runtime/checkpoint-port.js';
import { silentRuntimeObserver } from '../src/runtime/observer-port.js';
import type { TraceEvent } from '../src/runtime/trace.js';
import { register } from '../src/tools/tools.js';
import '../src/tools/plan-tools.js';

const empty = () => normalizeProgressReminderState(undefined);
const step = (
  state: ProgressReminderState,
  durationMs: number,
  activity: 'read' | 'neutral' | 'other' = 'read',
) => advanceProgressReminder(state, { activity, durationMs }, DEFAULT_PROGRESS_REMINDER_POLICY);

let state = empty();
for (let i = 0; i < 7; i++) state = step(state, 30_000);
assert.equal(state.reminder, 'none', '时间再长也不能代替回合阈值');
state = step(state, 0);
assert.equal(state.reminder, 'pending');
state = empty();
for (let i = 0; i < 8; i++) state = step(state, 1_000);
assert.equal(state.reminder, 'none', '快速读取不触发');
assert.deepEqual(step(state, 1_000_000, 'neutral'), state, '纯计划回合不累计调查时间');
assert.deepEqual(step(state, 1_000_000, 'other'), empty(), '修改或失败打断调查连续性');
state = step(state, 112_000);
assert.equal(state.reminder, 'pending');
const delivered: ProgressReminderState = { ...state, reminder: 'delivered' };
assert.deepEqual(step(delivered, 300_000), delivered, '每 Run 一次');
assert.deepEqual(
  normalizeProgressReminderState({ readOnlyTurns: -1, readOnlyMs: Infinity, reminder: 'bad' }),
  empty(),
);
assert.deepEqual(normalizeProgressReminderState(null), empty());

const MODEL = { baseUrl: 'https://provider.example/v1', apiKey: 'test-key', model: 'test-model' };
const harness = (permissionMode: 'read-only' | 'workspace-write' = 'workspace-write') =>
  new DefaultContextHarness({
    permissionMode,
    modelConfig: MODEL,
    progressReminder: { minReadOnlyTurns: 2, minReadOnlyMs: 0 },
  });
const pad = {
  task: 'inspect',
  completedSteps: [],
  failedSteps: [],
  invalidSteps: [],
  nextStep: null,
  lastResult: '',
};
const viewHarness = harness('read-only');
viewHarness.observeToolTurn({ activity: 'read', durationMs: 1 });
viewHarness.observeToolTurn({ activity: 'read', durationMs: 1 });
const transcript = viewHarness.createTranscript('只调查，不修改');
const original = structuredClone(transcript);
const view = await viewHarness.prepareTurn(transcript, pad, []);
assert.match(view.messages[0].content, /\[Progress review\]/);
assert.match(view.messages[0].content, /no edits are required/);
assert.deepEqual(transcript, original, '提醒不污染 canonical transcript');
const pending = viewHarness.snapshotState();
viewHarness.restoreState(pending);
assert.match(
  (await viewHarness.prepareTurn(transcript, pad, [])).messages[0].content,
  /\[Progress review\]/,
);
assert.equal(viewHarness.acknowledgeProgressReminder(), true);
assert.equal(viewHarness.acknowledgeProgressReminder(), false);
const withoutReminder = await viewHarness.prepareTurn(transcript, pad, []);
assert.doesNotMatch(withoutReminder.messages[0].content, /\[Progress review\]/);
assert.ok(
  view.usage.estimatedInputTokens > withoutReminder.usage.estimatedInputTokens,
  '提醒进入真实预算估算',
);
const disabled = new DefaultContextHarness({
  permissionMode: 'read-only',
  modelConfig: MODEL,
  progressReminder: false,
});
disabled.restoreState(pending);
assert.equal(disabled.observeToolTurn({ activity: 'read', durationMs: 999_999 }), undefined);
assert.doesNotMatch(
  (await disabled.prepareTurn(transcript, pad, [])).messages[0].content,
  /\[Progress review\]/,
);
const previousSwitch = process.env.PAYASO_PROGRESS_REMINDER;
try {
  process.env.PAYASO_PROGRESS_REMINDER = 'off';
  const disabledByEnvironment = harness();
  disabledByEnvironment.restoreState(pending);
  assert.equal(disabledByEnvironment.acknowledgeProgressReminder(), false);
  assert.doesNotMatch(
    (await disabledByEnvironment.prepareTurn(transcript, pad, [])).messages[0].content,
    /\[Progress review\]/,
  );
} finally {
  if (previousSwitch === undefined) delete process.env.PAYASO_PROGRESS_REMINDER;
  else process.env.PAYASO_PROGRESS_REMINDER = previousSwitch;
}
const partial = harness();
partial.observeToolTurn({ activity: 'read', durationMs: 15_000 });
const restoredPartial = harness();
restoredPartial.restoreState(partial.snapshotState());
assert.deepEqual(restoredPartial.observeToolTurn({ activity: 'read', durationMs: 10_000 }), {
  readOnlyTurns: 2,
  readOnlyMs: 25_000,
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-progress-'));
process.env.SANDBOX_ROOT = ROOT;
const probe = 'progress-probe';
let writes = 0;
register({
  name: probe,
  description: 'progress probe',
  effect: 'idempotent',
  resolveEffect: (args) => (args.mode === 'write' ? 'idempotent' : 'read'),
  parameters: { type: 'object', required: ['mode'], properties: { mode: { type: 'string' } } },
  execute: async (args) => {
    if (args.mode === 'fail') throw new Error('probe read failed');
    if (args.mode !== 'read') writes++;
    return 'ok';
  },
});
let id = 0;
function call(name = probe, args: Record<string, unknown> = { mode: 'read' }) {
  return {
    id: `progress-${++id}`,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}
function toolMessage(...calls: ReturnType<typeof call>[]): ChatMessage {
  return { role: 'assistant', content: '', tool_calls: calls };
}
const read = () => toolMessage(call());
const done: ChatMessage = { role: 'assistant', content: 'done' };
const originalFetch = globalThis.fetch;
let requests: Array<{ role: string; content: string }[]> = [];
function script(messages: ChatMessage[], onRequest?: (index: number) => void) {
  requests = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)).messages);
    onRequest?.(requests.length);
    const message = messages[requests.length - 1];
    assert.ok(message, '出现意外的额外模型调用');
    // 与真实流式响应一致，每个并行工具使用独立 index。
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
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    );
  }) as typeof fetch;
}
const hasReminder = (messages: (typeof requests)[number]) =>
  messages.some((m) => m.role === 'system' && m.content.includes('[Progress review]'));
function options(runId: string, contextHarness = harness()) {
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

try {
  // 每批工具算一个模型回合；计划中性，混合 read + plan 仍算调查。
  const run = options('read-only', harness('read-only'));
  script([
    toolMessage(call(), call()),
    toolMessage(call('updatePlan', { items: [] }), call()),
    read(),
    read(),
    done,
  ]);
  assert.equal(await runAgent('只读调查并给出结论', undefined, run), 'done');
  assert.deepEqual(requests.map(hasReminder), [false, false, true, false, false]);
  assert.equal(run.events.filter((e) => e.type === 'progress_reminder').length, 1);
  assert.equal(run.snapshots.at(-1)?.harnessState?.progressReminder?.reminder, 'delivered');
  assert.equal(writes, 0);

  // 动态副作用分类生效；混合写入以及未知/无效调用都打断只读连续性。
  const mixed = options('mixed');
  script([
    read(),
    toolMessage(call(), call(probe, { mode: 'write' })),
    read(),
    toolMessage(call('missing-progress-tool')),
    read(),
    done,
  ]);
  assert.equal(await runAgent('change then inspect', undefined, mixed), 'done');
  assert.equal(mixed.events.filter((e) => e.type === 'progress_reminder').length, 0);
  assert.ok(requests.every((m) => !hasReminder(m)));
  assert.equal(writes, 1);

  const failed = options('failed-read');
  script([
    read(),
    toolMessage(call(probe, { mode: 'fail' })),
    read(),
    toolMessage(call(probe, {})),
    read(),
    done,
  ]);
  assert.equal(await runAgent('inspect after errors', undefined, failed), 'done');
  assert.ok(
    requests.every((m) => !hasReminder(m)),
    '失败的只读和无效参数不累计调查回合',
  );

  // 新 Run 继承会话摘要时重置已投递标记，不能永远丧失提醒额度。
  const next = options('new-run');
  script([read(), read(), done]);
  await runAgent('follow-up', undefined, {
    ...next,
    previousHarnessState: run.snapshots.at(-1)?.harnessState,
  });
  assert.deepEqual(requests.map(hasReminder), [false, false, true]);

  // pending 状态先落盘，再停机；恢复后的请求取消仍保留 pending。
  const stopHarness = harness();
  const stopping = options('resume', stopHarness);
  Object.assign(stopHarness, {
    shouldStopAfterTurn: ({ iteration }: { iteration: number }) => iteration === 2,
  });
  script([read(), read()]);
  await assert.rejects(runAgent('inspect', undefined, stopping), AgentStopRequestedError);
  const checkpoint = stopping.snapshots.at(-1);
  assert.ok(checkpoint);
  assert.equal(checkpoint.harnessState?.progressReminder?.reminder, 'pending');
  const controller = new AbortController();
  const cancelled = options('resume');
  script([read()], () => {
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  });
  await assert.rejects(
    runAgent('inspect', checkpoint, { ...cancelled, signal: controller.signal }),
  );
  assert.equal(hasReminder(requests[0]), true);
  const cancelledCheckpoint = cancelled.snapshots.at(-1);
  assert.ok(cancelledCheckpoint);
  assert.equal(cancelledCheckpoint.harnessState?.progressReminder?.reminder, 'pending');

  const resumed = options('resume');
  script([read(), done]);
  assert.equal(await runAgent('inspect', cancelledCheckpoint, resumed), 'done');
  assert.deepEqual(requests.map(hasReminder), [true, false]);
  assert.equal(resumed.events.filter((e) => e.type === 'progress_reminder').length, 0);
  assert.equal(resumed.snapshots.at(-1)?.harnessState?.progressReminder?.reminder, 'delivered');
  const again = options('resume');
  script([read(), read(), done]);
  await runAgent('inspect', resumed.snapshots.at(-1), again);
  assert.ok(
    requests.every((m) => !hasReminder(m)),
    '已持久化的投递标记在恢复后保留',
  );
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(ROOT, { recursive: true, force: true });
}
console.log('Progress reminder tests: PASS');
