// 套件: 前端计划派生 — PlanPanel 依赖的 derivePlan（纯函数，无 DOM）
// 用法: node --import tsx tests/frontend-plan-state.test.ts
// 覆盖：无事件 → null、进度与 allDone、取 revision 最大（乱序/重放幂等）、
//   清空计划 → null、坏字段容错

import assert from 'node:assert/strict';
import { derivePlan, derivePlanNotes } from '../web/src/components/Timeline/plan-state.js';
import type { HostEvent, PlanUpdateEvent } from '../web/src/types.js';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

const base = { step: 1, timestamp: '2026-09-10T00:00:00.000Z', completed: 0, total: 0 };

function planEvent(
  revision: number,
  items: PlanUpdateEvent['items'],
  counts?: { completed?: number; total?: number },
): PlanUpdateEvent {
  return {
    ...base,
    type: 'plan_update',
    revision,
    items,
    completed: counts?.completed ?? items.filter((item) => item.status === 'completed').length,
    total: counts?.total ?? items.length,
  };
}

const THREE = [
  { id: 't1', title: '第一步', status: 'completed' as const },
  { id: 't2', title: '第二步', status: 'in_progress' as const },
  { id: 't3', title: '第三步', status: 'pending' as const },
];

// ---- 空态 ----
check('没有任何事件 → null（旧会话不渲染面板）', () => {
  assert.equal(derivePlan([]), null);
});

check('只有非计划事件 → null', () => {
  const events = [
    { type: 'scratchpad_update', step: 1, timestamp: base.timestamp },
  ] as unknown as HostEvent[];
  assert.equal(derivePlan(events), null);
});

// ---- 基本派生 ----
check('单条事件 → 进度、清单与 allDone', () => {
  const view = derivePlan([planEvent(1, THREE)]);
  assert.ok(view);
  assert.equal(view.revision, 1);
  assert.equal(view.completed, 1);
  assert.equal(view.total, 3);
  assert.equal(view.allDone, false);
  assert.deepEqual(
    view.items.map((item) => item.status),
    ['completed', 'in_progress', 'pending'],
  );
});

check('全部完成 → allDone=true；空清单 → null（模型主动清空后隐藏面板）', () => {
  const done = derivePlan([
    planEvent(2, [
      { id: 'a', title: 'A', status: 'completed' },
      { id: 'b', title: 'B', status: 'completed' },
    ]),
  ]);
  assert.ok(done);
  assert.equal(done.allDone, true);
  assert.equal(derivePlan([planEvent(3, [])]), null);
});

// ---- 幂等：乱序 / 重放 ----
check('乱序回放：取 revision 最大的一条（不是数组最后一条）', () => {
  const events: HostEvent[] = [
    planEvent(3, [{ id: 't1', title: '最新', status: 'in_progress' }]),
    planEvent(1, [{ id: 't1', title: '最初', status: 'pending' }]),
    planEvent(2, [{ id: 't1', title: '中间', status: 'pending' }]),
  ];
  const view = derivePlan(events);
  assert.ok(view);
  assert.equal(view.revision, 3);
  assert.equal(view.items[0].title, '最新');
});

check('SSE 重连重复投递同一 revision → 结果稳定', () => {
  const event = planEvent(2, THREE);
  const once = derivePlan([event]);
  const twice = derivePlan([event, { ...event }, { ...event }]);
  assert.deepEqual(twice, once);
});

check('清空后再收到旧的非空计划（重放）→ 仍以最大 revision 为准（隐藏）', () => {
  const events: HostEvent[] = [
    planEvent(5, []),
    planEvent(2, [{ id: 't1', title: '旧计划', status: 'pending' }]),
  ];
  assert.equal(derivePlan(events), null);
});

// ---- 容错 ----
check('坏字段容错：缺 title / 未知 status / 非整数 revision 全部安全降级', () => {
  const messy = {
    ...base,
    type: 'plan_update',
    revision: 1.5,
    items: THREE,
  } as unknown as PlanUpdateEvent;
  assert.equal(derivePlan([messy]), null, '非整数 revision 视为不可用，忽略该事件');

  const view = derivePlan([
    {
      ...base,
      type: 'plan_update',
      revision: 4,
      items: [
        { id: 'ok', title: '合法项', status: 'pending' },
        { id: 'no-title', title: '', status: 'pending' },
        { id: 'bad-status', title: '状态坏了', status: 'weird' },
        null,
      ],
      completed: 0,
      total: 4,
    } as unknown as PlanUpdateEvent,
  ]);
  assert.ok(view);
  assert.deepEqual(
    view.items.map((item) => [item.title, item.status]),
    [
      ['合法项', 'pending'],
      ['状态坏了', 'pending'],
    ],
  );
  assert.equal(view.total, 2, 'total 以过滤后的清单为准，不信任事件里的计数');
});

// ---- 计划变更说明（时间线里的视觉呼应）----
check('derivePlanNotes：建立 / 开始 / 完成 / 全完成 各落一行，挂在对应 step 上', () => {
  const events = [
    { ...planEvent(1, THREE), step: 3 },
    { ...planEvent(2, [{ ...THREE[0] }, { ...THREE[1] }, { ...THREE[2] }]), step: 9 },
    {
      ...planEvent(3, [
        { ...THREE[0] },
        { ...THREE[1], status: 'completed' as const },
        { ...THREE[2] },
      ]),
      step: 12,
    },
  ] as HostEvent[];
  const notes = derivePlanNotes(events);
  assert.equal(notes.get(3)?.kind, 'created');
  assert.match(String(notes.get(3)?.text), /计划已建立 · 3 项/);
  assert.equal(notes.get(9)?.kind, 'progress');
  assert.match(String(notes.get(9)?.text), /计划已更新 · 1\/3 完成/);
  // 第二步完成 + 第三步开始（同一份清单里同时发生）
  assert.equal(notes.get(12)?.kind, 'progress');
});

check('derivePlanNotes：完成与开始同现时一行说明两件事，全部完成标记 done', () => {
  const second = { ...THREE[1], status: 'completed' as const };
  const third = { ...THREE[2], status: 'in_progress' as const };
  const events = [
    { ...planEvent(1, THREE), step: 3 },
    // 第二步完成 + 第三步开始：同一份清单里同时发生
    { ...planEvent(2, [{ ...THREE[0] }, second, third]), step: 6 },
    {
      ...planEvent(3, [{ ...THREE[0] }, second, { ...third, status: 'completed' as const }]),
      step: 8,
    },
  ] as HostEvent[];
  const notes = derivePlanNotes(events);
  assert.equal(notes.get(6)?.kind, 'progress');
  assert.match(String(notes.get(6)?.text), /✅ 完成：第二步/);
  assert.match(String(notes.get(6)?.text), /▶ 开始：第三步/);
  assert.match(String(notes.get(6)?.text), /（2\/3）/);
  assert.equal(notes.get(8)?.kind, 'done');
  assert.match(String(notes.get(8)?.text), /（3\/3）/);
});

check('derivePlanNotes：清空计划单独成行；无计划事件 → 空表', () => {
  const events = [
    { ...planEvent(1, THREE), step: 3 },
    { ...planEvent(2, []), step: 5 },
  ] as HostEvent[];
  const notes = derivePlanNotes(events);
  assert.equal(notes.get(5)?.kind, 'cleared');
  assert.equal(derivePlanNotes([]).size, 0);
});

check('derivePlanNotes：乱序回放按 revision 排序，说明不会错位', () => {
  const events = [
    { ...planEvent(2, [{ id: 't1', title: 'A', status: 'completed' as const }]), step: 9 },
    { ...planEvent(1, [{ id: 't1', title: 'A', status: 'pending' as const }]), step: 3 },
  ] as HostEvent[];
  const notes = derivePlanNotes(events);
  assert.equal(notes.get(3)?.kind, 'created');
  assert.equal(notes.get(9)?.kind, 'done');
});

console.log(`\n前端计划派生汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：空态 / 进度 / revision 权威序 / 重放幂等 / 清空隐藏 / 坏字段容错 ✓');
