// 套件: 执行预算策略（Harness 纯函数，无 LLM）
// 用法: node --import tsx tests/execution-policy.test.ts
// 验收：
//   1. 三类机械预算（模型调用数 / 输出 token / 活动时长）独立累计与判定
//   2. 70% 预警 / 90% 收敛审查 / 100% 耗尽三级，且每级只投递一次
//   3. 同批事实跨多级时只报最高级（exhausted > converge > warn），buckets 仍列全
//   4. exhausted 一旦置位，后续 0 增量也稳定保持（幂等）
//   5. 未配置上限的维度不参与判定（默认行为与引入前一致）
//   6. 归一化全量防御：checkpoint 旧记录/手改数据不抛错、不出现负数/NaN
//   7. env 可调可关；非法上限（0/负数/NaN/Infinity）直接报错而非静默变无限
import assert from 'node:assert/strict';
import {
  advanceExecutionBudget,
  createExecutionBudgetState,
  DEFAULT_EXECUTION_BUDGET_POLICY,
  type ExecutionBudgetPolicy,
  type ExecutionBudgetState,
  type ExecutionBudgetUsage,
  executionBudgetBucketsFor,
  executionBudgetRatios,
  executionBudgetWouldExceed,
  normalizeExecutionBudgetState,
  renderExecutionBudgetReminder,
  resolveExecutionBudgetPolicy,
} from '../src/harness/execution-policy.js';

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

const P: ExecutionBudgetPolicy = { maxModelCalls: 10, ...DEFAULT_EXECUTION_BUDGET_POLICY };
const zero = (): ExecutionBudgetUsage => ({ modelCalls: 0, outputTokens: 0, activeMs: 0 });
const calls = (n: number): ExecutionBudgetUsage => ({ ...zero(), modelCalls: n });

/** 连续累计 n 次模型调用，返回最后一次的决策。 */
function observeCalls(n: number, policy: ExecutionBudgetPolicy = P): ExecutionBudgetState {
  let state = createExecutionBudgetState();
  for (let i = 0; i < n; i++) state = advanceExecutionBudget(state, calls(1), policy).state;
  return state;
}

// ---- 核心：三级阈值 ----

check('70% 预警：第 7 次调用跨过 0.7', () => {
  const d = advanceExecutionBudget(createExecutionBudgetState(), calls(7), P);
  assert.equal(d.level, 'warn');
  assert.deepEqual(d.buckets, ['modelCalls']);
  assert.equal(d.state.warned.modelCalls, true);
});

check('69% 未预警（0.7 是达到即触发）', () => {
  const d = advanceExecutionBudget(createExecutionBudgetState(), calls(6), P);
  assert.equal(d.level, 'none');
  assert.deepEqual(d.buckets, []);
});

check('90% 收敛审查：第 9 次调用跨过 0.9', () => {
  const d = advanceExecutionBudget(createExecutionBudgetState(), calls(9), P);
  assert.equal(d.level, 'converge');
  assert.equal(d.state.converged.modelCalls, true);
});

check('100% 耗尽：第 10 次调用', () => {
  const d = advanceExecutionBudget(createExecutionBudgetState(), calls(10), P);
  assert.equal(d.level, 'exhausted');
  assert.deepEqual(d.state.exhausted, ['modelCalls']);
});

check('level 粘滞单调不降，buckets 只在本轮新跨阈值时非空（不重复打扰）', () => {
  const levels: string[] = [];
  const bucketCounts: number[] = [];
  let state = createExecutionBudgetState();
  for (let i = 1; i <= 12; i++) {
    const d = advanceExecutionBudget(state, calls(1), P);
    state = d.state;
    levels.push(d.level);
    bucketCounts.push(d.buckets.length);
  }
  // level 是"当前预算状况"：跨过某档就一直保持，不会掉回 none。
  assert.deepEqual(levels, [
    'none',
    'none',
    'none',
    'none',
    'none',
    'none', // 1..6 未达 70%
    'warn',
    'warn', // 7 起进入 warn 档并保持
    'converge', // 9 起进入收敛档
    'exhausted',
    'exhausted',
    'exhausted', // 10 起耗尽并保持
  ]);
  // buckets 是"本轮发生了什么"：每档只在跨过的那一刻非空一次。
  assert.deepEqual(bucketCounts, [0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0]);
});

// ---- 核心：多桶与最高级 ----

check('同批事实跨多级时只报最高级，buckets 列全部跨阈值维度', () => {
  // 一步跨过 warn(7) 与 exhausted(10)：只报 exhausted，但 buckets 仍含 modelCalls。
  const d = advanceExecutionBudget(createExecutionBudgetState(), calls(10), P);
  assert.equal(d.level, 'exhausted');
  assert.deepEqual(d.buckets, ['modelCalls']);
});

check('三个维度独立判定（一个耗尽不等于全部耗尽）', () => {
  const policy: ExecutionBudgetPolicy = {
    maxModelCalls: 10,
    maxOutputTokens: 100,
    maxActiveMs: 1000,
    ...DEFAULT_EXECUTION_BUDGET_POLICY,
  };
  const d = advanceExecutionBudget(
    createExecutionBudgetState(),
    { modelCalls: 5, outputTokens: 95, activeMs: 500 },
    policy,
  );
  assert.equal(d.level, 'converge', 'outputTokens 95% 先触发收敛审查');
  assert.deepEqual(d.buckets, ['outputTokens']);
  assert.deepEqual(d.state.exhausted, []);
});

check('未配置上限的维度不参与判定（默认行为不变）', () => {
  const d = advanceExecutionBudget(
    createExecutionBudgetState(),
    { modelCalls: 999, outputTokens: 999_999, activeMs: 86_400_000 },
    { ...DEFAULT_EXECUTION_BUDGET_POLICY },
  );
  assert.equal(d.level, 'none');
  assert.deepEqual(d.buckets, []);
  assert.deepEqual(executionBudgetRatios(d.state, DEFAULT_EXECUTION_BUDGET_POLICY), []);
});

// ---- 核心：幂等与稳定性 ----

check('exhausted 后 0 增量仍稳定为 exhausted（决策不抖动）', () => {
  const exhausted = observeCalls(10);
  const again = advanceExecutionBudget(exhausted, zero(), P);
  assert.equal(again.level, 'exhausted');
  assert.deepEqual(again.state.usage.modelCalls, 10, '不重复累计');
});

check('同一档位不重复上报：level 保持但 buckets 为空', () => {
  const state = observeCalls(7); // 已跨 warn
  const again = advanceExecutionBudget(state, calls(1), P); // 8 次 → 80% 仍在 warn 档
  assert.equal(again.level, 'warn', '当前档位保持（粘滞）');
  assert.deepEqual(again.buckets, [], '但本轮没有新跨阈值 → 不上报，不重复弹提醒');
  assert.equal(again.state.warned.modelCalls, true);
});

// ---- 核心：归一化（checkpoint 旧记录/手改数据全量防御） ----

check('归一化：undefined/null/坏对象不抛错', () => {
  const s = normalizeExecutionBudgetState(undefined);
  assert.deepEqual(s.usage, { modelCalls: 0, outputTokens: 0, activeMs: 0 });
  assert.deepEqual(normalizeExecutionBudgetState(null).usage, s.usage);
  assert.deepEqual(normalizeExecutionBudgetState('nope').exhausted, []);
});

check('归一化：负数 / NaN / Infinity / 字符串一律收敛到 0', () => {
  const s = normalizeExecutionBudgetState({
    usage: { modelCalls: -5, outputTokens: NaN, activeMs: Infinity },
  });
  assert.deepEqual(s.usage, { modelCalls: 0, outputTokens: 0, activeMs: 0 });
  const strings = normalizeExecutionBudgetState({ usage: { modelCalls: '12' } });
  assert.equal(strings.usage.modelCalls, 0, '字符串用量按 0 处理（不猜）');
});

check('归一化：exhausted 去重并过滤未知桶名', () => {
  const s = normalizeExecutionBudgetState({ exhausted: ['modelCalls', 'modelCalls', 'bogus'] });
  assert.deepEqual(s.exhausted, ['modelCalls']);
});

check('归一化：标志位非 true 一律 false', () => {
  const s = normalizeExecutionBudgetState({
    warned: { modelCalls: 'yes', outputTokens: 1 },
    converged: { activeMs: 'yes' },
  });
  assert.deepEqual(s.warned, { modelCalls: false, outputTokens: false, activeMs: false });
  assert.deepEqual(s.converged, { modelCalls: false, outputTokens: false, activeMs: false });
});

// ---- 核心：桶名重算（checkpoint 只存 level 的场景） ----

check('桶名重算：按当前真实用量，不依赖 touched 标记', () => {
  const state = observeCalls(9);
  assert.deepEqual(executionBudgetBucketsFor(state, P, 'converge'), ['modelCalls']);
  assert.deepEqual(executionBudgetBucketsFor(state, P, 'warn'), ['modelCalls']);
  assert.deepEqual(executionBudgetBucketsFor(observeCalls(2), P, 'converge'), []);
});

// ---- 核心：env 可调可关 ----

check('env：未配置任何上限 → 关闭（默认行为不变）', () => {
  assert.equal(resolveExecutionBudgetPolicy({}), false);
});

check('env：on 显式开启（即使没给上限）', () => {
  const p = resolveExecutionBudgetPolicy({ PAYASO_EXECUTION_BUDGET: 'on' });
  assert.ok(p);
  assert.equal(p?.warnRatio, DEFAULT_EXECUTION_BUDGET_POLICY.warnRatio);
});

check('env：off 优先于任何上限（策略开关最高）', () => {
  assert.equal(
    resolveExecutionBudgetPolicy({ PAYASO_EXECUTION_BUDGET: 'off', PAYASO_MAX_MODEL_CALLS: '10' }),
    false,
  );
});

// ---- 请求进行中的投影判定（持续长输出约束）----

check('投影判定：累计 + 在途时间越过 maxActiveMs 才为 true', () => {
  const policy: ExecutionBudgetPolicy = {
    maxActiveMs: 100_000,
    warnRatio: 0.7,
    convergeRatio: 0.9,
  };
  const state = createExecutionBudgetState();
  assert.equal(executionBudgetWouldExceed(state, policy, 99_999), false, '差 1ms 也不算越界');
  assert.equal(executionBudgetWouldExceed(state, policy, 100_000), true, '到达上限即越界');
  const used = normalizeExecutionBudgetState({
    usage: { modelCalls: 1, outputTokens: 0, activeMs: 60_000 },
    warned: {},
    converged: {},
    exhausted: [],
  });
  assert.equal(executionBudgetWouldExceed(used, policy, 39_999), false);
  assert.equal(executionBudgetWouldExceed(used, policy, 40_000), true, '累计与在途叠加');
});

check('投影判定：未配置 maxActiveMs 恒 false（该维度不构成硬约束）', () => {
  const policy: ExecutionBudgetPolicy = { maxModelCalls: 5, warnRatio: 0.7, convergeRatio: 0.9 };
  assert.equal(executionBudgetWouldExceed(createExecutionBudgetState(), policy, 10_000_000), false);
});

check('投影判定：坏输入（负在途时间）按 0 计，不误判', () => {
  const policy: ExecutionBudgetPolicy = { maxActiveMs: 1_000, warnRatio: 0.7, convergeRatio: 0.9 };
  const state = normalizeExecutionBudgetState({
    usage: { modelCalls: 0, outputTokens: 0, activeMs: 999 },
    warned: {},
    converged: {},
    exhausted: [],
  });
  assert.equal(executionBudgetWouldExceed(state, policy, -500), false);
  assert.equal(executionBudgetWouldExceed(state, policy, 1), true);
});

// ---- 预留收尾的独立额度 ----

check('wrap-up 额度有默认值（收尾不是普通请求的完整上限）', () => {
  assert.equal(DEFAULT_EXECUTION_BUDGET_POLICY.wrapUpMaxOutputTokens, 1_024);
  assert.equal(DEFAULT_EXECUTION_BUDGET_POLICY.wrapUpMaxActiveMs, 60_000);
  const p = resolveExecutionBudgetPolicy({ PAYASO_MAX_MODEL_CALLS: '10' });
  assert.equal(p && p.wrapUpMaxOutputTokens, 1_024, '启用预算即带收尾额度');
  assert.equal(p && p.wrapUpMaxActiveMs, 60_000);
});

check('wrap-up 额度可被 env 覆盖；非法值报错（不静默退化）', () => {
  const p = resolveExecutionBudgetPolicy({
    PAYASO_MAX_MODEL_CALLS: '10',
    PAYASO_WRAPUP_MAX_OUTPUT_TOKENS: '256',
    PAYASO_WRAPUP_MAX_ACTIVE_MS: '15000',
  });
  assert.equal(p && p.wrapUpMaxOutputTokens, 256);
  assert.equal(p && p.wrapUpMaxActiveMs, 15_000);
  assert.throws(
    () =>
      resolveExecutionBudgetPolicy({
        PAYASO_MAX_MODEL_CALLS: '10',
        PAYASO_WRAPUP_MAX_ACTIVE_MS: '0',
      }),
    /Invalid execution budget limit/,
  );
});

check('env：三类上限与比例均可覆盖', () => {
  const p = resolveExecutionBudgetPolicy({
    PAYASO_MAX_MODEL_CALLS: '50',
    PAYASO_MAX_OUTPUT_TOKENS: '100000',
    PAYASO_MAX_ACTIVE_MS: '600000',
    PAYASO_BUDGET_WARN_RATIO: '0.6',
    PAYASO_BUDGET_CONVERGE_RATIO: '0.8',
  });
  assert.deepEqual(p, {
    maxModelCalls: 50,
    maxOutputTokens: 100_000,
    maxActiveMs: 600_000,
    warnRatio: 0.6,
    convergeRatio: 0.8,
    // v2.6：启用预算即携带收尾额度（未显式覆盖时取默认值）
    wrapUpMaxOutputTokens: DEFAULT_EXECUTION_BUDGET_POLICY.wrapUpMaxOutputTokens,
    wrapUpMaxActiveMs: DEFAULT_EXECUTION_BUDGET_POLICY.wrapUpMaxActiveMs,
  });
});

check('env：非法上限直接报错（宁可报错也不静默变无限）', () => {
  for (const bad of ['0', '-1', 'abc', '1.5', 'Infinity', 'NaN']) {
    assert.throws(
      () => resolveExecutionBudgetPolicy({ PAYASO_MAX_MODEL_CALLS: bad }),
      /Invalid execution budget limit/,
      `上限 "${bad}" 应报错`,
    );
  }
});

check('env：比例必须在 (0,1) 且 warn<=converge', () => {
  assert.throws(() => resolveExecutionBudgetPolicy({ PAYASO_BUDGET_WARN_RATIO: '0' }), /ratio/);
  assert.throws(() => resolveExecutionBudgetPolicy({ PAYASO_BUDGET_WARN_RATIO: '1' }), /ratio/);
  assert.throws(
    () => resolveExecutionBudgetPolicy({ PAYASO_BUDGET_CONVERGE_RATIO: '1.5' }),
    /ratio/,
  );
  assert.throws(
    () =>
      resolveExecutionBudgetPolicy({
        PAYASO_BUDGET_WARN_RATIO: '0.9',
        PAYASO_BUDGET_CONVERGE_RATIO: '0.5',
      }),
    /warnRatio must not exceed convergeRatio/,
  );
});

// ---- 核心：提醒文本 ----

check('提醒文本：陈述事实 + 不代模型下结论 + 不改权限', () => {
  const text = renderExecutionBudgetReminder(observeCalls(7), P, 'warn', ['modelCalls']);
  assert.match(text, /\[Execution budget warning\]/);
  assert.match(text, /model calls: 7 \/ 10 \(70%\)/);
  assert.match(text, /does not change any permission or user constraint/);
});

check('收敛文本要求交付，耗尽文本禁止开启新调查', () => {
  const converge = renderExecutionBudgetReminder(observeCalls(9), P, 'converge', ['modelCalls']);
  assert.match(converge, /nearly exhausted/);
  assert.match(converge, /deliver it now/);
  const exhausted = renderExecutionBudgetReminder(observeCalls(10), P, 'exhausted', ['modelCalls']);
  assert.match(exhausted, /Do not start new investigation/);
  assert.match(exhausted, /deliver the final answer now/);
});

console.log(`\nexecution-policy 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
