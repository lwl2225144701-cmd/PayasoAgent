// 前端类型定义 — 对齐后端 HostEvent / HostRun / FileEntry

export type HostRunStatus = "running" | "completed" | "failed" | "stopped";

export interface HostRun {
  runId: string;
  task: string;
  status: HostRunStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
}

export interface FileEntry {
  name: string;
  size: number;
}

// Runtime Trace 事件
export interface TraceEventBase {
  step: number;
  timestamp: string;
}

export interface LlmCallEvent extends TraceEventBase {
  type: "llm_call";
  messageCount: number;
  iteration: number;
  response: string;
  reasoning?: string;
  hasToolCalls: boolean;
}

export interface ToolCallEvent extends TraceEventBase {
  type: "tool_call";
  tool: string;
  args: unknown;
}

export interface ToolResultEvent extends TraceEventBase {
  type: "tool_result";
  tool: string;
  result: string;
  durationMs: number;
}

export interface ToolResultInvalidEvent extends TraceEventBase {
  type: "tool_result_invalid";
  tool: string;
  result: unknown;
  reason: string;
}

export interface FinalAnswerEvent extends TraceEventBase {
  type: "final_answer";
  content: string;
  totalSteps: number;
}

export interface ToolErrorEvent extends TraceEventBase {
  type: "tool_error";
  tool: string;
  error: string;
  attempt: number;
  exhausted: boolean;
}

export interface ContextTrimEvent extends TraceEventBase {
  type: "context_trim";
  beforeMessages: number;
  afterMessages: number;
}

export interface RecoveryDecisionEvent extends TraceEventBase {
  type: "recovery_decision";
  tool: string;
  decision: string;
}

export interface SideEffectSkipEvent extends TraceEventBase {
  type: "side_effect_skip";
  tool: string;
  key: string;
  replayed: boolean;
}

export interface SideEffectUncertainEvent extends TraceEventBase {
  type: "side_effect_uncertain";
  tool: string;
  key: string;
}

export interface ToolOutputTruncatedEvent extends TraceEventBase {
  type: "tool_output_truncated";
  tool: string;
  originalBytes: number;
  returnedBytes: number;
}

export interface ShellSandboxStartedEvent extends TraceEventBase {
  type: "shell_sandbox_started";
  platform: "macos";
}

export interface ShellSandboxDeniedEvent extends TraceEventBase {
  type: "shell_sandbox_denied";
  platform: "macos";
  reason: "workspace_policy";
}

export interface ScratchpadUpdateEvent extends TraceEventBase {
  type: "scratchpad_update";
  currentStep: string;
  completedSteps: number;
  lastResult: string;
}

export interface ErrorEvent extends TraceEventBase {
  type: "error";
  message: string;
}

// Host 生命周期事件（无 step 字段）
export interface RunStartedEvent {
  type: "run_started";
  runId: string;
  timestamp: string;
}

export interface RunCompletedEvent {
  type: "run_completed";
  runId: string;
  timestamp: string;
  result?: string;
}

export interface RunFailedEvent {
  type: "run_failed";
  runId: string;
  timestamp: string;
  error?: string;
}

export interface RunStoppedEvent {
  type: "run_stopped";
  runId: string;
  timestamp: string;
}

export type TraceEvent =
  | LlmCallEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolResultInvalidEvent
  | FinalAnswerEvent
  | ToolErrorEvent
  | ContextTrimEvent
  | RecoveryDecisionEvent
  | SideEffectSkipEvent
  | SideEffectUncertainEvent
  | ToolOutputTruncatedEvent
  | ShellSandboxStartedEvent
  | ShellSandboxDeniedEvent
  | ScratchpadUpdateEvent
  | ErrorEvent;

export type LifecycleEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunStoppedEvent;

export type HostEvent = TraceEvent | LifecycleEvent;

// 用户消息（前端派生，不在 SSE 中）
export interface UserMessageEvent {
  type: "user_message";
  content: string;
  timestamp: string;
}

export type TimelineItem = HostEvent | UserMessageEvent;
