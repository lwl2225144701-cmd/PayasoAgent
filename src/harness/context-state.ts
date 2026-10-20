import {
  type ExecutionBudgetBucket,
  type ExecutionBudgetState,
  normalizeExecutionBudgetState,
} from './execution-policy.js';
import { type GoalReviewState, normalizeGoalReviewState } from './goal-review.js';
import { createPlan, normalizePlan, type Plan } from './plan.js';
import { normalizeProgressReminderState, type ProgressReminderState } from './progress-reminder.js';
import { normalizeProgressWatchState, type ProgressWatchState } from './progress-watch.js';
import {
  normalizeRepeatCallReminder,
  normalizeRepeatCallState,
  type RepeatCallReminder,
  type RepeatCallState,
} from './repeat-call-policy.js';

export interface ContextHarnessState {
  conversationSummary: string;
  summarizedMessageCount: number;
  // Agent 自述的任务清单：由 Harness 持有，随 checkpoint 的 harnessState 一起持久化
  // （因此不需要给 CheckpointSnapshot 加字段）。旧 checkpoint 无此字段 → 空计划。
  plan: Plan;
  // 每 Run 独立；resume 保留，新 Run 继承会话历史时重置。旧 checkpoint 可缺省。
  progressReminder?: ProgressReminderState;
  // 执行不收敛治理（v2.6）：重复调用观察与机械预算的连续计数。同样搭车 harnessState
  // 持久化——resume 后计数延续，新 Run（继承会话历史）重置。旧 checkpoint 缺省。
  repeatCall?: RepeatCallState;
  executionBudget?: ExecutionBudgetState;
  // v2.6 周期性目标审查：按全部已完成工具回合计数（覆盖换参数/换命令的
  // 语义等价反复调查）。resume 延续，新 Run 重置；旧 checkpoint 缺省。
  goalReview?: GoalReviewState;
  // v2.5（计划 §8）：机械可验证的进度闭环状态（只存计数/纪元/投递状态，
  // 原始执行证据仍在 Runtime 的 execution-evidence-store）。
  progressWatch?: ProgressWatchState;
  // 已触发但尚未随模型视图投递的提醒。与 progressReminder 的 pending 同语义：
  // 保留是为了 resume 后不丢；模型成功响应后由 Runtime 调 acknowledge 清除。
  pending?: ContextHarnessPendingReminders;
}

/** 待投递的提醒（Harness 只生成文本素材，Runtime 负责发事件与清除）。 */
export interface ContextHarnessPendingReminders {
  repeatCall?: RepeatCallReminder;
  budget?: { level: 'warn' | 'converge'; buckets: ExecutionBudgetBucket[] };
  goalReview?: { toolTurns: number; activeMs: number; goal: string; recentResult?: string };
  progressWatch?: { level: 'warn' | 'escalate'; reason: string; evidenceIds: string[] };
}

export function createContextHarnessState(): ContextHarnessState {
  return {
    conversationSummary: '',
    summarizedMessageCount: 0,
    plan: createPlan(),
    // repeatCall / executionBudget / pending 刻意缺省：没有观测就不落字段，
    // 避免给每个 checkpoint 塞空对象。首次观测时由 Harness 写入有效状态。
  };
}

function normalizePendingReminders(value: unknown): ContextHarnessPendingReminders | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ContextHarnessPendingReminders>;
  const repeatCall = normalizeRepeatCallReminder(candidate.repeatCall);
  const budget = candidate.budget;
  const budgetLevel =
    budget?.level === 'warn' || budget?.level === 'converge' ? budget.level : undefined;
  const budgetBuckets = budget?.buckets;
  const goalReview = candidate.goalReview;
  const goalReviewToolTurns =
    typeof goalReview?.toolTurns === 'number' && Number.isSafeInteger(goalReview.toolTurns)
      ? goalReview.toolTurns
      : 0;
  const hasGoalReview =
    goalReview !== undefined &&
    typeof goalReview === 'object' &&
    (typeof goalReview.goal === 'string' || goalReviewToolTurns > 0);
  const progressWatch = candidate.progressWatch;
  const hasProgressWatch =
    progressWatch !== undefined &&
    typeof progressWatch === 'object' &&
    (progressWatch.level === 'warn' || progressWatch.level === 'escalate');
  if (
    repeatCall === undefined &&
    budgetLevel === undefined &&
    !hasGoalReview &&
    !hasProgressWatch
  ) {
    return undefined;
  }
  return {
    ...(repeatCall === undefined ? {} : { repeatCall }),
    ...(budgetLevel === undefined
      ? {}
      : {
          budget: {
            level: budgetLevel,
            // 桶名不可信（旧记录/手改 checkpoint）：缺省为空，渲染层按用量重算。
            buckets: Array.isArray(budgetBuckets)
              ? (budgetBuckets as unknown[]).filter(
                  (bucket): bucket is ExecutionBudgetBucket =>
                    bucket === 'modelCalls' || bucket === 'outputTokens' || bucket === 'activeMs',
                )
              : [],
          },
        }),
    ...(hasGoalReview && goalReview
      ? {
          goalReview: {
            toolTurns: goalReviewToolTurns,
            activeMs:
              typeof goalReview.activeMs === 'number' && Number.isSafeInteger(goalReview.activeMs)
                ? goalReview.activeMs
                : 0,
            goal: typeof goalReview.goal === 'string' ? goalReview.goal.slice(0, 500) : '',
            ...(typeof goalReview.recentResult === 'string'
              ? { recentResult: goalReview.recentResult.slice(0, 240) }
              : {}),
          },
        }
      : {}),
    ...(hasProgressWatch && progressWatch
      ? {
          progressWatch: {
            level: progressWatch.level as 'warn' | 'escalate',
            reason:
              typeof progressWatch.reason === 'string' ? progressWatch.reason.slice(0, 240) : '',
            evidenceIds: Array.isArray(progressWatch.evidenceIds)
              ? progressWatch.evidenceIds
                  .filter((id): id is string => typeof id === 'string')
                  .slice(0, 8)
              : [],
          },
        }
      : {}),
  };
}

export function normalizeContextHarnessState(
  value: ContextHarnessState | undefined,
): ContextHarnessState {
  if (!value) return createContextHarnessState();
  return {
    conversationSummary:
      typeof value.conversationSummary === 'string' ? value.conversationSummary : '',
    summarizedMessageCount:
      Number.isSafeInteger(value.summarizedMessageCount) && value.summarizedMessageCount >= 0
        ? value.summarizedMessageCount
        : 0,
    plan: normalizePlan((value as { plan?: unknown }).plan),
    ...(value.progressWatch === undefined
      ? {}
      : { progressWatch: normalizeProgressWatchState(value.progressWatch) }),
    ...(value.progressReminder === undefined
      ? {}
      : {
          progressReminder: normalizeProgressReminderState(value.progressReminder),
        }),
    // 未启用的维度不写入状态：避免给每个 checkpoint 塞无意义字段。
    ...(value.repeatCall === undefined
      ? {}
      : { repeatCall: normalizeRepeatCallState(value.repeatCall) }),
    ...(value.executionBudget === undefined
      ? {}
      : { executionBudget: normalizeExecutionBudgetState(value.executionBudget) }),
    ...(value.goalReview === undefined
      ? {}
      : { goalReview: normalizeGoalReviewState(value.goalReview) }),
    ...(value.pending === undefined ? {} : { pending: normalizePendingReminders(value.pending) }),
  };
}
