// 套件: Plan 状态机 — Agent 自述任务清单的校验/归一化/全量替换语义（纯函数，无 LLM）
// 用法: node --import tsx tests/plan-state.test.ts
// 覆盖：初始态、全量替换、无变化不升 revision、id 复用与去重、单 in_progress 收敛、
//   上限/空标题/超长标题/非法状态的结构化报错、清空、结果文本、旧 checkpoint 容错

import assert from 'node:assert/strict';
import {
  applyPlan,
  countCompleted,
  createPlan,
  isPlanEmpty,
  normalizePlan,
  PLAN_MAX_ITEMS,
  PLAN_MAX_TITLE_CHARS,
  type Plan,
  renderPlanResult,
} from '../src/harness/plan.js';

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

function submit(plan: Plan, items: Parameters<typeof applyPlan>[1]) {
  return applyPlan(plan, items);
}

// ---- 初始态 ----
check('初始计划为空且 revision=0', () => {
  const plan = createPlan();
  assert.equal(plan.revision, 0);
  assert.ok(isPlanEmpty(plan));
  assert.equal(countCompleted(plan), 0);
});

// ---- 首次提交与全量替换 ----
const first = submit(createPlan(), [
  { title: '跑通确定性套件', status: 'in_progress' },
  { title: '补 plan 状态机测试', status: 'pending' },
]);

check('首次提交：自动编号 t1/t2、revision=1、changed=true', () => {
  assert.equal(first.changed, true);
  assert.equal(first.plan.revision, 1);
  assert.deepEqual(
    first.plan.items.map((item) => [item.id, item.status]),
    [
      ['t1', 'in_progress'],
      ['t2', 'pending'],
    ],
  );
});

check('结果文本回给模型：含进度、清单与"完成后立即更新"引导', () => {
  assert.match(first.resultText, /\[计划\] 0\/2 完成（revision 1）/);
  assert.match(first.resultText, /1\. ▶ 跑通确定性套件/);
  assert.match(first.resultText, /2\. ○ 补 plan 状态机测试/);
  assert.match(first.resultText, /完成后立即用 updatePlan 把它标为 completed/);
});

check('重复提交同一清单：changed=false、原引用、revision 不变（前端零抖动）', () => {
  const again = submit(first.plan, [
    { id: 't1', title: '跑通确定性套件', status: 'in_progress' },
    { id: 't2', title: '补 plan 状态机测试', status: 'pending' },
  ]);
  assert.equal(again.changed, false);
  assert.equal(again.plan, first.plan, '无变化必须返回同一引用');
  assert.equal(again.plan.revision, 1);
});

check('全量替换：改状态 → revision=2，顺序与内容以本次提交为准', () => {
  const next = submit(first.plan, [
    { id: 't1', title: '跑通确定性套件', status: 'completed' },
    { id: 't2', title: '补 plan 状态机测试', status: 'in_progress' },
  ]);
  assert.equal(next.changed, true);
  assert.equal(next.plan.revision, 2);
  assert.equal(countCompleted(next.plan), 1);
  assert.equal(next.plan.items.length, 2);
});

check('全量替换：删项即丢失（不保留历史项）', () => {
  const next = submit(first.plan, [{ id: 't1', title: '只剩一项', status: 'completed' }]);
  assert.equal(next.plan.items.length, 1);
  assert.equal(next.plan.items[0].title, '只剩一项');
});

check('id 复用：沿用 id 更新同一项（前端按 id 稳定 key）', () => {
  const next = submit(first.plan, [
    { id: 'keep-me', title: '第一项改标题', status: 'pending' },
    { id: 'keep-me', title: '重复 id 的后来者', status: 'pending' },
  ]);
  assert.deepEqual(
    next.plan.items.map((item) => item.id),
    ['keep-me', 'keep-me#2'],
  );
});

// ---- 状态归一化 ----
check('多项 in_progress：最后一项生效，其余回落 pending', () => {
  const next = submit(createPlan(), [
    { title: 'a', status: 'in_progress' },
    { title: 'b', status: 'in_progress' },
    { title: 'c', status: 'in_progress' },
  ]);
  assert.deepEqual(
    next.plan.items.map((item) => item.status),
    ['pending', 'pending', 'in_progress'],
  );
});

// ---- 校验失败：结构化报错，不静默截断 ----
check(`超过 ${PLAN_MAX_ITEMS} 项：抛错且文案含实际值与上限`, () => {
  const items = Array.from({ length: PLAN_MAX_ITEMS + 1 }, (_, index) => ({
    title: `item-${index}`,
    status: 'pending' as const,
  }));
  assert.throws(
    () => submit(createPlan(), items),
    new RegExp(`${PLAN_MAX_ITEMS + 1} items, above the limit of ${PLAN_MAX_ITEMS}`),
  );
});

check('空标题：抛错并指出第几项', () => {
  assert.throws(
    () => submit(createPlan(), [{ title: '  ', status: 'pending' }]),
    /Plan item #1 is missing a title/,
  );
});

check(`标题超过 ${PLAN_MAX_TITLE_CHARS} 字符：抛错`, () => {
  assert.throws(
    () =>
      submit(createPlan(), [{ title: 'x'.repeat(PLAN_MAX_TITLE_CHARS + 1), status: 'pending' }]),
    new RegExp(`above the limit of ${PLAN_MAX_TITLE_CHARS}`),
  );
});

check('非法 status：抛错并列出具名取值', () => {
  assert.throws(
    () => submit(createPlan(), [{ title: 'a', status: 'done' as unknown as 'pending' }]),
    /invalid status "done"; use one of: pending, in_progress, completed/,
  );
});

check('校验失败不修改传入计划（错误路径无副作用）', () => {
  const plan = submit(createPlan(), [{ title: 'a', status: 'pending' }]).plan;
  const snapshot = structuredClone(plan);
  assert.throws(() => submit(plan, [{ title: '', status: 'pending' }]));
  assert.deepEqual(plan, snapshot);
});

// ---- 清空 ----
check('提交空数组 = 清空计划（revision 前进）', () => {
  const cleared = submit(first.plan, []);
  assert.equal(cleared.changed, true);
  assert.equal(cleared.plan.revision, first.plan.revision + 1);
  assert.ok(isPlanEmpty(cleared.plan));
  assert.match(renderPlanResult(cleared.plan), /已清空（0 项）/);
});

// ---- 旧 checkpoint 容错 ----
check('normalizePlan：非法输入一律退化为"没有计划"，不阻断恢复', () => {
  assert.deepEqual(normalizePlan(undefined), createPlan());
  assert.deepEqual(normalizePlan('nope'), createPlan());
  assert.deepEqual(normalizePlan({ revision: -1, items: 'nope' }), createPlan());
});

check('normalizePlan：丢弃坏项、截断超长标题与超量清单，保留合法 revision', () => {
  const items = Array.from({ length: PLAN_MAX_ITEMS + 3 }, (_, index) => ({
    id: `t${index + 1}`,
    title: `ok-${index}`,
    status: 'pending',
  }));
  items[0].title = 'y'.repeat(PLAN_MAX_TITLE_CHARS + 50);
  const bad = [
    ...items,
    { id: 'bad', title: '', status: 'pending' },
    { id: 'bad2', title: 'x', status: 'nope' },
  ];
  const plan = normalizePlan({ revision: 7, items: bad });
  assert.equal(plan.revision, 7);
  assert.equal(plan.items.length, PLAN_MAX_ITEMS);
  assert.equal(plan.items[0].title.length, PLAN_MAX_TITLE_CHARS);
});

console.log(`\nPlan 状态机汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：全量替换 / 无变化不升 revision / 归一化 / 上限报错 / 旧数据容错 ✓');
