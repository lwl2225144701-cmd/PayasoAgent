// 模块: Progress Watch — 可机械验证的进度闭环（计划 §8 / P2）。
//
// 目的：对没有新增记录事实的回合提供观察提示，不分类任务、不限制工具或决定收尾。
// 事实来源是 Runtime 汇总的 ToolTurnFacts（本模块不读文件、不跑检查、不改事实存储）。
//
// 停滞定义（首版工程起点，需行为验证）：
//   连续 PROGRESS_WATCH_TURNS 个已完成工具回合没有新增有效事实，
//   且累计活跃时长 ≥ PROGRESS_WATCH_MIN_ACTIVE_MS → 触发一次事实型进度审查；
//   送达只更新投递状态，不关闭周期；再同样多回合无新增 → 升级一次，同周期最多 2 次；
//   新的读取证据、真实修改或新检查结论均关闭周期。
//
// 已知边界（诚实标注）：本版 facts 由 Runtime 依据调用事实推导
// （读取范围去重、成功编辑/写入、检查结论），因此 coverage 在无结构化事实时
// 为 'partial'/'unknown'；遇到 unknown 停止机械推断，不把未知活动当作停滞。

export const PROGRESS_WATCH_TURNS = 4;
export const PROGRESS_WATCH_MIN_ACTIVE_MS = 120_000;
export const PROGRESS_WATCH_MAX_REMINDERS = 2;
/** 升级提醒需要的连续无新增回合数（第二次及以后）。 */
export const PROGRESS_WATCH_ESCALATE_TURNS = 8;

export type ProgressWatchLevel = 'none' | 'warn' | 'escalate';

export interface ToolTurnFacts {
  /** complete = 本轮全部工具都提供了结构化事实；partial = 部分；unknown = 无结构化事实。 */
  coverage: 'complete' | 'partial' | 'unknown';
  newReadCount: number;
  changedFileCount: number;
  newCheckCount: number;
  repeatCount: number;
  failedCount: number;
  neutralOnly: boolean;
  /** 有界的证据引用（checkId / 读取指纹键），只用于投影，不进模型的大段内容。 */
  evidenceIds: string[];
}

export interface ProgressWatchState {
  /** 事实纪元：每次关闭周期 +1，用于把"本轮提醒"与"旧周期"区分开。 */
  epoch: number;
  /** 连续无新增有效事实的已完成工具回合数。 */
  noProgressTurns: number;
  /** 本周期累计活跃时长（毫秒，由 Runtime 提供实际执行时长）。 */
  activeMs: number;
  /** 本周期已送达提醒次数（≤ PROGRESS_WATCH_MAX_REMINDERS）。 */
  reminders: number;
  /** 最近一次提醒等级。 */
  level: ProgressWatchLevel;
  /** 本周期是否仍在观察中。 */
  cycleOpen: boolean;
  /** 最近一次提醒时记录的重复范围/未知事项摘要（有界文本）。 */
  lastReason?: string;
}

export interface ProgressWatchDecision {
  state: ProgressWatchState;
  /** 本次应送达的提醒等级；'none' = 不提醒。 */
  remind: ProgressWatchLevel;
  /** 有界的触发依据（重复事实数/回合/时长），供提醒文案与 trace 使用。 */
  reason?: string;
}

export function createProgressWatchState(): ProgressWatchState {
  return {
    epoch: 0,
    noProgressTurns: 0,
    activeMs: 0,
    reminders: 0,
    level: 'none',
    cycleOpen: false,
  };
}

export function normalizeProgressWatchState(value: unknown): ProgressWatchState {
  const state = (value ?? {}) as Partial<ProgressWatchState>;
  const nonnegative = (input: unknown): number =>
    typeof input === 'number' && Number.isFinite(input) && input > 0 ? Math.floor(input) : 0;
  const level: ProgressWatchLevel =
    state.level === 'warn' || state.level === 'escalate' ? state.level : 'none';
  return {
    epoch: nonnegative(state.epoch),
    noProgressTurns: nonnegative(state.noProgressTurns),
    activeMs: nonnegative(state.activeMs),
    reminders: Math.min(nonnegative(state.reminders), PROGRESS_WATCH_MAX_REMINDERS),
    level,
    cycleOpen: state.cycleOpen === true,
    ...(typeof state.lastReason === 'string' && state.lastReason !== ''
      ? { lastReason: state.lastReason.slice(0, 240) }
      : {}),
  };
}

/** 本轮是否产生"新增有效事实"（§8.1）。 */
export function hasNewEvidence(facts: ToolTurnFacts): boolean {
  return facts.newReadCount > 0 || facts.changedFileCount > 0 || facts.newCheckCount > 0;
}

/** 汇总一次工具回合后的纯策略推进（无副作用，可独立单测）。 */
export function advanceProgressWatch(
  previous: ProgressWatchState,
  facts: ToolTurnFacts,
  turnActiveMs: number,
  policy: {
    turns?: number;
    minActiveMs?: number;
    escalateTurns?: number;
    maxReminders?: number;
  } = {},
): ProgressWatchDecision {
  const turns = policy.turns ?? PROGRESS_WATCH_TURNS;
  const minActiveMs = policy.minActiveMs ?? PROGRESS_WATCH_MIN_ACTIVE_MS;
  const escalateTurns = policy.escalateTurns ?? PROGRESS_WATCH_ESCALATE_TURNS;
  const maxReminders = policy.maxReminders ?? PROGRESS_WATCH_MAX_REMINDERS;
  const state: ProgressWatchState = { ...previous };

  // 无结构化事实：停止本轮机械停滞推断（避免把正常业务动作误判为停滞）。
  if (facts.coverage === 'unknown') {
    return { state: { ...state, noProgressTurns: 0, activeMs: 0 }, remind: 'none' };
  }

  // 中性回合（updatePlan 等）：保留计数，不累积回合与时长。
  if (facts.neutralOnly) {
    return { state, remind: 'none' };
  }

  const activeMs = Number.isFinite(turnActiveMs) ? Math.max(0, Math.floor(turnActiveMs)) : 0;

  if (hasNewEvidence(facts)) {
    // 新增必要证据/真实修改/新版本检查结论 → 关闭当前周期（回到初始观察）。
    return {
      state: {
        epoch: state.epoch + 1,
        noProgressTurns: 0,
        activeMs: 0,
        reminders: 0,
        level: 'none',
        cycleOpen: false,
      },
      remind: 'none',
    };
  }

  const noProgressTurns = state.noProgressTurns + 1;
  const accumulatedMs = state.activeMs + activeMs;
  const next: ProgressWatchState = {
    ...state,
    noProgressTurns,
    activeMs: accumulatedMs,
    cycleOpen: true,
  };

  const ready = noProgressTurns >= turns && accumulatedMs >= minActiveMs;
  if (!ready) {
    return { state: next, remind: 'none' };
  }
  if (state.reminders >= maxReminders) {
    return { state: next, remind: 'none' };
  }

  const level: ProgressWatchLevel = state.reminders === 0 ? 'warn' : 'escalate';
  if (level === 'escalate' && noProgressTurns < escalateTurns) {
    return { state: next, remind: 'none' };
  }
  const reason =
    `连续 ${noProgressTurns} 个已完成工具回合没有新增记录事实（累计活跃 ${Math.floor(accumulatedMs / 1000)}s）：` +
    `重复调用 ${facts.repeatCount} 次，失败 ${facts.failedCount} 次，新增读取 ${facts.newReadCount}、` +
    `修改 ${facts.changedFileCount}、检查结论 ${facts.newCheckCount}`;
  return {
    state: {
      ...next,
      reminders: state.reminders + 1,
      level,
      cycleOpen: true,
      lastReason: reason.slice(0, 240),
    },
    remind: level,
    reason,
  };
}

/** 渲染事实型进度审查文案（有界）。 */
export function renderProgressWatchReminder(
  decision: ProgressWatchDecision,
  evidence: readonly string[] = [],
): string {
  if (decision.remind === 'none') return '';
  const bounded = evidence.filter((item) => item.trim() !== '').slice(0, 6);
  return (
    `\n\n[Progress watch · ${decision.remind === 'escalate' ? 'escalation' : 'review'}]\n` +
    `${decision.reason ?? 'No new verifiable evidence in recent tool turns.'}\n` +
    'Choose an action that adds evidence or advances the requested result; reuse unchanged sources.\n' +
    (bounded.length > 0 ? `Known evidence: ${bounded.join(', ')}\n` : '')
  );
}
