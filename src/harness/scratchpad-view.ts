// Module: Scratchpad View — the bounded, deterministic progress projection that
// the Harness injects into the system message every turn.
//
// Why this module exists (v1.10):
// The view used to repeat up to 20 completed steps with 1000 characters of
// *result* each, plus the last result again — ~6.3K tokens on every request
// (measured in the run database). Those results are already in the transcript
// as tool messages, and compaction summarizes them ("Tool results" heading), so
// the duplication bought nothing and changed every turn (killing prompt cache).
//
// What this view is for: progress + anti-loop signals. It keeps *which* calls
// ran (tool + clipped input), what failed, what was invalid, and the next step.
// It deliberately does NOT carry results: the transcript owns content, this
// view owns behaviour.

export interface ScratchpadView {
  task: string;
  completedSteps: Array<{ step: number; tool: string; input: string; result: string }>;
  failedSteps: Array<{ tool: string; input: string; error: string; retries: number }>;
  invalidSteps: Array<{ tool: string; input: string; result: unknown; reason: string }>;
  nextStep: { tool: string; input: string } | null;
  lastResult: string;
}

export interface BoundedScratchpadView {
  text: string;
  omittedCompletedSteps: number;
  truncated: boolean;
}

export interface ScratchpadViewOptions {
  /** 用户请求已单独投影时，不重复任务原文。 */
  includeTask?: boolean;
  /** Completed steps rendered (most recent first). */
  maxCompletedSteps?: number;
  /** Clip length for a step's input / next step. */
  maxFieldChars?: number;
  /** Clip length for failure and invalid-result text. */
  maxNoteChars?: number;
  /** Clip length for the task line. */
  maxTaskChars?: number;
}

const DEFAULTS = {
  maxCompletedSteps: 4,
  maxFieldChars: 160,
  maxNoteChars: 200,
  maxTaskChars: 300,
};

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 16))}…[truncated]`;
}

export function renderBoundedScratchpadView(
  pad: ScratchpadView,
  options: ScratchpadViewOptions = {},
): BoundedScratchpadView {
  const maxCompletedSteps = options.maxCompletedSteps ?? DEFAULTS.maxCompletedSteps;
  const maxFieldChars = options.maxFieldChars ?? DEFAULTS.maxFieldChars;
  const maxNoteChars = options.maxNoteChars ?? DEFAULTS.maxNoteChars;
  const maxTaskChars = options.maxTaskChars ?? DEFAULTS.maxTaskChars;
  const includeTask = options.includeTask !== false;

  const keptSteps = pad.completedSteps.slice(-maxCompletedSteps);
  const omittedCompletedSteps = pad.completedSteps.length - keptSteps.length;
  const steps =
    keptSteps.length > 0
      ? keptSteps
          .map((step) => `  ${step.step}. ${step.tool}("${clip(step.input, maxFieldChars)}")`)
          .join('\n')
      : '  (暂无)';
  const fails =
    pad.failedSteps.length > 0
      ? pad.failedSteps
          .slice(-10)
          .map(
            (failure) =>
              `  - ${failure.tool}("${clip(failure.input, maxFieldChars)}") 已失败 ${failure.retries} 次: ` +
              clip(failure.error, maxNoteChars),
          )
          .join('\n')
      : '  (无)';
  const invalids =
    pad.invalidSteps.length > 0
      ? pad.invalidSteps
          .slice(-10)
          .map(
            (step) =>
              `  - ${step.tool}("${clip(step.input, maxFieldChars)}") 结果无效: ` +
              clip(step.reason, maxNoteChars),
          )
          .join('\n')
      : '  (无)';
  const text = [
    '[工具执行记录]',
    ...(includeTask ? [`任务: ${clip(pad.task, maxTaskChars)}`] : []),
    `已执行 ${pad.completedSteps.length} 次调用（最近 ${keptSteps.length} 次）:`,
    ...(omittedCompletedSteps > 0 ? [`  … 已省略更早 ${omittedCompletedSteps} 次调用`] : []),
    steps,
    ...(pad.failedSteps.length ? ['失败记录:', fails] : []),
    ...(pad.invalidSteps.length ? ['无效结果记录:', invalids] : []),
    ...(pad.nextStep
      ? [`待执行调用: ${pad.nextStep.tool}("${clip(pad.nextStep.input, maxFieldChars)}")`]
      : []),
  ].join('\n');

  return {
    text,
    omittedCompletedSteps,
    truncated:
      omittedCompletedSteps > 0 ||
      (includeTask && pad.task.length > maxTaskChars) ||
      pad.completedSteps.some((step) => step.input.length > maxFieldChars) ||
      pad.failedSteps.length > 10 ||
      pad.failedSteps.some(
        (failure) => failure.error.length > maxNoteChars || failure.input.length > maxFieldChars,
      ) ||
      pad.invalidSteps.length > 10 ||
      pad.invalidSteps.some(
        (step) => step.reason.length > maxNoteChars || step.input.length > maxFieldChars,
      ),
  };
}
