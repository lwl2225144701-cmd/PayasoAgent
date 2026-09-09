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
  maxCompletedSteps: 12,
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
              `${clip(failure.error, maxNoteChars)}（禁止再次调用相同参数）`,
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
              `${clip(step.reason, maxNoteChars)}（已记录，不要重复依赖该结果）`,
          )
          .join('\n')
      : '  (无)';
  const next = pad.nextStep
    ? `  ${pad.nextStep.tool}("${clip(pad.nextStep.input, maxFieldChars)}")`
    : '  (等待 LLM 决策，请判断是否需要继续调用工具)';

  const header =
    omittedCompletedSteps > 0
      ? `已完成步骤: 共 ${pad.completedSteps.length} 步（最近 ${keptSteps.length} 步）`
      : '已完成步骤:';

  const text = [
    '[执行进度 Scratchpad]',
    `任务: ${clip(pad.task, maxTaskChars)}`,
    header,
    ...(omittedCompletedSteps > 0 ? [`  … 已省略更早 ${omittedCompletedSteps} 步`] : []),
    steps,
    '失败记录:',
    fails,
    '无效结果记录:',
    invalids,
    '下一步:',
    next,
    '请基于以上进度继续：不要重复已完成的步骤，禁止重复调用失败记录中的相同参数，已记录为"无效结果"的步骤不要重复依赖，优先参考"下一步"。工具结果请以对话历史中的实际输出为准。',
  ].join('\n');

  return {
    text,
    omittedCompletedSteps,
    truncated:
      omittedCompletedSteps > 0 ||
      pad.task.length > maxTaskChars ||
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
