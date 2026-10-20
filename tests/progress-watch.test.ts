// 事实型进度闭环（计划 §8 / P01–P06）：
// - 纯策略：连续 4 回合无新增有效事实且累计活跃 ≥120s 才提醒；同周期最多 2 次；
//   新增必要证据 / 真实修改 / 新版本检查结论立即关闭周期。
// - Harness：提醒只投影到尾部 [Context]，不污染 canonical transcript；
//   resume 后不重复投递，投影有界。
// - 事实边界：失败/拒绝/无修改/updatePlan 不算成果；无结构化事实的工具停止
//   机械停滞推断（避免把正常业务动作误判为停滞）。
import assert from 'node:assert/strict';
import { DefaultContextHarness } from '../src/harness/context-harness.js';
import {
  advanceProgressWatch,
  createProgressWatchState,
  hasNewEvidence,
  normalizeProgressWatchState,
  PROGRESS_WATCH_MAX_REMINDERS,
  PROGRESS_WATCH_MIN_ACTIVE_MS,
  PROGRESS_WATCH_TURNS,
  renderProgressWatchReminder,
  type ToolTurnFacts,
} from '../src/harness/progress-watch.js';
import type { ChatMessage } from '../src/llm/llm.js';

let failures = 0;
let passes = 0;
// 用例串行执行（含异步 Harness 投影）：同步函数立即跑，Promise 入队后统一 await，
// 避免异步断言失败被吞掉而错误地打印 PASS。
const queue: Array<() => Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  queue.push(async () => {
    try {
      await fn();
      passes++;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      failures++;
      console.log(`  [FAIL] ${name}`);
      console.log(`         ${(err as Error).message}`);
    }
  });
}

const facts = (patch: Partial<ToolTurnFacts> = {}): ToolTurnFacts => ({
  coverage: 'complete',
  newReadCount: 0,
  changedFileCount: 0,
  newCheckCount: 0,
  repeatCount: 0,
  failedCount: 0,
  neutralOnly: false,
  evidenceIds: [],
  ...patch,
});
const turnMs = PROGRESS_WATCH_MIN_ACTIVE_MS / PROGRESS_WATCH_TURNS;
const noProgress = facts({ repeatCount: 1, evidenceIds: ['work/index.html'] });
const newRead = facts({ newReadCount: 1, evidenceIds: ['work/index.html'] });

/** 连续推进 n 回合，返回最终状态与每回合的提醒等级。 */
function run(
  state = createProgressWatchState(),
  n = PROGRESS_WATCH_TURNS,
  input = noProgress,
): { state: ReturnType<typeof createProgressWatchState>; reminds: string[] } {
  const reminds: string[] = [];
  let current = state;
  for (let i = 0; i < n; i++) {
    const decision = advanceProgressWatch(current, input, turnMs);
    current = decision.state;
    if (decision.remind !== 'none') reminds.push(decision.remind);
  }
  return { state: current, reminds };
}

console.log('\n== P01 阈值：4 回合无新增 + 120s 才提醒 ==');
test('P01 三回合（90s）不提醒，第四回合达到 120s 触发一次 warn', () => {
  const three = run(createProgressWatchState(), PROGRESS_WATCH_TURNS - 1);
  assert.deepEqual(three.reminds, [], '时长与回合都未达阈值时不能提醒');
  assert.equal(three.state.cycleOpen, true, '已进入观察周期');
  const four = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  assert.deepEqual(four.reminds, ['warn'], '阈值命中只提醒一次');
  assert.equal(four.state.reminders, 1);
  assert.equal(four.state.level, 'warn');
});
test('P01 交付只更新投递状态：继续计量，不当成已推进', () => {
  const first = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const after = advanceProgressWatch(first.state, noProgress, turnMs);
  assert.equal(after.remind, 'none', '同周期第二次不立即重发');
  assert.equal(after.state.noProgressTurns, PROGRESS_WATCH_TURNS + 1, '送达后继续累计回合');
  assert.equal(after.state.cycleOpen, true, '送达不关闭周期');
});

console.log('\n== P02 升级与关闭：同周期最多 2 次 ==');
test('P02 提醒后再 4 回合无新增 → 升级一次，且不再有第三次', () => {
  const warned = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const escalated = run(warned.state, PROGRESS_WATCH_TURNS);
  assert.deepEqual(escalated.reminds, ['escalate'], '第 8 回合升级一次');
  assert.equal(escalated.state.reminders, PROGRESS_WATCH_MAX_REMINDERS);
  const beyond = run(escalated.state, PROGRESS_WATCH_TURNS * 3);
  assert.deepEqual(beyond.reminds, [], '同周期不再产生第三次提醒');
});
test('P02 出现新增必要证据 → 立即关闭周期（epoch+1、计数清零）', () => {
  const warned = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const closed = advanceProgressWatch(warned.state, newRead, turnMs);
  assert.equal(closed.remind, 'none');
  assert.equal(closed.state.cycleOpen, false);
  assert.equal(closed.state.noProgressTurns, 0);
  assert.equal(closed.state.activeMs, 0);
  assert.equal(closed.state.reminders, 0);
  assert.ok(closed.state.epoch > warned.state.epoch, '事实纪元前移');
});

console.log('\n== P03 什么算新增证据 ==');
test('P03 新范围读取 / 真实修改 / 新检查结论都算新增', () => {
  assert.equal(hasNewEvidence(facts({ newReadCount: 1 })), true);
  assert.equal(hasNewEvidence(facts({ changedFileCount: 1 })), true);
  assert.equal(hasNewEvidence(facts({ newCheckCount: 1 })), true);
  assert.equal(hasNewEvidence(facts({ repeatCount: 3, evidenceIds: ['a'] })), false);
});
test('P03 同版本重复读取与重复检查不关闭周期（不算新成果）', () => {
  const warned = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const repeated = advanceProgressWatch(warned.state, facts({ repeatCount: 2 }), turnMs);
  assert.equal(repeated.state.cycleOpen, true, '重复不是推进');
  assert.equal(repeated.state.reminders, 1, '周期仍在同一提醒预算内');
});

console.log('\n== P04 不冒充成果的回合 ==');
test('P04 失败/拒绝/无修改不计成果，也不清零未推进计数', () => {
  const warned = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const failed = advanceProgressWatch(
    warned.state,
    facts({ coverage: 'partial', failedCount: 2, repeatCount: 1 }),
    turnMs,
  );
  assert.equal(failed.state.noProgressTurns, PROGRESS_WATCH_TURNS + 1, '失败回合继续累计');
  assert.equal(failed.remind, 'none');
});
test('P04 updatePlan（neutralOnly）保留计数，但不累积回合与时长', () => {
  const two = run(createProgressWatchState(), 2);
  const neutral = advanceProgressWatch(
    two.state,
    facts({ neutralOnly: true, coverage: 'complete' }),
    turnMs * 10,
  );
  assert.deepEqual(neutral.state, two.state, '中性回合不改变停滞状态');
  assert.equal(neutral.remind, 'none');
});
test('P04 无结构化事实（unknown）停止机械停滞推断', () => {
  const two = run(createProgressWatchState(), 2);
  const unknown = advanceProgressWatch(
    two.state,
    facts({ coverage: 'unknown', repeatCount: 1 }),
    turnMs,
  );
  assert.equal(unknown.state.noProgressTurns, 0, '未知活动重置连续性');
  assert.equal(unknown.state.activeMs, 0);
  assert.equal(unknown.remind, 'none');
});

console.log('\n== P05 正常深入阅读不误触发 ==');
test('P05 每回合都有新增读取 → 任意多回合都不提醒', () => {
  const deep = run(createProgressWatchState(), 20, newRead);
  assert.deepEqual(deep.reminds, []);
  assert.equal(deep.state.reminders, 0);
});
test('P05 状态恢复对非法输入 fail-closed', () => {
  assert.deepEqual(normalizeProgressWatchState(undefined), createProgressWatchState());
  const clamped = normalizeProgressWatchState({
    noProgressTurns: -3,
    activeMs: Number.NaN,
    reminders: 99,
  });
  assert.equal(clamped.noProgressTurns, 0, '非法回合数归零');
  assert.equal(clamped.activeMs, 0, '非法时长归零');
  assert.equal(
    clamped.reminders,
    PROGRESS_WATCH_MAX_REMINDERS,
    '提醒次数被夹到上限（不因旧快照多花提醒）',
  );
  const restored = normalizeProgressWatchState({
    noProgressTurns: 2,
    activeMs: 60_000,
    reminders: 1,
  });
  assert.equal(restored.noProgressTurns, 2);
  assert.equal(restored.reminders, 1);
});

console.log('\n== P06 投影：合并、有界、resume 不重复 ==');
test('P06 提醒文案有界：证据引用最多 6 条，含事实依据', () => {
  const { state } = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const text = renderProgressWatchReminder(
    {
      state,
      remind: 'warn',
      reason: '连续 4 个已完成工具回合没有新增有效事实（累计活跃 120s）',
    },
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  );
  assert.match(text, /\[Progress watch · review\]/);
  assert.match(text, /累计活跃 120s/);
  const listed = text.split('Known evidence: ')[1] ?? '';
  assert.equal(listed.trim().split(',').length, 6, '证据引用有界（6 条）');
  assert.equal(renderProgressWatchReminder({ state, remind: 'none' }), '');
});

const MODEL = { baseUrl: 'https://provider.example/v1', apiKey: 'test-key', model: 'test-model' };
const pad = {
  task: 'inspect',
  completedSteps: [],
  failedSteps: [],
  invalidSteps: [],
  nextStep: null,
  lastResult: '',
};
const contextText = (messages: Array<{ role: string; content: unknown }>): string =>
  String(messages.find((m) => String(m.content).startsWith('[Context]'))?.content ?? '');

function harness(): DefaultContextHarness {
  return new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelConfig: MODEL,
    progressReminder: false,
    goalReview: false,
    progressWatch: true,
  });
}

test('P06 Harness 只把进度审查放进尾部 [Context]，不变量测试', async () => {
  const h = harness();
  for (let i = 0; i < PROGRESS_WATCH_TURNS - 1; i++) {
    assert.equal(
      h.observeToolTurn({ activity: 'read', durationMs: turnMs, facts: noProgress }),
      undefined,
      '未达阈值的回合不产生观察',
    );
  }
  const observations = h.observeToolTurn({
    activity: 'read',
    durationMs: turnMs,
    facts: { ...noProgress, evidenceIds: ['work/index.html', 'work/app.css'] },
  });
  assert.equal(observations?.progressWatch?.remind, 'warn');
  const transcript: ChatMessage[] = h.createTranscript('检查页面');
  const original = structuredClone(transcript);
  const view = await h.prepareTurn(transcript, pad, []);
  const text = contextText(view.messages);
  assert.match(text, /\[Progress watch · review\]/);
  assert.match(text, /Known evidence: work\/index\.html, work\/app\.css/);
  assert.deepEqual(transcript, original, '提醒不污染 canonical transcript');
  assert.equal(
    view.messages.filter((m) => String(m.content).startsWith('[Context]')).length,
    1,
    '提醒合并进唯一一条尾部 [Context]，不新增第二条同义消息',
  );
});
test('P06 resume：投递状态随 checkpoint 恢复，不重复投递', async () => {
  const h = harness();
  h.observeToolTurn({ activity: 'read', durationMs: turnMs, facts: noProgress });
  for (let i = 1; i < PROGRESS_WATCH_TURNS; i++) {
    h.observeToolTurn({ activity: 'read', durationMs: turnMs, facts: noProgress });
  }
  const saved = h.snapshotState();
  const restored = harness();
  restored.restoreState(saved);
  const transcript: ChatMessage[] = restored.createTranscript('检查页面');
  const first = await restored.prepareTurn(transcript, pad, []);
  assert.match(contextText(first.messages), /\[Progress watch · review\]/);
  restored.acknowledgeConvergenceReminders();
  const second = await restored.prepareTurn(transcript, pad, []);
  assert.doesNotMatch(
    contextText(second.messages),
    /\[Progress watch · review\]/,
    '提醒只投递一次',
  );
  // 恢复后继续推进：升级预算不被重置。
  const next = restored.observeToolTurn({
    activity: 'read',
    durationMs: turnMs,
    facts: noProgress,
  });
  assert.equal(next, undefined, '同一周期内不重复提醒');
});
test('P06 与目标审查同时命中时合并投影，不叠加同类提示', async () => {
  const h = new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelConfig: MODEL,
    progressReminder: false,
    goalReview: { everyTurns: 1, everyMs: 1_000_000 },
    progressWatch: true,
  });
  // 第 1 回合目标审查命中（everyTurns=1）后进入 pending；进度审查在第 4 回合命中。
  const firstTurn = h.observeToolTurn({
    activity: 'read',
    durationMs: turnMs,
    goal: '检查页面',
    recentResult: 'ok',
    facts: noProgress,
  });
  assert.ok(firstTurn?.goalReview, '目标审查命中');
  let observations: ReturnType<typeof h.observeToolTurn> | undefined;
  for (let i = 1; i < PROGRESS_WATCH_TURNS; i++) {
    observations = h.observeToolTurn({
      activity: 'read',
      durationMs: turnMs,
      goal: '检查页面',
      recentResult: 'ok',
      facts: noProgress,
    });
  }
  assert.ok(observations?.progressWatch, '进度审查同时命中');
  const text = contextText((await h.prepareTurn(h.createTranscript('检查页面'), pad, [])).messages);
  assert.match(text, /\[Periodic goal review\]/);
  assert.match(text, /\[Progress watch · review\]/);
});
test('P06 环境开关关闭进度审查（PAYASO_PROGRESS_WATCH=off）', () => {
  const previous = process.env.PAYASO_PROGRESS_WATCH;
  try {
    process.env.PAYASO_PROGRESS_WATCH = 'off';
    const h = harness();
    for (let i = 0; i < PROGRESS_WATCH_TURNS * 2; i++) {
      assert.equal(
        h.observeToolTurn({ activity: 'read', durationMs: turnMs, facts: noProgress }),
        undefined,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.PAYASO_PROGRESS_WATCH;
    else process.env.PAYASO_PROGRESS_WATCH = previous;
  }
});

for (const runCase of queue) await runCase();

console.log('========================================================');
console.log(`汇总: ${passes} PASS / ${failures} FAIL`);
if (failures > 0) {
  console.log('验收：事实型进度闭环存在失败用例 ✗');
  process.exit(1);
}
console.log('验收：阈值、升级上限、事实边界、投影与 resume 均成立 ✓');
