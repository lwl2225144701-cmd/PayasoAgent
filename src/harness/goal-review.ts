// 周期回顾：按已完成工具回合与活动时间提供简短建议，不规定任务阶段或阻断工具。
// 目标、工具结果与预算预警分别已有独立投影，这里不重复它们，也不要求模型解释自己的流程。

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
  /** 本周期累计的工具回合数与活动毫秒（触发时的事实）。 */
  toolTurns: number;
  activeMs: number;
}

/** 注入模型的审查文本（有界；只陈述事实与下一步，不代模型下结论）。 */
export function renderGoalReviewReminder(input: GoalReviewRenderInput): string {
  return [
    '\n\n[Periodic goal review]',
    `${input.toolTurns} tool turns over ${Math.floor(input.activeMs / 1000)} seconds since the previous review.`,
    'Further lookup is useful when it can change implementation, verification or the answer. Otherwise, use established evidence for the next step.',
  ].join('\n');
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
