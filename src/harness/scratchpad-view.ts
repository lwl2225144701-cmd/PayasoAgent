export interface ScratchpadView {
  task: string;
  completedSteps: Array<{ step: number; tool: string; input: string; result: string }>;
  failedSteps: Array<{ tool: string; input: string; error: string; retries: number }>;
  invalidSteps: Array<{ tool: string; input: string; result: unknown; reason: string }>;
  nextStep: { tool: string; input: string } | null;
  lastResult: string;
}

// This is the model-facing projection of Runtime scratchpad state. Keeping the
// renderer in Harness prevents execution state from deciding its own prompt.
export function renderScratchpadView(pad: ScratchpadView): string {
  const steps = pad.completedSteps.length > 0
    ? pad.completedSteps.map((s) => `  ${s.step}. ${s.tool}("${s.input}") → ${s.result}`).join("\n")
    : "  (暂无)";
  const fails = pad.failedSteps.length > 0
    ? pad.failedSteps.map((f) =>
        `  - ${f.tool}("${f.input}") 已失败 ${f.retries} 次: ${f.error}（禁止再次调用相同参数）`
      ).join("\n")
    : "  (无)";
  const invalids = pad.invalidSteps.length > 0
    ? pad.invalidSteps.map((s) =>
        `  - ${s.tool}("${s.input}") 结果无效: ${s.reason}（已记录，不要重复依赖该结果）`
      ).join("\n")
    : "  (无)";
  const next = pad.nextStep
    ? `  ${pad.nextStep.tool}("${pad.nextStep.input}")`
    : "  (等待 LLM 决策，请判断是否需要继续调用工具)";

  return [
    "[执行进度 Scratchpad]",
    `任务: ${pad.task}`,
    "已完成步骤:",
    steps,
    "失败记录:",
    fails,
    "无效结果记录:",
    invalids,
    "下一步:",
    next,
    `上次结果: ${pad.lastResult || "(暂无)"}`,
    "请基于以上进度继续：不要重复已完成的步骤，禁止重复调用失败记录中的相同参数，已记录为\"无效结果\"的步骤不要重复依赖，优先参考\"下一步\"。",
  ].join("\n");
}
