// 套件: Plan 投影与注入 — 有界投影 + Harness 注入/恢复（无 LLM）
// 用法: node --import tsx tests/plan-view.test.ts
// 覆盖：
//   1. renderBoundedPlanView：空计划空串、进度与标记、标题裁剪、超量省略
//   2. DefaultContextHarness：planPort 改状态；prepareTurn 把计划注入 system；planTokens 计量
//   3. 空计划时视图与既有行为逐字节一致（零回归）
//   4. snapshotState/restoreState 往返：resume 后计划仍在（压缩/重启都不失忆）
//   5. 分层护栏：不实现 planPort 的 Harness 仍是合法实现（planPort 必须保持可选）

import assert from 'node:assert/strict';
import { type AgentContextHarness, DefaultContextHarness } from '../src/harness/context-harness.js';
import {
  createContextHarnessState,
  normalizeContextHarnessState,
} from '../src/harness/context-state.js';
import { resolveModelContextConfig } from '../src/harness/model-context.js';
import { PLAN_VIEW_TITLE_CHARS, renderBoundedPlanView } from '../src/harness/plan.js';
import type { ScratchpadView } from '../src/harness/scratchpad-view.js';
import type { ChatMessage } from '../src/llm/llm.js';

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

const SCRATCHPAD: ScratchpadView = {
  task: 'plan view task',
  completedSteps: [],
  failedSteps: [],
  invalidSteps: [],
  nextStep: null,
  lastResult: '',
};

function createHarness(): DefaultContextHarness {
  return new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelContext: resolveModelContextConfig({
      model: 'plan-view-test',
      contextWindowTokens: 8_000,
      maxOutputTokens: 1_000,
      safetyTokens: 500,
    }),
  });
}

// ---- 1. 有界投影 ----
await check('空计划：投影为空串（调用方据此完全跳过注入）', () => {
  const bounded = renderBoundedPlanView({ revision: 0, items: [] });
  assert.equal(bounded.text, '');
  assert.equal(bounded.truncated, false);
});

await check('投影含进度头、状态标记与维护要求', () => {
  const bounded = renderBoundedPlanView({
    revision: 3,
    items: [
      { id: 't1', title: '已完成项', status: 'completed' },
      { id: 't2', title: '进行中项', status: 'in_progress' },
      { id: 't3', title: '待办项', status: 'pending' },
    ],
  });
  assert.match(bounded.text, /\[当前计划\] 1\/3 完成（revision 3）/);
  assert.match(bounded.text, /✅ 已完成项/);
  assert.match(bounded.text, /▶ 进行中项/);
  assert.match(bounded.text, /○ 待办项/);
  assert.match(bounded.text, /完成一项后立即用 updatePlan 提交更新后的完整清单/);
});

await check(`标题超过 ${PLAN_VIEW_TITLE_CHARS} 字符：投影内裁剪并标记 truncated`, () => {
  const bounded = renderBoundedPlanView({
    revision: 1,
    items: [{ id: 't1', title: 'a'.repeat(PLAN_VIEW_TITLE_CHARS + 40), status: 'pending' }],
  });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.includes('…'), '裁剪处应有省略号');
  assert.ok(!bounded.text.includes('a'.repeat(PLAN_VIEW_TITLE_CHARS + 1)));
});

// ---- 2. 注入与计量 ----
await check('没有计划时：system 不出现计划段，planTokens=0（零回归）', async () => {
  const harness = createHarness();
  const view = await harness.prepareTurn(harness.createTranscript('t'), SCRATCHPAD, []);
  assert.doesNotMatch(String(view.messages[0].content), /\[当前计划\]/);
  assert.equal(view.planTokens, 0);
});

await check('planPort 改状态后：下一轮 system 注入计划，planTokens>0', async () => {
  const harness = createHarness();
  const port = harness.planPort();
  const applied = port.apply([
    { title: '跑通确定性套件', status: 'in_progress' },
    { title: '补测试', status: 'pending' },
  ]);
  assert.equal(applied.changed, true);

  const view = await harness.prepareTurn(harness.createTranscript('t'), SCRATCHPAD, []);
  const system = String(view.messages[0].content);
  assert.match(system, /\[当前计划\] 0\/2 完成（revision 1）/);
  assert.match(system, /跑通确定性套件/);
  assert.ok(view.planTokens > 0, 'planTokens 必须计入预算');
  // 计划段在 scratchpad 段之前（目标层 → 执行层）
  assert.ok(
    system.indexOf('[当前计划]') < system.indexOf('[执行进度 Scratchpad]'),
    '计划段应排在 scratchpad 之前',
  );
});

await check('重复提交同一清单：planPort 返回 changed=false 且 revision 不变', () => {
  const harness = createHarness();
  const port = harness.planPort();
  const first = port.apply([{ id: 't1', title: 'a', status: 'pending' }]);
  const again = port.apply([{ id: 't1', title: 'a', status: 'pending' }]);
  assert.equal(first.changed, true);
  assert.equal(again.changed, false);
  assert.equal(again.plan.revision, first.plan.revision);
  assert.equal(harness.snapshotState().plan.revision, 1);
});

// ---- 3. 跨 resume 不失忆 ----
await check('snapshot → restore：新 Harness 仍注入同一份计划（resume 路径）', async () => {
  const source = createHarness();
  source.planPort().apply([{ id: 't1', title: '中断前的任务', status: 'in_progress' }]);

  const resumed = createHarness();
  resumed.restoreState(source.snapshotState());
  const view = await resumed.prepareTurn(resumed.createTranscript('t'), SCRATCHPAD, []);
  assert.match(String(view.messages[0].content), /中断前的任务/);
  assert.equal(resumed.snapshotState().plan.revision, 1);
});

await check('旧 checkpoint（无 plan 字段）恢复为空计划，不抛错', () => {
  const legacy = { conversationSummary: 'old summary', summarizedMessageCount: 2 };
  const normalized = normalizeContextHarnessState(
    legacy as unknown as ReturnType<typeof createContextHarnessState>,
  );
  assert.equal(normalized.conversationSummary, 'old summary');
  assert.deepEqual(normalized.plan, { revision: 0, items: [] });
});

// ---- 4. 分层护栏 ----
await check('不实现 planPort 的 Harness 仍是合法实现（planPort 必须保持可选）', () => {
  const legacyHarness = {
    modelContext: createHarness().modelContext,
    createTranscript: (): ChatMessage[] => [],
    prepareTurn: (async () => {
      throw new Error('not used');
    }) as unknown as AgentContextHarness['prepareTurn'],
    restoreState: (): void => {},
    snapshotState: () => createContextHarnessState(),
    sanitizeAssistantMessage: (message: ChatMessage): ChatMessage => message,
    sanitizeFinalAnswer: (text: string): string => text,
  } satisfies AgentContextHarness;
  // 接口视角下 planPort 必须仍是可选的（缺失时 Runtime 走 fail-closed）。
  const asInterface: AgentContextHarness = legacyHarness;
  assert.equal(asInterface.planPort, undefined);
});

// ---- 5. 收尾审计报告 ----
await check('planReport：报告仍在进行/待办的项，已完成的项不进 unfinished', () => {
  const harness = createHarness();
  harness.planPort().apply([
    { id: 'a', title: '完成项', status: 'completed' },
    { id: 'b', title: '进行项', status: 'in_progress' },
    { id: 'c', title: '待办项', status: 'pending' },
  ]);
  const report = harness.planReport();
  assert.equal(report.total, 3);
  assert.equal(report.completed, 1);
  assert.equal(report.revision, 1);
  assert.deepEqual(
    report.unfinished.map((item) => [item.title, item.status]),
    [
      ['进行项', 'in_progress'],
      ['待办项', 'pending'],
    ],
  );
});

await check('planReport：没有计划时 total=0 且 unfinished 为空（Runtime 据此不发审计事件）', () => {
  const report = createHarness().planReport();
  assert.deepEqual(report, { revision: 0, total: 0, completed: 0, unfinished: [] });
});

console.log(`\nPlan 投影与注入汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：有界投影 / system 注入 / 预算计量 / 跨 resume 不失忆 / planPort 可选 ✓');
