// 模块: Agent Scratchpad — 短期执行进度（非 Memory，进程内状态，不随 messages 裁剪丢失）

// 单个已完成步骤的结构化记录
export interface ScratchpadStep {
  step: number; // 步骤序号（从 1 开始）
  tool: string; // 调用的工具名
  input: string; // 工具输入（如表达式）
  result: string; // 工具返回结果
}

// 待执行的下一步动作（由 LLM 决策产生）
export interface NextStep {
  tool: string; // 计划调用的工具
  input: string; // 计划传入的参数
}

// 失败的步骤记录（防死循环：同 tool+input 失败超限后禁止再次调用）
export interface FailedStep {
  tool: string; // 失败的工具
  input: string; // 失败的参数
  error: string; // 错误信息
  retries: number; // 已失败尝试次数
}

export interface Scratchpad {
  task: string; // 用户任务
  completedSteps: ScratchpadStep[]; // 已完成的步骤（结构化）
  failedSteps: FailedStep[]; // 失败的步骤（不推进进度）
  nextStep: NextStep | null; // 下一步动作（null = 等待 LLM 决策）
  lastResult: string; // 最近一次工具结果
}

// 创建初始 Scratchpad
export function createScratchpad(task: string): Scratchpad {
  return {
    task,
    completedSteps: [],
    failedSteps: [],
    nextStep: null,
    lastResult: "",
  };
}

// LLM 发出 tool_call 时调用：记录计划执行的下一步（尚未完成，不进 completedSteps）
export function setNextStep(
  pad: Scratchpad,
  next: { tool: string; input: string }
): void {
  pad.nextStep = { tool: next.tool, input: next.input };
}

// 工具成功执行后调用：将 nextStep 移入 completedSteps，清空下一步，记录结果
export function completeStep(pad: Scratchpad, result: string): void {
  if (pad.nextStep) {
    pad.completedSteps.push({
      step: pad.completedSteps.length + 1, // 自动编号
      tool: pad.nextStep.tool,
      input: pad.nextStep.input,
      result,
    });
  }
  pad.nextStep = null; // 该步已完成，等待 LLM 决策下一步
  pad.lastResult = result;
}

// 工具执行失败后调用：记录失败步骤（不推进 completedSteps，不推进 nextStep）
export function recordFailure(
  pad: Scratchpad,
  fail: { tool: string; input: string; error: string }
): void {
  const existing = pad.failedSteps.find(
    (f) => f.tool === fail.tool && f.input === fail.input
  );
  if (existing) {
    existing.retries += 1;
    existing.error = fail.error;
  } else {
    pad.failedSteps.push({ ...fail, retries: 1 });
  }
}

// 防死循环：相同 tool + 相同 input 失败次数超过 maxRetries 时禁止再次调用
export function isBlocked(
  pad: Scratchpad,
  tool: string,
  input: string,
  maxRetries: number
): boolean {
  const f = pad.failedSteps.find((s) => s.tool === tool && s.input === input);
  return !!f && f.retries > maxRetries;
}

// 工具成功后解禁（清除该 tool+input 的失败记录）
export function clearFailure(
  pad: Scratchpad,
  tool: string,
  input: string
): void {
  pad.failedSteps = pad.failedSteps.filter(
    (f) => !(f.tool === tool && f.input === input)
  );
}

// 序列化为文本，注入 system prompt。
// 即使消息历史被 ContextManager 裁剪，LLM 仍能从 system 看到完整执行进度。
export function toSystemText(pad: Scratchpad): string {
  const steps =
    pad.completedSteps.length > 0
      ? pad.completedSteps
          .map((s) => `  ${s.step}. ${s.tool}("${s.input}") → ${s.result}`)
          .join("\n")
      : "  (暂无)";
  const fails =
    pad.failedSteps.length > 0
      ? pad.failedSteps
          .map(
            (f) =>
              `  - ${f.tool}("${f.input}") 已失败 ${f.retries} 次: ${f.error}（禁止再次调用相同参数）`
          )
          .join("\n")
      : "  (无)";
  const next = pad.nextStep
    ? `  ${pad.nextStep.tool}("${pad.nextStep.input}")`
    : "  (等待 LLM 决策，请判断是否需要继续调用工具)";
  return [
    "[执行进度 Scratchpad]",
    `任务: ${pad.task}`,
    `已完成步骤:`,
    steps,
    `失败记录:`,
    fails,
    `下一步:`,
    next,
    `上次结果: ${pad.lastResult || "(暂无)"}`,
    `请基于以上进度继续：不要重复已完成的步骤，禁止重复调用失败记录中的相同参数，优先参考"下一步"。`,
  ].join("\n");
}

// 打印当前 Scratchpad（每步实时输出）
export function printScratchpad(pad: Scratchpad): void {
  console.log("\n=== Scratchpad ===");
  console.log(JSON.stringify(pad, null, 2));
}
