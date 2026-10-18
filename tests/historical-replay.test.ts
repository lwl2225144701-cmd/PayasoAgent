// 套件: 历史 Run 回放 + 正常长任务覆盖验证（确定性，无 LLM）
// 用法: node --import tsx tests/historical-replay.test.ts
//
// 为什么必须有这个套件：纯策略测试证明"规则按设计工作"，但证明不了
// **覆盖范围**——对真实发生过的不收敛 Run，新机制是能兜住、还是只会
// 误报？对正常长任务，新机制是保持安静、还是吵闹？本套件用两类证据回答：
//
// A. 历史回放（fixture = 治理报告复盘的 Run ae568d19，43 次工具调用 /
//    29 次模型调用 / 2 次失败，从 ~/.payaso/payaso.db 事件表一次性提取，
//    之后完全离线，不依赖活库）：
//    - repeat-call：0 次提醒——真实 Run 最长连续相同调用仅 1 次，
//      新统计不在这个 Run 上误报（与治理报告的回放结论一致）；
//    - goal-review：默认阈值下触发 4 次——旧机制（只读 8 回合/120s、
//      同参数重复）对这个 Run 全部脱靶，新机制按全部工具回合能兜住；
//    - budget：maxModelCalls=20 时第 20 次模型调用即耗尽——这个 15 分
//      38 秒的 Run 会被机械边界挡住，而不是跑到调用方耐心耗尽。
//
// B. 正常长任务（合成的合法多步工作：不同文件、不同命令、合法轮询）：
//    - repeat-call 0 提醒（换参数是合法工作，不是不收敛）；
//    - goal-review 按周期触发但不阻断，任务走到终态；
//    - 预算默认关闭时零事件（默认行为不变）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  advanceExecutionBudget,
  type ExecutionBudgetPolicy,
  type ExecutionBudgetState,
  type ExecutionBudgetUsage,
} from '../src/harness/execution-policy.js';
import {
  advanceGoalReview,
  type GoalReviewState,
  normalizeGoalReviewState,
} from '../src/harness/goal-review.js';
import {
  advanceRepeatCall,
  DEFAULT_REPEAT_CALL_POLICY,
  type RepeatCallState,
  type ToolInvocationObservation,
} from '../src/harness/repeat-call-policy.js';

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

interface FixtureCall {
  tool: string;
  args: Record<string, unknown>;
  disposition: ToolInvocationObservation['disposition'];
}
interface Fixture {
  runId: string;
  source: string;
  modelCalls: number;
  outputTokens: number;
  toolCalls: FixtureCall[];
}

const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), 'tests/fixtures/historical-run-ae568d19.json'),
    'utf-8',
  ),
) as Fixture;

check('fixture 完整性（与治理报告记录一致）', () => {
  assert.equal(fixture.runId, 'ae568d19-c0bb-4124-9237-85e278083269');
  assert.equal(fixture.toolCalls.length, 43, '43 次工具调用');
  assert.equal(fixture.modelCalls, 29, '29 次模型调用');
  assert.equal(fixture.outputTokens, 60824, '60824 输出 token');
  assert.equal(
    fixture.toolCalls.filter((c) => c.disposition === 'failed').length,
    2,
    '2 次失败调用（tool_error 配对）',
  );
});

// ---- A1. 历史回放：repeat-call 零误报 ----
check('历史回放：repeat-call 0 提醒（真实 Run 不误报）', () => {
  let state: RepeatCallState | undefined;
  const reminders: number[] = [];
  for (const call of fixture.toolCalls) {
    const step = advanceRepeatCall(
      state,
      { tool: call.tool, args: call.args, disposition: call.disposition, attempts: 1 },
      DEFAULT_REPEAT_CALL_POLICY,
    );
    state = step.state;
    if (step.reminder) reminders.push(step.reminder.level);
  }
  assert.deepEqual(reminders, [], '该 Run 最长连续相同调用仅 1 次，不应有任何提醒');
  assert.ok(state && state.count >= 1, '计数仍在推进（最后一次调用的连续性）');
});

// ---- A2. 历史回放：goal-review 能兜住（旧机制全部脱靶的那个 Run）----
check('历史回放：goal-review 默认阈值触发 4 次（43 回合 / 10）', () => {
  let state: GoalReviewState = normalizeGoalReviewState(undefined);
  let reviews = 0;
  for (let i = 0; i < fixture.toolCalls.length; i++) {
    const step = advanceGoalReview(
      state,
      { durationMs: 20_000 },
      {
        everyTurns: 10,
        everyMs: 10_000_000, // 隔离回合维度
      },
    );
    state = step.state;
    if (step.reminder) {
      reviews++;
      // 回放要模拟真实时序：提醒注入后由 acknowledge 落 delivered，
      // 否则 pending 期间不重复触发，只能数到第 1 次。
      state = { ...state, review: 'delivered' };
    }
  }
  assert.equal(reviews, 4, '43 个工具回合 → 4 次周期审查');
  // 第 4 次审查（第 40 回合）投递后周期重启，41-43 回合在新周期计数中
  assert.equal(state.review, 'none');
  assert.equal(state.toolTurns, 3);
});

// ---- A3. 历史回放：预算在机械边界挡住这个 Run ----
check('历史回放：maxModelCalls=20 时第 20 次模型调用耗尽', () => {
  const policy: ExecutionBudgetPolicy = {
    maxModelCalls: 20,
    warnRatio: 0.7,
    convergeRatio: 0.9,
  };
  let state: ExecutionBudgetState = {
    usage: { modelCalls: 0, outputTokens: 0, activeMs: 0 },
    warned: { modelCalls: false, outputTokens: false, activeMs: false },
    converged: { modelCalls: false, outputTokens: false, activeMs: false },
    exhausted: [],
  };
  const levels: string[] = [];
  for (let i = 1; i <= fixture.modelCalls; i++) {
    const usage: ExecutionBudgetUsage = { modelCalls: 1, outputTokens: 0, activeMs: 30_000 };
    const decision = advanceExecutionBudget(state, usage, policy);
    state = decision.state;
    if (decision.buckets.length > 0) levels.push(decision.level);
  }
  assert.deepEqual(
    levels,
    ['warn', 'converge', 'exhausted'],
    '第 14 次（70%）预警、第 18 次（90%）收敛、第 20 次耗尽',
  );
  assert.equal(state.usage.modelCalls, 29, '回放跑完整个 Run 的累计');
});

check('历史回放：maxOutputTokens=50000 也会在输出维度耗尽', () => {
  const policy: ExecutionBudgetPolicy = {
    maxOutputTokens: 50_000,
    warnRatio: 0.7,
    convergeRatio: 0.9,
  };
  let state: ExecutionBudgetState = {
    usage: { modelCalls: 0, outputTokens: 0, activeMs: 0 },
    warned: { modelCalls: false, outputTokens: false, activeMs: false },
    converged: { modelCalls: false, outputTokens: false, activeMs: false },
    exhausted: [],
  };
  const levels: string[] = [];
  const perCall = Math.floor(fixture.outputTokens / fixture.modelCalls);
  for (let i = 1; i <= fixture.modelCalls; i++) {
    const decision = advanceExecutionBudget(
      state,
      { modelCalls: 1, outputTokens: perCall, activeMs: 0 },
      policy,
    );
    state = decision.state;
    if (decision.buckets.length > 0) levels.push(decision.level);
  }
  assert.deepEqual(
    levels,
    ['warn', 'converge', 'exhausted'],
    '输出 token 维度同样兜底（70%/90%/100% 三档）',
  );
});

// ---- B. 正常长任务：合法多步工作零误报、不阻断 ----
check('正常长任务：15 回合不同文件/命令/轮询的合法工作零重复提醒', () => {
  // 模拟一个正常的"读代码 → 改代码 → 跑测试 → 轮询 CI"长任务：
  // 参数全都不同（合法换参数），只有最后一组是同一个轮询调用 ×3。
  const plan: FixtureCall[] = [];
  for (let i = 0; i < 4; i++)
    plan.push({ tool: 'read', args: { path: `src/mod-${i}.ts` }, disposition: 'executed' });
  for (let i = 0; i < 3; i++)
    plan.push({ tool: 'grep', args: { pattern: `symbol-${i}` }, disposition: 'executed' });
  for (let i = 0; i < 2; i++)
    plan.push({
      tool: 'edit',
      args: { path: `src/mod-${i}.ts`, oldText: `a${i}`, newText: `b${i}` },
      disposition: 'executed',
    });
  for (let i = 0; i < 2; i++)
    plan.push({
      tool: 'shell',
      args: { command: `npm test -- --grep suite-${i}` },
      disposition: 'executed',
    });
  for (let i = 0; i < 2; i++)
    plan.push({ tool: 'read', args: { path: `test/report-${i}.md` }, disposition: 'executed' });
  // 合法轮询：同一调用连续 2 次（未到阈值 3）
  for (let i = 0; i < 2; i++)
    plan.push({
      tool: 'shellJob',
      args: { action: 'wait', jobId: 'ci-1' },
      disposition: 'executed',
    });

  let state: RepeatCallState | undefined;
  const reminders: number[] = [];
  for (const call of plan) {
    const step = advanceRepeatCall(
      state,
      { tool: call.tool, args: call.args, disposition: call.disposition, attempts: 1 },
      DEFAULT_REPEAT_CALL_POLICY,
    );
    state = step.state;
    if (step.reminder) reminders.push(step.reminder.level);
  }
  assert.deepEqual(reminders, [], '合法换参数 + 未达阈值的轮询 → 零提醒');
});

check('正常长任务：目标审查按周期触发但不阻断（15 回合 → 1 次审查）', () => {
  let state: GoalReviewState = normalizeGoalReviewState(undefined);
  let reviews = 0;
  for (let i = 0; i < 15; i++) {
    const step = advanceGoalReview(
      state,
      { durationMs: 8_000 },
      { everyTurns: 10, everyMs: 10_000_000 },
    );
    state = step.state;
    if (step.reminder) reviews++;
    // 投递后 acknowledge：delivered 状态进入下一周期
    if (step.reminder) state = { ...state, review: 'delivered' };
  }
  assert.equal(reviews, 1, '第 10 回合触发一次');
  assert.equal(state.toolTurns, 5, '审查后周期重新计数（15 - 10）');
});

check('正常长任务：预算默认关闭时三个策略零事件', () => {
  // 未配置任何上限 → resolveExecutionBudgetPolicy 返回 false → Harness 不启用
  // （行为与引入前一致）。这里直接验证策略函数在无上限时的空转语义。
  const policy: ExecutionBudgetPolicy = { warnRatio: 0.7, convergeRatio: 0.9 };
  let state: ExecutionBudgetState = {
    usage: { modelCalls: 0, outputTokens: 0, activeMs: 0 },
    warned: { modelCalls: false, outputTokens: false, activeMs: false },
    converged: { modelCalls: false, outputTokens: false, activeMs: false },
    exhausted: [],
  };
  for (let i = 0; i < 100; i++) {
    const decision = advanceExecutionBudget(
      state,
      { modelCalls: 1, outputTokens: 1000, activeMs: 5_000 },
      policy,
    );
    state = decision.state;
    assert.equal(decision.level, 'none', '无上限 → 永远 none');
  }
});

console.log(`\nhistorical-replay 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
