// 套件: 前端计划派生 — PlanPanel 依赖的 derivePlan（纯函数，无 DOM）
// 用法: node --import tsx tests/frontend-plan-state.test.ts
// 覆盖：无事件 → null、进度与 allDone、取 revision 最大（乱序/重放幂等）、
//   清空计划 → null、坏字段容错

import assert from 'node:assert/strict';
import { derivePlan } from '../web/src/components/Timeline/plan-state.js';
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

console.log(`\n前端计划派生汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：空态 / 进度 / revision 权威序 / 重放幂等 / 清空隐藏 / 坏字段容错 ✓');
