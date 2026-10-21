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
import { loadCheckpoint } from '../src/persistence/file-checkpoint-store.js';
import { silentRuntimeObserver } from '../src/runtime/observer-port.js';
import type { TraceEvent } from '../src/runtime/trace.js';
import { validateToolArguments } from '../src/tools/tool-arguments.js';
import { getTool } from '../src/tools/tools.js';
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
      // v2.5（批次C）：check 工具对真实模型可见后工具 schema 基线约 +0.7k tokens；
      // 同步上调合成窗口，保持"计划收尾"路径不被上下文压缩插入的额外往返干扰。
      contextWindowTokens: 10_000,
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

await check('第二轮请求：计划进尾部 [Context]，不进 system（前缀稳定）', () => {
  const systems = systemTexts(bodies);
  const contexts = bodies.map((body) => {
    const messages =
      (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
    const context = messages.find((m) => String(m.content).includes('[Context]'));
    return context ? String(context.content) : '';
  });
  // 状态投影仅提供事实；不会因 in_progress 项而强制模型再来一轮。
  assert.ok(contexts.length >= 2, `至少两次请求，实际 ${contexts.length}`);
  assert.doesNotMatch(contexts[0], /\[当前计划\]/, '第一轮还没有计划');
  assert.match(contexts[1], /\[当前计划\] 0\/3 完成（revision 1）/);
  assert.match(contexts[1], /第一步/);
  // 计划不得再进 system——那正是每轮改写前缀、作废缓存的根因。
  assert.doesNotMatch(systems[1], /\[当前计划\]/, '计划不得注入 system');
});

await check('context_usage 计入 planTokens（预算可审计）', () => {
  const usages = run.traces.filter((event) => event.type === 'context_usage') as Array<
    Extract<TraceEvent, { type: 'context_usage' }>
  >;
  assert.ok(usages.length >= 1);
  assert.ok((usages[usages.length - 1].planTokens ?? 0) > 0);
});

await check('工具结果回给模型：含进度与"按阶段更新"引导', () => {
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

// ---- 5. 收尾审计：计划未做完时留痕（不阻断收尾），做完则不留痕 ----
const unfinishedHarness = createHarness();
const unfinished = await runMockAgent({
  runId: 'plan-loop-unfinished',
  task: '只做一半',
  workspaceRoot: WORKSPACE,
  contextHarness: unfinishedHarness,
  observer: silentRuntimeObserver,
  script: [
    () =>
      toolCallResponse([
        {
          id: 'call-1',
          name: 'updatePlan',
          args: {
            items: [
              { title: '已完成的项', status: 'completed' },
              { title: '没做的项', status: 'pending' },
            ],
          },
        },
      ]),
    () => textResponse('先到这里。'),
  ],
});

await check('收尾时仍有未完成项：发 plan_incomplete_at_finish 审计事件，且不阻断收尾', () => {
  const audit = unfinished.traces.filter((e) => e.type === 'plan_incomplete_at_finish') as Array<
    Extract<TraceEvent, { type: 'plan_incomplete_at_finish' }>
  >;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].total, 2);
  assert.equal(audit[0].completed, 1);
  assert.deepEqual(
    audit[0].unfinished.map((item) => [item.title, item.status]),
    [['没做的项', 'pending']],
  );
  assert.equal(unfinished.answer, '先到这里。', '审计事件不得改变收尾行为');
  // 审计事件必须排在 final_answer 之前（同一轮收尾路径内）
  const types = unfinished.traces.map((event) => event.type);
  assert.ok(
    types.indexOf('plan_incomplete_at_finish') < types.indexOf('final_answer'),
    '审计事件应在 final_answer 之前落盘',
  );
});

await check('计划全部完成：不发审计事件', () => {
  const types = advance.traces.map((event) => event.type);
  assert.ok(!types.includes('plan_incomplete_at_finish'), '3/3 全部完成时不该留痕');
});

await check('没有计划（未调用 updatePlan）：不发审计事件', () => {
  assert.ok(!noPort.traces.some((event) => event.type === 'plan_incomplete_at_finish'));
});

// ---- 6. 计划状态仅提示，由模型决定维护和交付 ----
await check('仍有 in_progress：保留状态事实，不强制追加模型轮次', () => {
  assert.equal(run.fetchCalls, 2);
  assert.ok(!run.traces.some((event) => event.type === 'plan_finalize_reminder'));
  assert.ok(run.traces.some((event) => event.type === 'plan_incomplete_at_finish'));
  assert.equal(harness.snapshotState().plan.items[0].status, 'in_progress');
});

await check('模型自主更新计划并交付：状态与审计仍正确', async () => {
  const harness = createHarness();
  const done = await runMockAgent({
    runId: 'plan-loop-finalize',
    task: '收尾前收敛计划',
    workspaceRoot: WORKSPACE,
    contextHarness: harness,
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
      // 模型自行决定更新计划，Runtime 不打回它的答复。
      () =>
        toolCallResponse([
          {
            id: 'call-2',
            name: 'updatePlan',
            args: { items: [{ id: 'a', title: 'A', status: 'completed' }] },
          },
        ]),
      () => textResponse('A 已完成。'),
    ],
  });
  assert.equal(done.error, undefined, done.error?.message ?? 'run failed');
  const types = done.traces.map((event) => event.type);
  assert.ok(!types.includes('plan_finalize_reminder'));
  assert.equal(done.fetchCalls, 3);
  assert.ok(
    !types.includes('plan_incomplete_at_finish'),
    '模型在提醒后收尾完成 → 不该再留未完成审计事件',
  );
  assert.equal(done.answer, 'A 已完成。');
});

await check('无计划 / 已全部完成 → 不发提醒（不多花一次 LLM 往返）', () => {
  assert.ok(
    !advance.traces.some((event) => event.type === 'plan_finalize_reminder'),
    '3/3 完成后收尾不该提醒',
  );
  assert.ok(
    !noPort.traces.some((event) => event.type === 'plan_finalize_reminder'),
    '从未建计划不该提醒',
  );
});

await check('只剩 pending（无 in_progress）→ 不提醒', async () => {
  const harness = createHarness();
  const pendingOnly = await runMockAgent({
    runId: 'plan-loop-pending-only',
    task: '只建不开始',
    workspaceRoot: WORKSPACE,
    contextHarness: harness,
    observer: silentRuntimeObserver,
    script: [
      () =>
        toolCallResponse([
          {
            id: 'call-1',
            name: 'updatePlan',
            args: { items: [{ id: 'a', title: 'A', status: 'pending' }] },
          },
        ]),
      () => textResponse('还没开始。'),
    ],
  });
  assert.ok(
    !pendingOnly.traces.some((event) => event.type === 'plan_finalize_reminder'),
    '没有进行中项就不该提醒',
  );
  // 但审计事件仍然如实反映未完成（只报告，不阻断）
  assert.ok(pendingOnly.traces.some((event) => event.type === 'plan_incomplete_at_finish'));
});

await check('计划面板提交后由模型决定下一步与最终交付，不自动结束或隐藏工具', async () => {
  const h = createHarness();
  const requests: unknown[] = [];
  const planned = await runMockAgent({
    runId: 'plan-panel-delivery',
    task: '给消息输入框增加草稿，完成测试与构建。先给我调研出个计划，计划对话框给我就行',
    workspaceRoot: WORKSPACE,
    contextHarness: h,
    observer: silentRuntimeObserver,
    onRequest: (body) => requests.push(body),
    script: [
      () =>
        toolCallResponse([
          {
            id: 'deliver-plan',
            name: 'updatePlan',
            args: {
              items: [
                { title: '调研完成', status: 'completed' },
                { title: '实现草稿与验证', status: 'pending' },
              ],
            },
          },
        ]),
      () => toolCallResponse([{ id: 'model-chosen-read', name: 'ls', args: { path: '.' } }]),
      () => textResponse('计划已提交，请确认后实施。'),
    ],
  });
  assert.equal(planned.error, undefined);
  assert.equal(planned.fetchCalls, 3, '计划成功不代替模型的继续或完成决策');
  assert.equal(planned.answer, '计划已提交，请确认后实施。');
  assert.equal(h.snapshotState().plan.items[1].status, 'pending', '不能伪造未来工作已完成');
  assert.equal(planEvents(planned.traces).length, 1);
  assert.ok(planned.traces.some((event) => event.type === 'final_answer'));
  assert.ok(planned.traces.some((event) => event.type === 'plan_incomplete_at_finish'));
  assert.ok(planned.traces.some((event) => event.type === 'tool_result' && event.tool === 'ls'));
  assert.ok(!planned.traces.some((event) => event.type === 'tool_error'));
  assert.match(JSON.stringify(requests[0]), /计划对话框给我就行/);
  assert.doesNotMatch(JSON.stringify(requests), /A successful submission completes this turn/);
  const saved = loadCheckpoint('plan-panel-delivery');
  assert.equal(saved?.state.status, 'completed');
  assert.equal(saved?.messages.at(-1)?.content, planned.answer);
  assert.equal(saved?.harnessState?.plan.items[1].status, 'pending');
});

await check('失败提交、空清单与进行中状态如实反馈，不替模型改写最终答复', async () => {
  for (const [index, items] of [
    [{ title: '错误状态', status: 'bad-status' }],
    [],
    [{ title: '还在调研', status: 'in_progress' }],
  ].entries()) {
    const h = createHarness();
    const result = await runMockAgent({
      runId: `plan-panel-not-delivered-${index}`,
      task: '先给我调研出个计划，计划对话框给我就行',
      workspaceRoot: WORKSPACE,
      contextHarness: h,
      observer: silentRuntimeObserver,
      script: [
        () => toolCallResponse([{ id: 'incomplete-plan', name: 'updatePlan', args: { items } }]),
        () => textResponse('调研尚未完成，计划暂未交付。'),
      ],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.fetchCalls, 2);
    assert.notEqual(result.answer, '计划已提交到计划面板。');
  }
});

await check('文字计划不要求面板：updatePlan 后继续给出用户要求的计划正文', async () => {
  const result = await runMockAgent({
    runId: 'plan-text-delivery',
    task: '先给我一个计划',
    workspaceRoot: WORKSPACE,
    contextHarness: createHarness(),
    observer: silentRuntimeObserver,
    script: [
      () =>
        toolCallResponse([
          {
            id: 'text-plan',
            name: 'updatePlan',
            args: {
              items: [{ title: '实现与验证', status: 'pending' }],
            },
          },
        ]),
      () => textResponse('方案：修改存储层和输入框，测试任务隔离与发送失败保留。'),
    ],
  });
  assert.equal(result.error, undefined);
  assert.equal(result.fetchCalls, 2);
  assert.match(result.answer ?? '', /方案：/);
});

await check('真实 Run 的 content/title 错误可修正，合法示例与 Schema 一致', async () => {
  const planTool = getTool('updatePlan');
  assert.ok(planTool);
  const example = planTool.description.match(/参数示例：(\{.*\})。条目/)?.[1];
  assert.ok(example, '工具描述必须包含完整参数对象示例');
  assert.equal(validateToolArguments(planTool.parameters, JSON.parse(example)).ok, true);
  const bodies: unknown[] = [];
  const result = await runMockAgent({
    runId: 'plan-content-title-recovery',
    task: '给我一个计划',
    workspaceRoot: WORKSPACE,
    onRequest: (body) => bodies.push(body),
    script: [
      () =>
        toolCallResponse([
          {
            id: 'invalid-plan',
            name: 'updatePlan',
            args: { items: [{ content: '验证', status: 'pending' }] },
          },
        ]),
      () =>
        toolCallResponse([
          {
            id: 'corrected-plan',
            name: 'updatePlan',
            args: { items: [{ title: '验证', status: 'pending' }] },
          },
        ]),
      () => textResponse('计划已提交'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(planEvents(result.traces).length, 1, '非法参数不能被猜测修复或写入计划');
  const second = JSON.stringify(bodies[1]);
  assert.match(second, /items\[0\]\.title/);
  assert.match(second, /items\[0\]\.content/);
  assert.match(second, /INVALID_ARGUMENT_SHAPE/);
});

console.log(`\nPlan 闭环汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：工具 → 状态 → 事件 → 提示 → 参数校验 → 模型自主交付 ✓');
