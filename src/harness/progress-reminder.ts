// 持续只读调查的提醒策略：只观察已完成的工具回合，不判断任务语义或阻断工具。
// 时间由 Runtime 按实际执行时长提供，暂停/崩溃期间的墙钟时间不计入。
export interface ProgressReminderPolicy {
  minReadOnlyTurns: number;
  minReadOnlyMs: number;
}

export const DEFAULT_PROGRESS_REMINDER_POLICY: Readonly<ProgressReminderPolicy> = {
  minReadOnlyTurns: 8,
  minReadOnlyMs: 120_000,
};

export interface ToolTurnProgress {
  activity: 'read' | 'neutral' | 'other';
  durationMs: number;
}

export interface ProgressReminderState {
  readOnlyTurns: number;
  readOnlyMs: number;
  reminder: 'none' | 'pending' | 'delivered';
}

export interface ProgressReminder {
  readOnlyTurns: number;
  readOnlyMs: number;
}

export function normalizeProgressReminderState(value: unknown): ProgressReminderState {
  const state = value as Partial<ProgressReminderState> | undefined;
  const nonnegativeInteger = (value: unknown): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    readOnlyTurns: nonnegativeInteger(state?.readOnlyTurns),
    readOnlyMs: nonnegativeInteger(state?.readOnlyMs),
    reminder:
      state?.reminder === 'pending' || state?.reminder === 'delivered' ? state.reminder : 'none',
  };
}

export function advanceProgressReminder(
  state: ProgressReminderState,
  turn: ToolTurnProgress,
  policy: ProgressReminderPolicy,
): ProgressReminderState {
  if (state.reminder !== 'none' || turn.activity === 'neutral') return state;
  if (turn.activity === 'other') {
    return { readOnlyTurns: 0, readOnlyMs: 0, reminder: 'none' };
  }
  const durationMs = Number.isFinite(turn.durationMs)
    ? Math.max(0, Math.floor(turn.durationMs))
    : 0;
  const next: ProgressReminderState = {
    readOnlyTurns: Math.min(Number.MAX_SAFE_INTEGER, state.readOnlyTurns + 1),
    readOnlyMs: Math.min(Number.MAX_SAFE_INTEGER, state.readOnlyMs + durationMs),
    reminder: 'none',
  };
  if (next.readOnlyTurns >= policy.minReadOnlyTurns && next.readOnlyMs >= policy.minReadOnlyMs) {
    next.reminder = 'pending';
  }
  return next;
}

export function renderProgressReminder(state: ProgressReminderState | undefined): string {
  if (state?.reminder !== 'pending') return '';
  return (
    `\n\n[Progress review]\n` +
    `You have completed ${state.readOnlyTurns} read-only tool turns over ` +
    `${Math.floor(state.readOnlyMs / 1000)} seconds of active investigation. ` +
    'Review the user goal and evidence already available. If they support the next action, carry it out and verify the result; ' +
    'if the requested result is ready, deliver it. If more investigation is necessary, identify the specific unresolved question ' +
    'and investigate that question without repeating broad searches or replanning settled decisions. ' +
    'Complete the requested scope. For read-only tasks, continue gathering necessary evidence or answer; no edits are required. ' +
    'This reminder does not establish that the task is complete or change any permission or user constraint.'
  );
}
