// 前端类型定义 — 对齐后端 HostEvent / HostRun / FileEntry

// stopping（v1.6）：用户已请求停止（abort 已发出），执行尚未真正退出
export type HostRunStatus =
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';
export type PermissionMode = 'read-only' | 'workspace-write' | 'full-access';

export interface HostRun {
  runId: string;
  sessionId: string;
  turnIndex: number;
  task: string;
  status: HostRunStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  workspace?: WorkspaceView;
  model?: string;
  permissionMode: PermissionMode;
}

export interface HostSession {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspace?: WorkspaceView;
}

export interface WorkspaceView {
  name: string;
}

export interface FileEntry {
  name: string;
  /** 事件派生的文件（write/edit 产物）没有 stat 大小；工作区列出的文件才有。 */
  size?: number;
}

// 模型配置 — 对齐后端 ModelProviderView / StoredModelProvider
export interface ModelCapabilitySetting {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelProviderView {
  id: string;
  kind: 'builtin' | 'custom';
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  models: string[];
  modelCapabilities?: Record<string, ModelCapabilitySetting>;
  status: 'unconfigured' | 'configured' | 'available' | 'error' | 'checking';
}

export interface CreateModelProviderInput {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  modelCapabilities?: Record<string, ModelCapabilitySetting>;
}

export interface UpdateModelProviderInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string | null;
  models?: string[];
  modelCapabilities?: Record<string, ModelCapabilitySetting>;
}

// 默认模型（provider + model 成对）— 对齐后端 GET/POST /settings(/default) 响应
export interface DefaultModelView {
  defaultProviderId: string;
  defaultModelId: string;
}

// 输入栏模型下拉的当前选择（由 DefaultModelView + ModelProviderView 列表派生）
export interface ModelSelection {
  providerId: string;
  providerName: string;
  model: string;
}

// Runtime Trace 事件
export interface TraceEventBase {
  step: number;
  timestamp: string;
}

export interface LlmCallEvent extends TraceEventBase {
  type: 'llm_call';
  messageCount: number;
  iteration: number;
  response: string;
  reasoning?: string;
  hasToolCalls: boolean;
}

export interface ToolCallEvent extends TraceEventBase {
  type: 'tool_call';
  tool: string;
  args: unknown;
}

// v1.6：模型生成的 tool_call 未通过 invocation 校验（malformed JSON/非对象/未知工具），
// 可恢复 invocation error —— 工具不执行，结构化错误回传模型修正
export interface ToolCallInvalidEvent extends TraceEventBase {
  type: 'tool_call_invalid';
  toolCallId: string;
  tool: string;
  code: 'INVALID_ARGUMENT_JSON' | 'INVALID_ARGUMENTS' | 'TOOL_NOT_FOUND';
}

export interface ToolResultEvent extends TraceEventBase {
  type: 'tool_result';
  tool: string;
  result: string;
  durationMs: number;
}

export interface ToolResultInvalidEvent extends TraceEventBase {
  type: 'tool_result_invalid';
  tool: string;
  result: unknown;
  reason: string;
}

export interface FinalAnswerEvent extends TraceEventBase {
  type: 'final_answer';
  content: string;
  totalSteps: number;
}

export interface ToolErrorEvent extends TraceEventBase {
  type: 'tool_error';
  tool: string;
  error: string;
  attempt: number;
  exhausted: boolean;
}

export interface ContextTrimEvent extends TraceEventBase {
  type: 'context_trim';
  beforeMessages: number;
  afterMessages: number;
}

export interface ContextUsageEvent extends TraceEventBase {
  type: 'context_usage';
  model: string;
  modelSource: 'run' | 'env';
  configSource: 'settings' | 'env' | 'model_registry' | 'fallback';
  emergencyTrim?: boolean;
  contextWindowTokens: number;
  maxOutputTokens: number;
  safetyTokens: number;
  inputBudgetTokens: number;
  messageTokens: number;
  toolSchemaTokens: number;
  scratchpadTokens: number;
  estimatedInputTokens: number;
  usageRatio: number;
  trimmedMessages: number;
  overBudget: boolean;
}

export interface ContextCompactionEvent extends TraceEventBase {
  type: 'context_compaction';
  summarizedMessages: number; // 本次新摘要的消息数
  totalSummarizedMessages: number; // 累计已摘要消息数
  summaryTokens: number; // 摘要占用 token
}

export interface RecoveryDecisionEvent extends TraceEventBase {
  type: 'recovery_decision';
  tool: string;
  decision: string;
}

export interface SideEffectSkipEvent extends TraceEventBase {
  type: 'side_effect_skip';
  tool: string;
  key: string;
  replayed: boolean;
}

export interface SideEffectUncertainEvent extends TraceEventBase {
  type: 'side_effect_uncertain';
  tool: string;
  key: string;
}

export interface ToolOutputTruncatedEvent extends TraceEventBase {
  type: 'tool_output_truncated';
  tool: string;
  originalBytes: number;
  returnedBytes: number;
}

export interface ShellSandboxStartedEvent extends TraceEventBase {
  type: 'shell_sandbox_started';
  platform: 'macos';
}

export interface ShellSandboxDeniedEvent extends TraceEventBase {
  type: 'shell_sandbox_denied';
  platform: 'macos';
  reason: 'workspace_policy';
}

export interface ScratchpadUpdateEvent extends TraceEventBase {
  type: 'scratchpad_update';
  currentStep: string;
  completedSteps: number;
  lastResult: string;
}

export interface ErrorEvent extends TraceEventBase {
  type: 'error';
  message: string;
}

// Host 生命周期事件（无 step 字段）
export interface RunStartedEvent {
  type: 'run_started';
  runId: string;
  timestamp: string;
}

// 用户已请求停止（run_stopping）；执行真正退出后才会收到 run_stopped
export interface RunStoppingEvent {
  type: 'run_stopping';
  runId: string;
  timestamp: string;
}

export interface RunCompletedEvent {
  type: 'run_completed';
  runId: string;
  timestamp: string;
  result?: string;
}

export interface RunFailedEvent {
  type: 'run_failed';
  runId: string;
  timestamp: string;
  error?: string;
}

export interface RunStoppedEvent {
  type: 'run_stopped';
  runId: string;
  timestamp: string;
}

export interface RunInterruptedEvent {
  type: 'run_interrupted';
  runId: string;
  timestamp: string;
  error: string;
}

export interface StreamingEvent {
  type: 'assistant_delta' | 'reasoning_delta';
  runId: string;
  messageId: string;
  timestamp: string;
  delta: string;
}

export type TraceEvent =
  | LlmCallEvent
  | ToolCallEvent
  | ToolCallInvalidEvent
  | ToolResultEvent
  | ToolResultInvalidEvent
  | FinalAnswerEvent
  | ToolErrorEvent
  | ContextTrimEvent
  | ContextUsageEvent
  | ContextCompactionEvent
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
  | RunStoppingEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunStoppedEvent
  | RunInterruptedEvent;

// v2.0.1 JIT Approval：网络访问批准请求推送
export interface ApprovalRequestedEvent {
  type: 'approval_requested';
  runId: string;
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  timestamp: string;
}

export interface ApprovalResolvedEvent {
  type: 'approval_resolved';
  runId: string;
  requestId: string;
  approved: boolean;
  timestamp: string;
}

export type ToolchainPreparationPhase = 'checking' | 'installing' | 'verifying';
export type ToolchainPreparationStatus =
  | 'prepared'
  | 'denied'
  | 'unavailable'
  | 'failed'
  | 'aborted'
  | 'timed_out';

export interface ToolchainPreparationRequestedEvent {
  type: 'toolchain_preparation_requested';
  runId: string;
  requestId: string;
  toolName: string;
  packageName: string;
  source: 'homebrew';
  timestamp: string;
}

export interface ToolchainPreparationResolvedEvent {
  type: 'toolchain_preparation_resolved';
  runId: string;
  requestId: string;
  approved: boolean;
  prepared: boolean;
  status: ToolchainPreparationStatus;
  message?: string;
  timestamp: string;
}

export interface ToolchainPreparationStartedEvent {
  type: 'toolchain_preparation_started';
  runId: string;
  requestId: string;
  toolName: string;
  packageName: string;
  source: 'homebrew';
  phase: 'checking';
  timestamp: string;
}

export interface ToolchainPreparationProgressEvent {
  type: 'toolchain_preparation_progress';
  runId: string;
  requestId: string;
  phase: Exclude<ToolchainPreparationPhase, 'checking'>;
  timestamp: string;
}

export type ApprovalEvent =
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ToolchainPreparationRequestedEvent
  | ToolchainPreparationResolvedEvent
  | ToolchainPreparationStartedEvent
  | ToolchainPreparationProgressEvent;

export type HostEvent = TraceEvent | LifecycleEvent | StreamingEvent | ApprovalEvent;

// 用户消息（前端派生，不在 SSE 中）
export interface UserMessageEvent {
  type: 'user_message';
  content: string;
  timestamp: string;
}

export type TimelineItem = HostEvent | UserMessageEvent;
