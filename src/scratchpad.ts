// 模块: Agent Scratchpad — 短期执行进度（非 Memory，进程内状态，不随 messages 裁剪丢失）

export interface Scratchpad {
  task: string; // 用户任务
  completedSteps: string[]; // 已完成的步骤描述
  currentStep: string; // 当前/最近执行的步骤
  lastToolResult: string; // 最近一次工具结果
}

// 创建初始 Scratchpad
export function createScratchpad(task: string): Scratchpad {
  return {
    task,
    completedSteps: [],
    currentStep: "start",
    lastToolResult: "",
  };
}

// 工具结果后调用：记录刚完成的步骤 + 结果，并追加到已完成列表
export function updateScratchpad(
  pad: Scratchpad,
  step: string,
  result: string
): void {
  pad.currentStep = step;
  pad.lastToolResult = result;
  pad.completedSteps.push(step);
}

// 序列化为文本，注入 system prompt。
// 即使消息历史被 ContextManager 裁剪，LLM 仍能从 system 看到执行进度。
export function toSystemText(pad: Scratchpad): string {
  const steps =
    pad.completedSteps.length > 0
      ? pad.completedSteps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")
      : "  (暂无)";
  return [
    "[执行进度 Scratchpad]",
    `任务: ${pad.task}`,
    `已完成步骤:`,
    steps,
    `当前步骤: ${pad.currentStep}`,
    `上次工具结果: ${pad.lastToolResult || "(暂无)"}`,
  ].join("\n");
}

// 打印当前 Scratchpad（每步实时输出）
export function printScratchpad(pad: Scratchpad): void {
  console.log("\n=== Scratchpad ===");
  console.log(JSON.stringify(pad, null, 2));
}
