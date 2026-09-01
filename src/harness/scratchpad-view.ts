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

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 16))}…[truncated]`;
}

// This is the model-facing projection of Runtime scratchpad state. Keeping the
// renderer in Harness prevents execution state from deciding its own prompt.
export function renderScratchpadView(pad: ScratchpadView): string {
  return renderBoundedScratchpadView(pad).text;
}

export function renderBoundedScratchpadView(
  pad: ScratchpadView,
  options: { maxCompletedSteps?: number; maxFieldChars?: number } = {},
): BoundedScratchpadView {
  const maxCompletedSteps = options.maxCompletedSteps ?? 20;
  const maxFieldChars = options.maxFieldChars ?? 1_000;
  const keptSteps = pad.completedSteps.slice(-maxCompletedSteps);
  const omittedCompletedSteps = pad.completedSteps.length - keptSteps.length;
  const steps = keptSteps.length > 0
    ? keptSteps.map((s) =>
        `  ${s.step}. ${s.tool}("${clip(s.input, maxFieldChars)}") → ${clip(s.result, maxFieldChars)}`
      ).join("\n")
    : "  (暂无)";
  const fails = pad.failedSteps.length > 0
    ? pad.failedSteps.slice(-10).map((f) =>
        `  - ${f.tool}("${clip(f.input, maxFieldChars)}") 已失败 ${f.retries} 次: ${clip(f.error, maxFieldChars)}（禁止再次调用相同参数）`
      ).join("\n")
    : "  (无)";
  const invalids = pad.invalidSteps.length > 0
    ? pad.invalidSteps.slice(-10).map((s) =>
        `  - ${s.tool}("${clip(s.input, maxFieldChars)}") 结果无效: ${clip(s.reason, maxFieldChars)}（已记录，不要重复依赖该结果）`
      ).join("\n")
    : "  (无)";
  const next = pad.nextStep
    ? `  ${pad.nextStep.tool}("${clip(pad.nextStep.input, maxFieldChars)}")`
    : "  (等待 LLM 决策，请判断是否需要继续调用工具)";

  const text = [
    "[执行进度 Scratchpad]",
    `任务: ${clip(pad.task, maxFieldChars * 2)}`,
    "已完成步骤:",
    ...(omittedCompletedSteps > 0 ? [`  … 已省略更早 ${omittedCompletedSteps} 步`] : []),
    steps,
    "失败记录:",
    fails,
    "无效结果记录:",
    invalids,
    "下一步:",
    next,
    `上次结果: ${pad.lastResult ? clip(pad.lastResult, maxFieldChars) : "(暂无)"}`,
    "请基于以上进度继续：不要重复已完成的步骤，禁止重复调用失败记录中的相同参数，已记录为\"无效结果\"的步骤不要重复依赖，优先参考\"下一步\"。",
  ].join("\n");
  return {
    text,
    omittedCompletedSteps,
    truncated: omittedCompletedSteps > 0
      || pad.completedSteps.some((step) => step.input.length > maxFieldChars || step.result.length > maxFieldChars)
      || pad.failedSteps.length > 10
      || pad.invalidSteps.length > 10,
  };
}
