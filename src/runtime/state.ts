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
  successfulToolCalls: number; // 成功执行次数（execute 维度：未抛异常）
  failedToolCalls: number; // 失败次数（execute 抛异常）
  invalidToolResults: number; // 执行成功但结果无效次数（结果有效性维度，与成功/失败正交）
  startTime: string; // 启动时间
  currentError?: string; // 当前正在处理的错误（工具成功后清空，不保留历史）
  pendingAction?: PendingAction; // 当前待执行动作（失败恢复时引导 LLM 的依据）
  lastToolError?: ToolErrorInfo; // 最近一次工具失败信息（历史，不随成功清空）
}

// ---- 创建初始 State（runId 由外部统一生成，保证 State/Trace/Checkpoint 一致）----
export function createState(task: string, runId: string): AgentState {
  return {
    runId,
    task,
    status: "running",
    iteration: 0,
    currentStep: "start",
    toolCalls: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    invalidToolResults: 0,
    startTime: new Date().toISOString(),
    currentError: undefined,
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
