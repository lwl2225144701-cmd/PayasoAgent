// 套件: Plan 闭环 — 工具 → Harness 状态 → plan_update 事件 → 注入 → 失败兜底（mock LLM，无真实模型）
// 用法: node --import tsx tests/plan-loop.test.ts
// 覆盖：
//   1. 模型调用 updatePlan → trace 发 plan_update（全量清单/revision/进度）
//   2. 下一轮请求的 system 里能看到计划（模型不失忆），且 context_usage.planTokens 计入预算
//   3. 状态推进：completed 后 revision 前进、completed 计数正确
//   4. 重复提交同一清单不重复发事件（前端零抖动）
//   5. 越界清单（>12 项）→ 工具报错、计划不变、模型收到结构化错误
//   6. Harness 未提供 planPort → 工具 fail-closed（不静默成功）

import assert from 'node:assert/strict';
import { type AgentContextHarness, DefaultContextHarness } from '../src/harness/context-harness.js';
import { resolveModelContextConfig } from '../src/harness/model-context.js';
import { silentRuntimeObserver } from '../src/runtime/observer-port.js';
import type { TraceEvent } from '../src/runtime/trace.js';
import {
  createTestWorkspaceRoot,
  runMockAgent,
  textResponse,
  toolCallResponse,
} from './helpers/mock-runner.js';

const WORKSPACE = createTestWorkspaceRoot('payaso-plan-loop-');

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

function createHarness(): DefaultContextHarness {
  return new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelContext: resolveModelContextConfig({
      model: 'plan-loop-test',
      contextWindowTokens: 8_000,
      maxOutputTokens: 1_000,
      safetyTokens: 500,
    }),
  });
}

function planEvents(traces: TraceEvent[]) {
  return traces.filter((event) => event.type === 'plan_update') as Array<
    Extract<TraceEvent, { type: 'plan_update' }>
  >;
}

/** 取出每次请求里 system 消息的文本（断言"模型看到了什么"）。 */
function systemTexts(bodies: unknown[]): string[] {
  return bodies.map((body) => {
    const messages =
      (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
    return messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n');
  });
}

// ---- 1. 建计划 → 事件 + 注入 ----
const harness = createHarness();
const bodies: unknown[] = [];
const run = await runMockAgent({
  runId: 'plan-loop-basic',
  task: '三步任务',
  workspaceRoot: WORKSPACE,
  contextHarness: harness,
  observer: silentRuntimeObserver,
  script: [
    () =>
      toolCallResponse([
        {
          id: 'call-1',
          name: 'updatePlan',
          args: {
            items: [
              { title: '第一步', status: 'in_progress' },
              { title: '第二步', status: 'pending' },
              { title: '第三步', status: 'pending' },
            ],
          },
        },
      ]),
    () => textResponse('计划已建立，开始执行第一步。'),
  ],
  onRequest: (body) => bodies.push(body),
});

await check('Run 正常结束（工具调用 + 收尾）', () => {
  assert.equal(run.error, undefined, run.error?.message ?? 'run failed');
  assert.equal(run.answer, '计划已建立，开始执行第一步。');
});

await check('发出一条 plan_update：全量清单 + revision=1 + 进度 0/3', () => {
  const events = planEvents(run.traces);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.revision, 1);
  assert.equal(event.total, 3);
  assert.equal(event.completed, 0);
  assert.deepEqual(
    event.items.map((item) => [item.id, item.status]),
    [
      ['t1', 'in_progress'],
      ['t2', 'pending'],
      ['t3', 'pending'],
    ],
  );
});

await check('第二轮请求的 system 里能看到计划（模型不失忆）', () => {
  const systems = systemTexts(bodies);
  assert.equal(systems.length, 2);
  assert.doesNotMatch(systems[0], /\[当前计划\]/, '第一轮还没有计划');
  assert.match(systems[1], /\[当前计划\] 0\/3 完成（revision 1）/);
  assert.match(systems[1], /第一步/);
});

await check('context_usage 计入 planTokens（预算可审计）', () => {
  const usages = run.traces.filter((event) => event.type === 'context_usage') as Array<
    Extract<TraceEvent, { type: 'context_usage' }>
  >;
  assert.ok(usages.length >= 1);
  assert.ok((usages[usages.length - 1].planTokens ?? 0) > 0);
});

await check('工具结果回给模型：含进度与"完成后立即更新"引导', () => {
  const toolMessages = run.traces.filter(
    (event) => event.type === 'tool_result' && event.tool === 'updatePlan',
  ) as Array<Extract<TraceEvent, { type: 'tool_result' }>>;
  assert.equal(toolMessages.length, 1);
  assert.match(String(toolMessages[0].result), /\[计划\] 0\/3 完成（revision 1）/);
});

// ---- 2. 状态推进 + 重复提交不重复发事件 ----
const advanceHarness = createHarness();
const advance = await runMockAgent({
  runId: 'plan-loop-advance',
  task: '推进计划',
  workspaceRoot: WORKSPACE,
  contextHarness: advanceHarness,
  observer: silentRuntimeObserver,
  script: [
    () =>
      toolCallResponse([
        {
          id: 'call-1',
          name: 'updatePlan',
          args: { items: [{ id: 'a', title: 'A', status: 'in_progress' }] },
        },
      ]),
    // 同一份清单重复提交：内容等价 → 不应再发事件
    () =>
      toolCallResponse([
        {
          id: 'call-2',
          name: 'updatePlan',
          args: { items: [{ id: 'a', title: 'A', status: 'in_progress' }] },
        },
      ]),
    () =>
      toolCallResponse([
        {
          id: 'call-3',
          name: 'updatePlan',
          args: { items: [{ id: 'a', title: 'A', status: 'completed' }] },
        },
      ]),
    () => textResponse('A 完成。'),
  ],
});

await check('状态推进：revision 1 → 2，completed 计数正确', () => {
  const events = planEvents(advance.traces);
  assert.equal(events.length, 2, '重复提交同一清单不得重复发事件');
  assert.deepEqual(
    events.map((event) => [event.revision, event.completed, event.total]),
    [
      [1, 0, 1],
      [2, 1, 1],
    ],
  );
  assert.equal(advanceHarness.snapshotState().plan.items[0].status, 'completed');
});

// ---- 3. 越界清单：结构化报错、计划不变 ----
const invalidHarness = createHarness();
const tooMany = await runMockAgent({
  runId: 'plan-loop-invalid',
  task: '越界计划',
  workspaceRoot: WORKSPACE,
  contextHarness: invalidHarness,
  observer: silentRuntimeObserver,
  script: [
    () =>
      toolCallResponse([
        {
          id: 'call-1',
          name: 'updatePlan',
          args: {
            items: Array.from({ length: 13 }, (_, index) => ({
              title: `item-${index}`,
              status: 'pending',
            })),
          },
        },
      ]),
    () => textResponse('收到报错，改为不建计划。'),
  ],
});

await check('超过上限：不发 plan_update，计划保持不变，模型收到结构化错误', () => {
  assert.equal(planEvents(tooMany.traces).length, 0);
  assert.deepEqual(invalidHarness.snapshotState().plan, { revision: 0, items: [] });
  const errors = tooMany.traces.filter((event) => event.type === 'tool_error') as Array<
    Extract<TraceEvent, { type: 'tool_error' }>
  >;
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].error), /13 items, above the limit of 12/);
  assert.equal(tooMany.answer, '收到报错，改为不建计划。');
});

// ---- 4. Harness 无 planPort：fail-closed ----
// 分层护栏：一个只转发、不实现 planPort 的 Harness 是合法的 drop-in（接口里 planPort 可选）。
const inner = createHarness();
const harnessWithoutPlanPort: AgentContextHarness = {
  modelContext: inner.modelContext,
  createTranscript: (task, history, attachments) =>
    inner.createTranscript(task, history, attachments),
  prepareTurn: (transcript, scratchpad, tools, signal) =>
    inner.prepareTurn(transcript, scratchpad, tools, signal),
  restoreState: (state) => inner.restoreState(state),
  snapshotState: () => inner.snapshotState(),
  sanitizeAssistantMessage: (message) => inner.sanitizeAssistantMessage(message),
  sanitizeFinalAnswer: (text) => inner.sanitizeFinalAnswer(text),
};
const noPort = await runMockAgent({
  runId: 'plan-loop-no-port',
  task: '无端口',
  workspaceRoot: WORKSPACE,
  contextHarness: harnessWithoutPlanPort,
  observer: silentRuntimeObserver,
  script: [
    () =>
      toolCallResponse([
        { id: 'call-1', name: 'updatePlan', args: { items: [{ title: 'x', status: 'pending' }] } },
      ]),
    () => textResponse('计划工具不可用。'),
  ],
});

await check('Harness 未提供 planPort：工具 fail-closed，不发事件', () => {
  assert.equal(planEvents(noPort.traces).length, 0);
  const errors = noPort.traces.filter((event) => event.type === 'tool_error') as Array<
    Extract<TraceEvent, { type: 'tool_error' }>
  >;
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].error), /需要 Agent Runtime 提供的计划端口/);
});

console.log(`\nPlan 闭环汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：工具 → 状态 → 事件 → 注入 → 越界报错 → 无端口 fail-closed ✓');
