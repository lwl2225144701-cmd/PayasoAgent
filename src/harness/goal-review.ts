// 模块: 周期性目标审查策略（Harness 层纯函数）。
//
// 为什么单独存在：现有两个观察机制都有覆盖盲区——
//   - progress-reminder 只累计**只读**回合：模型把调查换成「写点东西 / 跑个
//     命令」就能重置计数，调查实际上仍在继续；
//   - repeat-call 只认**同工具同参数**：交替读文件、换搜索词、换命令调查同一
//     问题，参数摘要永远不同，计数永远为 1。
// 执行不收敛最大量的形态恰好在两者之间：**语义等价、形式不同**的反复调查。
// 本策略按**全部已完成工具回合**计数（读/写/失败/中性都算，「换个写法」
// 不能重置周期），周期性把原始目标、近期结果与剩余预算摆回模型面前，
// 要求它说明下一步要解决的具体问题——目标保持由此获得机械兜底。
//
// 分层契约（不可越界）：
//   - 只提醒、不阻断：合法长任务在说明目标与未解决问题后仍可继续；
//   - 触发即重置计数（下一周期从零开始），pending 未投递期间不重复触发；
//   - 文案只陈述事实与下一步，不代模型判定「任务已完成」。

export interface GoalReviewPolicy {
  /** 每多少个已完成工具回合审查一次。 */
  everyTurns: number;
  /** 每累计多少活动毫秒审查一次（与回合数任一满足即触发）。 */
  everyMs: number;
}

export const DEFAULT_GOAL_REVIEW_POLICY: Readonly<GoalReviewPolicy> = {
  everyTurns: 10,
  everyMs: 180_000,
};

export interface GoalReviewState {
  /** 本周期已累计的 completed tool turns（任意活动）。 */
  toolTurns: number;
  /** 本周期已累计的活动毫秒。 */
  activeMs: number;
  review: 'none' | 'pending' | 'delivered';
}

export interface GoalReviewTurn {
  durationMs: number;
}

export interface GoalReviewReminder {
  toolTurns: number;
  activeMs: number;
}

export function normalizeGoalReviewState(value: unknown): GoalReviewState {
  const state = value as Partial<GoalReviewState> | undefined;
  const nonnegativeInteger = (raw: unknown): number =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
  return {
    toolTurns: nonnegativeInteger(state?.toolTurns),
    activeMs: nonnegativeInteger(state?.activeMs),
    review: state?.review === 'pending' || state?.review === 'delivered' ? state.review : 'none',
  };
}

/**
 * 累计一个已完成工具回合；跨过周期阈值时触发审查并重置计数。
 * pending 未投递期间不重复触发（避免故障循环里连珠提醒）。
 */
export function advanceGoalReview(
  state: GoalReviewState,
  turn: GoalReviewTurn,
  policy: GoalReviewPolicy,
): { state: GoalReviewState; reminder: GoalReviewReminder | undefined } {
  const durationMs = Number.isFinite(turn.durationMs)
    ? Math.max(0, Math.floor(turn.durationMs))
    : 0;
  if (state.review === 'pending') {
    // 等待投递期间不累计：审查摆到模型面前之前，周期不应继续推进。
    return { state, reminder: undefined };
  }
  const toolTurns = Math.min(Number.MAX_SAFE_INTEGER, state.toolTurns + 1);
  const activeMs = Math.min(Number.MAX_SAFE_INTEGER, state.activeMs + durationMs);
  if (toolTurns >= policy.everyTurns || activeMs >= policy.everyMs) {
    return {
      // 触发即重置：下一周期从零开始（投递后重新开始下一周期）。
      state: { toolTurns: 0, activeMs: 0, review: 'pending' },
      reminder: { toolTurns, activeMs },
    };
  }
  return { state: { toolTurns, activeMs, review: 'none' }, reminder: undefined };
}

export interface GoalReviewRenderInput {
  /** 原始用户目标（Run.task，Runtime 传入；不得由模型改写）。 */
  goal: string;
  /** 本周期累计的工具回合数与活动毫秒（触发时的事实）。 */
  toolTurns: number;
  activeMs: number;
  /** 近期工具结果的有界摘要（Runtime 脱敏截断后传入）。 */
  recentResult?: string;
  /** 剩余预算行（预算关闭时为空数组）。 */
  budgetLines: readonly string[];
}

/** 注入模型的审查文本（有界；只陈述事实与下一步，不代模型下结论）。 */
export function renderGoalReviewReminder(input: GoalReviewRenderInput): string {
  const lines = [
    '\n\n[Periodic goal review]',
    `You have completed ${input.toolTurns} tool turns over ${Math.floor(input.activeMs / 1000)} seconds of active work since the last review.`,
    `Original user goal: ${input.goal || '(not recorded)'}`,
  ];
  if (input.recentResult) {
    lines.push(`Most recent tool result (bounded): ${input.recentResult}`);
  }
  if (input.budgetLines.length > 0) {
    lines.push(`Remaining execution budget:\n${input.budgetLines.map((l) => `- ${l}`).join('\n')}`);
  }
  lines.push(
    'Before the next action, state in one sentence which specific unresolved question you are working on. ' +
      'If the requested result is already available, verify and deliver it now. ' +
      'Do not replan settled decisions and do not repeat broad investigation you have already done. ' +
      'Long tasks are legitimate: if real work remains, continue with the next concrete step.',
  );
  return lines.join('\n');
}

/** 环境变量开关：`PAYASO_GOAL_REVIEW=off` 关闭；阈值可覆盖。 */
export function resolveGoalReviewPolicy(
  env: Record<string, string | undefined> = process.env,
): GoalReviewPolicy | false {
  if (env.PAYASO_GOAL_REVIEW === 'off') return false;
  const positiveInt = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
  };
  return {
    everyTurns: positiveInt(env.PAYASO_GOAL_REVIEW_TURNS, DEFAULT_GOAL_REVIEW_POLICY.everyTurns),
    everyMs: positiveInt(env.PAYASO_GOAL_REVIEW_MS, DEFAULT_GOAL_REVIEW_POLICY.everyMs),
  };
}
