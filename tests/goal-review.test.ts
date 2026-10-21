// 套件: 周期性目标审查策略（Harness 纯函数，无 LLM）
// 用法: node --import tsx tests/goal-review.test.ts
// 验收：
//   1. 按全部工具回合计数（读/写/失败/中性都算）——"换个写法"不能重置周期
//   2. 跨阈值触发一次并重置计数（下一周期从零开始）；pending 期间不重复触发
//   3. 时间阈值独立生效（长耗时少回合也触发）
//   4. 文案只提供周期事实和简短建议，不重复原文/工具结果/预算或宣判完成
//   5. 归一化全量防御；env 可调可关
import assert from 'node:assert/strict';
import {
  advanceGoalReview,
  DEFAULT_GOAL_REVIEW_POLICY,
  type GoalReviewState,
  normalizeGoalReviewState,
  renderGoalReviewReminder,
  resolveGoalReviewPolicy,
} from '../src/harness/goal-review.js';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

const P = { everyTurns: 3, everyMs: 10_000_000 };
const empty = (): GoalReviewState => normalizeGoalReviewState(undefined);

check('按全部工具回合计数（写入/失败/中性都不重置周期）', () => {
  let state = empty();
  const turns: Array<{ durationMs: number }> = [
    { durationMs: 100 },
    { durationMs: 100 },
    { durationMs: 100 },
  ];
  const reminders = turns.map((turn) => {
    const step = advanceGoalReview(state, turn, P);
    state = step.state;
    return step.reminder;
  });
  assert.equal(reminders[0], undefined);
  assert.equal(reminders[1], undefined);
  assert.ok(reminders[2], '第 3 个回合触发审查');
  assert.equal(reminders[2]?.toolTurns, 3);
  assert.equal(state.toolTurns, 0, '触发即重置：下一周期从零开始');
  assert.equal(state.review, 'pending');
});

check('pending 未投递期间不重复触发（故障循环里不连珠提醒）', () => {
  let state = empty();
  for (let i = 0; i < 3; i++) state = advanceGoalReview(state, { durationMs: 0 }, P).state;
  assert.equal(state.review, 'pending');
  const again = advanceGoalReview(state, { durationMs: 0 }, P);
  assert.equal(again.reminder, undefined, 'pending 期间不触发');
  assert.equal(again.state.toolTurns, 0, '也不累计');
});

check('投递后（delivered）重新开始下一周期', () => {
  let state: GoalReviewState = { toolTurns: 0, activeMs: 0, review: 'delivered' };
  const first = advanceGoalReview(state, { durationMs: 0 }, P);
  assert.equal(first.reminder, undefined, 'delivered 不是 pending，周期重新计数');
  assert.equal(first.state.toolTurns, 1);
  state = advanceGoalReview(first.state, { durationMs: 0 }, P).state;
  const third = advanceGoalReview(state, { durationMs: 0 }, P);
  assert.ok(third.reminder, '再满 3 回合再次触发');
});

check('时间阈值独立生效（长耗时少回合也触发）', () => {
  const state = advanceGoalReview(
    empty(),
    { durationMs: 60_000 },
    { everyTurns: 100, everyMs: 30_000 },
  );
  assert.ok(state.reminder, '单回合 60s 超过 30s 阈值即触发');
  assert.equal(state.reminder?.activeMs, 60_000);
});

check('坏 durationMs 收敛到 0（NaN/负数不污染周期）', () => {
  const state = advanceGoalReview(empty(), { durationMs: Number.NaN }, P);
  assert.equal(state.state.activeMs, 0);
  assert.equal(state.state.toolTurns, 1);
});

check('归一化：坏字段收敛到安全值', () => {
  assert.deepEqual(normalizeGoalReviewState(undefined), {
    toolTurns: 0,
    activeMs: 0,
    review: 'none',
  });
  assert.deepEqual(normalizeGoalReviewState(null), { toolTurns: 0, activeMs: 0, review: 'none' });
  assert.deepEqual(normalizeGoalReviewState({ toolTurns: -5, activeMs: 'x', review: 'bad' }), {
    toolTurns: 0,
    activeMs: 0,
    review: 'none',
  });
  assert.deepEqual(normalizeGoalReviewState({ toolTurns: 4, activeMs: 99, review: 'pending' }), {
    toolTurns: 4,
    activeMs: 99,
    review: 'pending',
  });
});

check('常规回顾只保留周期事实和决策建议，不重复目标与结果', () => {
  const text = renderGoalReviewReminder({
    toolTurns: 10,
    activeMs: 200_000,
  });
  assert.match(text, /\[Periodic goal review\]/);
  assert.match(text, /10 tool turns over 200 seconds/);
  assert.match(text, /change implementation, verification or the answer/);
  assert.doesNotMatch(
    text,
    /Original user goal|Most recent tool result|Remaining execution budget|Long tasks/,
  );
});

check('预算关闭时文案整段省略剩余预算（不虚构无限）', () => {
  const text = renderGoalReviewReminder({
    toolTurns: 3,
    activeMs: 0,
  });
  assert.doesNotMatch(text, /Remaining execution budget/);
  assert.doesNotMatch(text, /unlimited/i);
});

check('env：默认值 / off 关闭 / 阈值可覆盖', () => {
  assert.deepEqual(resolveGoalReviewPolicy({}), DEFAULT_GOAL_REVIEW_POLICY);
  assert.equal(resolveGoalReviewPolicy({ PAYASO_GOAL_REVIEW: 'off' }), false);
  assert.deepEqual(
    resolveGoalReviewPolicy({ PAYASO_GOAL_REVIEW_TURNS: '5', PAYASO_GOAL_REVIEW_MS: '60000' }),
    {
      everyTurns: 5,
      everyMs: 60_000,
    },
  );
  // 非法值回退默认，不静默改变行为方向
  assert.deepEqual(
    resolveGoalReviewPolicy({ PAYASO_GOAL_REVIEW_TURNS: 'abc' }),
    DEFAULT_GOAL_REVIEW_POLICY,
  );
});

console.log(`\ngoal-review 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
