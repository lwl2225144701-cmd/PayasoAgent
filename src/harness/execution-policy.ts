// 模块: 执行预算策略（Harness 层纯函数）。
//
// 为什么单独存在：长 Run 的失控不是单点 bug，而是**没有任何机械边界**——模型调用次数、
// 输出 token、活动时长可以无限增长，直到调用方耐心耗尽。本模块把三类机械预算收敛成
// 一个有界的纯策略：给阈值、给累计口径、给分级动作。Runtime 只负责把事实喂进来
// （调用了几次、用了多少 token、过了多久），不在这里做判断；Host 只负责把决策落成
// 停止原因与事件。
//
// 分层契约（不可越界）：
//   - 只做**算术**：输入累计事实与策略，输出"该提醒 / 该收敛 / 该停止"。
//     不读时钟、不写 trace、不抛异常、不 abort 任何东西。
//   - 提醒与收敛审查只注入模型视图（同 progress/repeat reminder），**不取消**任何
//     安全检查；只有 `exhausted` 一级由 Runtime 转为优雅停止（见 agent.ts）。
//   - 预算可关闭；关闭后本模块返回值恒为 `none`，行为与引入前一致。
//   - 阈值必须是有限正数：NaN / Infinity / 0 / 负数一律拒绝（配置错误宁可报错也不
//     静默退化成"无限预算"）。

/** 三类机械预算（缺省 = 该维度不限）。 */
export interface ExecutionBudgetPolicy {
  /** 单 Run 的最大模型调用次数（含每次重试）。 */
  maxModelCalls?: number;
  /** 单 Run 的最大累计输出 token。 */
  maxOutputTokens?: number;
  /** 单 Run 的最大累计活动时长（毫秒，墙钟，resume 后继续累计）。 */
  maxActiveMs?: number;
  /** 预警比例（默认 0.7）：达到即提醒一次。 */
  warnRatio: number;
  /** 收敛审查比例（默认 0.9）：达到即要求收尾一次，之后不再重复。 */
  convergeRatio: number;
}

export const DEFAULT_EXECUTION_BUDGET_POLICY: Readonly<ExecutionBudgetPolicy> = {
  warnRatio: 0.7,
  convergeRatio: 0.9,
};

/** 累计事实（Runtime 观测，Harness 只累加）。 */
export interface ExecutionBudgetUsage {
  modelCalls: number;
  outputTokens: number;
  activeMs: number;
}

export type ExecutionBudgetBucket = 'modelCalls' | 'outputTokens' | 'activeMs';

export type ExecutionBudgetLevel = 'none' | 'warn' | 'converge' | 'exhausted';

export interface ExecutionBudgetState {
  usage: ExecutionBudgetUsage;
  /** 每桶是否已投递过预警（一次性，不重复打扰）。 */
  warned: Record<ExecutionBudgetBucket, boolean>;
  /** 每桶是否已投递过收敛审查（一次性）。 */
  converged: Record<ExecutionBudgetBucket, boolean>;
  /** 已判定耗尽的桶；一旦置位，后续观测保持 exhausted。 */
  exhausted: ExecutionBudgetBucket[];
}

export interface ExecutionBudgetDecision {
  state: ExecutionBudgetState;
  /**
   * 当前预算档位（粘滞、单调不降）：由 state 的 flags 派生，因此一旦跨过某档就
   * 一直保持，不会因为本轮没有新跨阈值而掉回 none。回答"现在的预算状况是什么"。
   * 阶段二的强制执行就读这一字段（`level === 'exhausted'`）。
   */
  level: ExecutionBudgetLevel;
  /**
   * 本轮**新**跨过阈值的维度（一次性语义，不会重复上报）。回答"这一轮发生了什么
   * 变化"：Harness 只在这里注入提醒文本，Runtime 只在这里发事件——否则同一档位
   * 会在后续每一轮反复弹提醒（正是本策略要消灭的噪音）。
   */
  buckets: ExecutionBudgetBucket[];
}

const BUCKETS: ExecutionBudgetBucket[] = ['modelCalls', 'outputTokens', 'activeMs'];

const LEVEL_RANK: Record<ExecutionBudgetLevel, number> = {
  none: 0,
  warn: 1,
  converge: 2,
  exhausted: 3,
};

/** 某桶当前档位：flags 只升不降，因此结果单调不降（粘滞）。 */
function bucketLevel(
  state: ExecutionBudgetState,
  bucket: ExecutionBudgetBucket,
): ExecutionBudgetLevel {
  if (state.exhausted.includes(bucket)) return 'exhausted';
  if (state.converged[bucket]) return 'converge';
  if (state.warned[bucket]) return 'warn';
  return 'none';
}

const BUCKET_LABEL: Record<ExecutionBudgetBucket, string> = {
  modelCalls: 'model calls',
  outputTokens: 'output tokens',
  activeMs: 'active time',
};

export function createExecutionBudgetState(): ExecutionBudgetState {
  return {
    usage: { modelCalls: 0, outputTokens: 0, activeMs: 0 },
    warned: { modelCalls: false, outputTokens: false, activeMs: false },
    converged: { modelCalls: false, outputTokens: false, activeMs: false },
    exhausted: [],
  };
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

/** 归一化（checkpoint 旧记录缺字段 → 全零；绝不因坏数据抛错）。 */
export function normalizeExecutionBudgetState(value: unknown): ExecutionBudgetState {
  const state = value as Partial<ExecutionBudgetState> | undefined;
  const usage = (state?.usage ?? {}) as Partial<ExecutionBudgetUsage>;
  const flags = (state?.warned ?? {}) as Partial<Record<ExecutionBudgetBucket, unknown>>;
  const convergedFlags = (state?.converged ?? {}) as Partial<
    Record<ExecutionBudgetBucket, unknown>
  >;
  const exhaustedRaw = state?.exhausted;
  const exhausted = Array.isArray(exhaustedRaw)
    ? (exhaustedRaw as unknown[]).filter((bucket): bucket is ExecutionBudgetBucket =>
        BUCKETS.includes(bucket as ExecutionBudgetBucket),
      )
    : [];
  return {
    usage: {
      modelCalls: nonNegativeInteger(usage.modelCalls),
      outputTokens: nonNegativeInteger(usage.outputTokens),
      activeMs: nonNegativeInteger(usage.activeMs),
    },
    warned: {
      modelCalls: flags.modelCalls === true,
      outputTokens: flags.outputTokens === true,
      activeMs: flags.activeMs === true,
    },
    converged: {
      modelCalls: convergedFlags.modelCalls === true,
      outputTokens: convergedFlags.outputTokens === true,
      activeMs: convergedFlags.activeMs === true,
    },
    exhausted: [...new Set(exhausted)],
  };
}

function bucketMax(
  bucket: ExecutionBudgetBucket,
  policy: ExecutionBudgetPolicy,
): number | undefined {
  switch (bucket) {
    case 'modelCalls':
      return policy.maxModelCalls;
    case 'outputTokens':
      return policy.maxOutputTokens;
    default:
      return policy.maxActiveMs;
  }
}

/** 每桶用量与上限（未配置上限的桶不出现在结果里）。 */
export function executionBudgetRatios(
  state: ExecutionBudgetState,
  policy: ExecutionBudgetPolicy,
): Array<{ bucket: ExecutionBudgetBucket; used: number; max: number; ratio: number }> {
  const out: Array<{ bucket: ExecutionBudgetBucket; used: number; max: number; ratio: number }> =
    [];
  for (const bucket of BUCKETS) {
    const max = bucketMax(bucket, policy);
    if (max === undefined || !Number.isFinite(max) || max <= 0) continue;
    const used = state.usage[bucket];
    out.push({ bucket, used, max, ratio: used / max });
  }
  return out;
}

/**
 * 累计一次观测并给出分级决策。
 *
 * `level` 与 `buckets` 分工明确（见 ExecutionBudgetDecision）：前者是粘滞的当前档位，
 * 后者是本轮新跨阈值的维度。同一批事实可能同时跨过 warn/converge/exhausted 三个
 * 阈值；此时只把该桶的 flags 一次性置位并计入 buckets，`level` 取全局最高档。
 * 因此同一档位不会连续两轮反复上报——重复打扰本身就是"执行不收敛"的一种。
 */
export function advanceExecutionBudget(
  state: ExecutionBudgetState,
  usage: ExecutionBudgetUsage,
  policy: ExecutionBudgetPolicy,
): ExecutionBudgetDecision {
  const next: ExecutionBudgetState = {
    usage: {
      modelCalls: Math.min(Number.MAX_SAFE_INTEGER, state.usage.modelCalls + usage.modelCalls),
      outputTokens: Math.min(
        Number.MAX_SAFE_INTEGER,
        state.usage.outputTokens + usage.outputTokens,
      ),
      activeMs: Math.min(Number.MAX_SAFE_INTEGER, state.usage.activeMs + usage.activeMs),
    },
    warned: { ...state.warned },
    converged: { ...state.converged },
    exhausted: [...state.exhausted],
  };
  const touched: ExecutionBudgetBucket[] = [];

  for (const bucket of BUCKETS) {
    const max = bucketMax(bucket, policy);
    if (max === undefined || !Number.isFinite(max) || max <= 0) continue;
    const used = next.usage[bucket];
    if (used >= max) {
      if (!next.exhausted.includes(bucket)) {
        next.exhausted.push(bucket);
        touched.push(bucket);
      }
      continue;
    }
    if (used >= max * policy.convergeRatio) {
      if (!next.converged[bucket]) {
        next.converged[bucket] = true;
        touched.push(bucket);
      }
      continue;
    }
    if (used >= max * policy.warnRatio) {
      if (!next.warned[bucket]) {
        next.warned[bucket] = true;
        touched.push(bucket);
      }
    }
  }

  // level 由 flags 派生：已跨过的档位一直保持（即使本轮增量为 0），
  // 未跨过的档位不会出现。阶段二据此判断是否该优雅停止。
  let level: ExecutionBudgetLevel = 'none';
  for (const bucket of BUCKETS) {
    const current = bucketLevel(next, bucket);
    if (LEVEL_RANK[current] > LEVEL_RANK[level]) level = current;
  }
  return { state: next, level, buckets: touched };
}

function describeRatio(used: number, max: number): string {
  return `${used} / ${max} (${Math.floor((used / max) * 100)}%)`;
}

/**
 * 重算达到某级别的桶（用于 checkpoint 里只存了 level、没存桶名的旧记录）。
 * 只按当前实际用量判断，不依赖 touched 标记：渲染出来的比例必须是真的。
 */
export function executionBudgetBucketsFor(
  state: ExecutionBudgetState,
  policy: ExecutionBudgetPolicy,
  level: 'warn' | 'converge',
): ExecutionBudgetBucket[] {
  const threshold = level === 'converge' ? policy.convergeRatio : policy.warnRatio;
  return executionBudgetRatios(state, policy)
    .filter((entry) => entry.ratio >= threshold)
    .map((entry) => entry.bucket);
}

/** 模型侧的预警/收敛文本（有界；只陈述事实与下一步，不代模型下结论）。 */
export function renderExecutionBudgetReminder(
  state: ExecutionBudgetState,
  policy: ExecutionBudgetPolicy,
  level: Exclude<ExecutionBudgetLevel, 'none'>,
  buckets: ExecutionBudgetBucket[],
): string {
  const lines = buckets.map((bucket) => {
    const max = bucketMax(bucket, policy) ?? 0;
    return `- ${BUCKET_LABEL[bucket]}: ${describeRatio(state.usage[bucket], max)}`;
  });
  const headline =
    level === 'exhausted'
      ? '[Execution budget exhausted]'
      : level === 'converge'
        ? '[Execution budget nearly exhausted]'
        : '[Execution budget warning]';
  const guidance =
    level === 'exhausted'
      ? 'The configured execution budget is spent. Do not start new investigation: consolidate what is already established, verify it if a single cheap check remains, and deliver the final answer now. State plainly which parts are done and which are not.'
      : level === 'converge'
        ? 'You are close to the execution budget. Converge: stop broad investigation, finish the single most important remaining step, and prepare to deliver. If the requested result is already available, deliver it now.'
        : 'You have used most of the execution budget for this run. Prefer reusing results you already have over new calls; keep only the checks that are still necessary.';
  return `\n\n${headline}\n${lines.join('\n')}\n${guidance}\nThis notice does not change any permission or user constraint.`;
}

/**
 * 剩余预算行（周期性目标审查等场合引用）。未配置上限的桶不出现；
 * 预算关闭时返回空数组——调用方据此整段省略，不虚构"无限"。
 */
export function renderExecutionBudgetRemaining(
  state: ExecutionBudgetState,
  policy: ExecutionBudgetPolicy,
): string[] {
  return executionBudgetRatios(state, policy).map(({ bucket, used, max }) => {
    const remaining = Math.max(0, max - used);
    return `${BUCKET_LABEL[bucket]}: ${remaining} remaining (used ${used} / ${max})`;
  });
}

/** 解析环境配置。`off` 显式关闭；未配置任何上限时视为关闭（默认行为不变）。 */
export function resolveExecutionBudgetPolicy(
  env: Record<string, string | undefined> = process.env,
): ExecutionBudgetPolicy | false {
  if (env.PAYASO_EXECUTION_BUDGET === 'off') return false;
  const positiveInt = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `Invalid execution budget limit "${raw}": expected a finite positive integer`,
      );
    }
    return value;
  };
  const ratio = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new Error(`Invalid execution budget ratio "${raw}": expected a value in (0, 1)`);
    }
    return value;
  };
  const policy: ExecutionBudgetPolicy = {
    ...DEFAULT_EXECUTION_BUDGET_POLICY,
    ...(env.PAYASO_MAX_MODEL_CALLS !== undefined
      ? { maxModelCalls: positiveInt(env.PAYASO_MAX_MODEL_CALLS) }
      : {}),
    ...(env.PAYASO_MAX_OUTPUT_TOKENS !== undefined
      ? { maxOutputTokens: positiveInt(env.PAYASO_MAX_OUTPUT_TOKENS) }
      : {}),
    ...(env.PAYASO_MAX_ACTIVE_MS !== undefined
      ? { maxActiveMs: positiveInt(env.PAYASO_MAX_ACTIVE_MS) }
      : {}),
    warnRatio: ratio(env.PAYASO_BUDGET_WARN_RATIO, DEFAULT_EXECUTION_BUDGET_POLICY.warnRatio),
    convergeRatio: ratio(
      env.PAYASO_BUDGET_CONVERGE_RATIO,
      DEFAULT_EXECUTION_BUDGET_POLICY.convergeRatio,
    ),
  };
  if (policy.warnRatio > policy.convergeRatio) {
    throw new Error('Invalid execution budget ratios: warnRatio must not exceed convergeRatio');
  }
  const enabled =
    env.PAYASO_EXECUTION_BUDGET === 'on' ||
    policy.maxModelCalls !== undefined ||
    policy.maxOutputTokens !== undefined ||
    policy.maxActiveMs !== undefined;
  return enabled ? policy : false;
}
