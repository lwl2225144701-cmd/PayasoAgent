// 套件: 历史 Run 回放 + 正常长任务覆盖验证（确定性，无 LLM）
// 用法: node --import tsx tests/historical-replay.test.ts
//
// 为什么必须有这个套件：纯策略测试证明"规则按设计工作"，但证明不了
// **覆盖范围**——对真实发生过的不收敛 Run，新机制是能兜住、还是只会
// 误报？对正常长任务，新机制是保持安静、还是吵闹？本套件用两类证据回答：
//
// A. 历史回放（fixture = 治理报告复盘的 Run ae568d19，从 ~/.payaso/payaso.db
//    事件表一次性提取后完全离线）。**回合口径与真实执行一致**：fixture 按
//    llm_call 边界划分回合——一轮模型响应后的多个工具执行完才计一个工具
//    回合（与 runAgent 调用 observeToolTurn 的时序相同）。该 Run 共 29 个模型
//    回合，其中 28 个含工具调用（43 次工具调用分布其中）：
//    - repeat-call：0 次提醒——真实 Run 最长连续相同调用仅 1 次，
//      新统计不在这个 Run 上误报（与治理报告的回放结论一致）；
//    - goal-review：默认阈值（10 回合）下触发 **2 次**（第 10、20 个工具
//      回合）——旧机制（只读 8 回合/120s、同参数重复）对这个 Run 全部脱靶；
//    - budget：maxModelCalls=20 时**执行在第 20 个回合边界停止**——准入判定
//      拦住后续 9 个回合（不是只打一个 exhausted 标记继续跑），这正是
//      "模型即使忽略提醒也无法继续无限调用"的机械证明。
//
// B. 正常长任务（合成的合法多步工作）：15 个回合不同文件/命令/合法轮询，
//    repeat-call 0 提醒、goal-review 第 10 回合触发 1 次且不阻断。
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
interface FixtureTurn {
  iteration: number;
  durationMs: number;
  outputTokens: number;
  calls: FixtureCall[];
}
interface Fixture {
  runId: string;
  source: string;
  modelCalls: number;
  outputTokens: number;
  turns: FixtureTurn[];
}

const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), 'tests/fixtures/historical-run-ae568d19.json'),
    'utf-8',
  ),
) as Fixture;

const allCalls: FixtureCall[] = fixture.turns.flatMap((turn) => turn.calls);
const toolTurns = fixture.turns.filter((turn) => turn.calls.length > 0);

function freshBudgetState(): ExecutionBudgetState {
  return {
    usage: { modelCalls: 0, outputTokens: 0, activeMs: 0 },
    warned: { modelCalls: false, outputTokens: false, activeMs: false },
    converged: { modelCalls: false, outputTokens: false, activeMs: false },
    exhausted: [],
  };
}

check('fixture 完整性（与治理报告记录一致）', () => {
  assert.equal(fixture.runId, 'ae568d19-c0bb-4124-9237-85e278083269');
  assert.equal(fixture.turns.length, 29, '29 个模型回合（llm_call 边界）');
  assert.equal(toolTurns.length, 28, '28 个含工具调用的回合');
  assert.equal(allCalls.length, 43, '43 次工具调用');
  assert.equal(fixture.modelCalls, 29, '29 次模型调用');
  assert.equal(fixture.outputTokens, 60824, '60824 输出 token');
  assert.equal(
    allCalls.filter((c) => c.disposition === 'failed').length,
    2,
    '2 次失败调用（tool_error 配对）',
  );
});

// ---- A1. 历史回放：repeat-call 零误报（按真实调用顺序）----
check('历史回放：repeat-call 0 提醒（真实 Run 不误报）', () => {
  let state: RepeatCallState | undefined;
  const reminders: number[] = [];
  for (const call of allCalls) {
    const step = advanceRepeatCall(
      state,
      { tool: call.tool, args: call.args, disposition: call.disposition, attempts: 1 },
      DEFAULT_REPEAT_CALL_POLICY,
    );
    state = step.state;
    if (step.reminder) reminders.push(step.reminder.level);
  }
  assert.deepEqual(reminders, [], '该 Run 最长连续相同调用仅 1 次，不应有任何提醒');
});

// ---- A2. 历史回放：goal-review 按真实工具回合触发 ----
check('历史回放：goal-review 默认阈值触发 2 次（28 个工具回合 / 10）', () => {
  let state: GoalReviewState = normalizeGoalReviewState(undefined);
  const reviewTurns: number[] = [];
  for (const turn of toolTurns) {
    const step = advanceGoalReview(
      state,
      { durationMs: turn.durationMs },
      {
        everyTurns: 10,
        everyMs: 10_000_000, // 隔离回合维度
      },
    );
    state = step.state;
    if (step.reminder) {
      reviewTurns.push(step.reminder.toolTurns);
      // 真实时序：提醒注入后由 acknowledge 落 delivered，周期才能继续
      state = { ...state, review: 'delivered' };
    }
  }
  // reminder.toolTurns 是**周期内**计数（触发即重置），两个周期都报 10
  assert.deepEqual(reviewTurns, [10, 10], '第 10、20 个工具回合各触发一次审查');
});

// ---- A3. 历史回放：预算在执行边界停止（不是只打标记）----
check('历史回放：maxModelCalls=20 时执行在第 20 回合边界停止', () => {
  const policy: ExecutionBudgetPolicy = { maxModelCalls: 20, warnRatio: 0.7, convergeRatio: 0.9 };
  let state = freshBudgetState();
  const levels: string[] = [];
  let executedTurns = 0;
  let stopped = false;
  for (const turn of fixture.turns) {
    // 准入判定（与 agent.ts 迭代顶部一致）：exhausted 即停止新工作
    if (state.exhausted.length > 0) {
      stopped = true;
      break;
    }
    executedTurns += 1;
    const usage: ExecutionBudgetUsage = {
      modelCalls: 1,
      outputTokens: turn.outputTokens,
      activeMs: turn.durationMs,
    };
    const decision = advanceExecutionBudget(state, usage, policy);
    state = decision.state;
    if (decision.buckets.length > 0) levels.push(decision.level);
  }
  assert.equal(executedTurns, 20, '只执行了 20 个回合就被准入拦下');
  assert.equal(stopped, true, '执行在边界停止，不是跑完 29 回合再打标记');
  assert.equal(fixture.turns.length - executedTurns, 9, '后续 9 个回合未执行');
  assert.deepEqual(
    levels,
    ['warn', 'converge', 'exhausted'],
    '第 14 次（70%）预警、第 18 次（90%）收敛、第 20 次耗尽',
  );
});

check('历史回放：maxActiveMs=300000 时执行在累计 5 分钟边界停止', () => {
  const policy: ExecutionBudgetPolicy = {
    maxActiveMs: 300_000,
    warnRatio: 0.7,
    convergeRatio: 0.9,
  };
  let state = freshBudgetState();
  const levels: string[] = [];
  let executedTurns = 0;
  let stopped = false;
  for (const turn of fixture.turns) {
    if (state.exhausted.length > 0) {
      stopped = true;
      break;
    }
    executedTurns += 1;
    const decision = advanceExecutionBudget(
      state,
      { modelCalls: 1, outputTokens: turn.outputTokens, activeMs: turn.durationMs },
      policy,
    );
    state = decision.state;
    if (decision.buckets.length > 0) levels.push(decision.level);
  }
  assert.ok(stopped, '时间维度同样在执行边界停止');
  assert.equal(executedTurns, 7, '第 7 回合（单回合 55s）跨过 300s 上限即停止');
  // 该回合一步跨过 90% 与 100% 两条线：advanceExecutionBudget 优先判 exhausted，
  // converge 档被跳过是正确行为（不会补播一个已被越过 intermediate 档）。
  assert.deepEqual(levels, ['warn', 'exhausted']);
});

check('历史回放：maxOutputTokens=50000 时输出维度在执行边界停止', () => {
  const policy: ExecutionBudgetPolicy = {
    maxOutputTokens: 50_000,
    warnRatio: 0.7,
    convergeRatio: 0.9,
  };
  let state = freshBudgetState();
  const levels: string[] = [];
  let executedTurns = 0;
  let stopped = false;
  for (const turn of fixture.turns) {
    if (state.exhausted.length > 0) {
      stopped = true;
      break;
    }
    executedTurns += 1;
    const decision = advanceExecutionBudget(
      state,
      { modelCalls: 1, outputTokens: turn.outputTokens, activeMs: turn.durationMs },
      policy,
    );
    state = decision.state;
    if (decision.buckets.length > 0) levels.push(decision.level);
  }
  assert.ok(stopped, '输出 token 维度同样兜底');
  assert.ok(executedTurns < fixture.turns.length);
  assert.deepEqual(levels, ['warn', 'converge', 'exhausted']);
});

// ---- B. 正常长任务：合法多步工作零误报、不阻断 ----
check('正常长任务：15 回合不同文件/命令/轮询的合法工作零重复提醒', () => {
  // 模拟一个正常的"读代码 → 改代码 → 跑测试 → 轮询 CI"长任务：
  // 参数全都不同（合法换参数），只有最后一组是同一个轮询调用 ×2（未到阈值 3）。
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
    if (step.reminder) {
      reviews++;
      state = { ...state, review: 'delivered' };
    }
  }
  assert.equal(reviews, 1, '第 10 回合触发一次');
  assert.equal(state.toolTurns, 5, '审查后周期重新计数（15 - 10）');
});

check('正常长任务：预算默认关闭时三个策略零事件', () => {
  // 未配置任何上限 → 策略函数空转（Harness 层 resolveExecutionBudgetPolicy
  // 返回 false，行为与引入前一致）。这里验证纯函数在无上限时的语义。
  const policy: ExecutionBudgetPolicy = { warnRatio: 0.7, convergeRatio: 0.9 };
  let state = freshBudgetState();
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
