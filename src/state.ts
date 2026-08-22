// State 模块 — 记录当前 Agent 执行状态（纯内存态，无持久化 / 无恢复）

export type AgentStatus = "running" | "completed" | "failed";

// 当前待执行的动作（LLM 已决定、尚未成功）
export interface PendingAction {
  tool: string;
  input: string;
}

// 最近一次工具失败信息
export interface ToolErrorInfo {
  tool: string; // 失败的工具
  input: string; // 失败时的参数
  error: string; // 错误信息
  retries: number; // 已失败尝试次数（从 1 开始）
}

export interface AgentState {
  runId: string; // 本次运行 ID
  task: string; // 用户任务
  status: AgentStatus; // 当前状态
  iteration: number; // 当前迭代次数
  currentStep: string; // 当前执行步骤描述
  toolCalls: number; // 总工具调用次数（每次 LLM 发起 tool_call 计 1）
  successfulToolCalls: number; // 成功执行次数
  failedToolCalls: number; // 失败次数
  startTime: string; // 启动时间
  error?: string; // 失败时的错误信息
  pendingAction?: PendingAction; // 当前待执行动作（失败恢复时引导 LLM 的依据）
  lastToolError?: ToolErrorInfo; // 最近一次工具失败信息
}

// ---- 创建初始 State ----
export function createState(task: string): AgentState {
  return {
    runId: crypto.randomUUID(),
    task,
    status: "running",
    iteration: 0,
    currentStep: "start",
    toolCalls: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    startTime: new Date().toISOString(),
    error: undefined,
  };
}

// ---- 局部更新（runId / startTime 不可变）----
export function updateState(
  state: AgentState,
  patch: Partial<Omit<AgentState, "runId" | "startTime">>
): AgentState {
  Object.assign(state, patch);
  return state;
}

// ---- 读取快照（返回拷贝，防止外部直接改动）----
export function getState(state: AgentState): AgentState {
  return { ...state };
}

// ---- 实时打印状态摘要（单行紧凑，每步输出）----
export function printStateSummary(state: AgentState): void {
  const err = state.error ? ` | error=${state.error}` : "";
  const pending = state.pendingAction
    ? ` | pending=${state.pendingAction.tool}(${state.pendingAction.input})`
    : "";
  const lastErr = state.lastToolError
    ? ` | lastErr=${state.lastToolError.tool}(${state.lastToolError.input})x${state.lastToolError.retries}`
    : "";
  console.log(
    `[State] ${state.status} | iter=${state.iteration} | step=${state.currentStep} | tools=${state.toolCalls}(ok:${state.successfulToolCalls}/fail:${state.failedToolCalls})${err}${pending}${lastErr}`
  );
}

// ---- 打印当前 State ----
export function printState(state: AgentState): void {
  console.log("\n=== Agent State ===");
  console.log(JSON.stringify(state, null, 2));
}
