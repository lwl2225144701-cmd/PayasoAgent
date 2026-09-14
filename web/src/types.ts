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

/** Shell 隔离能力（GET /runtime/capabilities 的 shellIsolation 字段，诚实分级）：
 *  partial 必须对 UI 可见——Windows ACL 为部分写入隔离，读与网络不受限。 */
export interface ShellIsolationCapabilities {
  executor: 'macos-seatbelt' | 'windows-acl' | 'uncontained-gated';
  enforcement: 'full' | 'partial' | 'none';
  writeIsolation: 'full' | 'partial' | 'none';
  readIsolation: 'full' | 'none';
  networkIsolation: 'os-level' | 'none';
}

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
  providerId?: string;
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

// 会话级统计投影（host GET /sessions/:id/stats）——底部统计条 StatsBar 数据源
// （v2.3 起从顶栏挪到 composer 下方；读数口径不变）。
export interface SessionStats {
  turns: number;
  steps: number;
  llmCalls: number;
  toolCalls: number;
  toolMs: number;
  /** 各 Run 首 token 延迟之和；配合 ttftCount 取平均。 */
  ttftMs: number;
  ttftCount: number;
  decodeMs: number;
  decodeCount: number;
  tokens: number;
  durationMs: number;
}

export interface WorkspaceView {
  name: string;
}

export interface DirectoryPickerCapability {
  kind: 'native' | 'browse';
}

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface DirectoryListing {
  path: string;
  home: string;
  crumbs: DirectoryEntry[];
  entries: DirectoryEntry[];
  truncated: boolean;
}

export interface WorkspacePickerState {
  capability: DirectoryPickerCapability | null;
  listing: DirectoryListing | null;
  loading: boolean;
  error: string | null;
}

/** 当前工作区可用的 Prompt 命令（/cmd 补全元数据，不含模板正文） */
export interface PromptCommand {
  name: string;
  description: string;
}

export interface FileEntry {
  name: string;
  /** 事件派生的文件（write/edit 产物）没有 stat 大小；工作区列出的文件才有。 */
  size?: number;
}

// 模型配置 — 对齐后端 ModelProviderView / StoredModelProvider
// 思考档次：与 pi-ai 的 ThinkingLevel / ModelThinkingLevel 对齐。
// off = 显式关闭思考；其余为递进档次；未配置（undefined）= 跟随端点默认。
export type ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelCapabilitySetting {
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 模型是否支持图片输入（视觉能力）；显式配置优先于 pi-ai 注册表声明 */
  vision?: boolean;
  /** 思考档次（可选）；未配置时请求不带思考参数，由端点默认行为决定 */
  thinkingLevel?: ModelThinkingLevel;
}

export type ProviderModelCategory =
  | 'chat'
  | 'embedding'
  | 'rerank'
  | 'image'
  | 'audio'
  | 'moderation';

export interface ProviderModelInfo {
  id: string;
  category: ProviderModelCategory;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** pi-ai 注册表声明的图片输入能力（来自模型 input modalities） */
  vision?: boolean;
  /** pi-ai 注册表声明该模型支持的思考档次（来自 getSupportedThinkingLevels） */
  thinkingLevels?: ModelThinkingLevel[];
}

export interface PiAiModelInfo extends ProviderModelInfo {
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
}

export interface PiAiProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  models: PiAiModelInfo[];
}

export interface ModelProviderView {
  id: string;
  kind: 'builtin' | 'custom';
  name: string;
  baseUrl: string;
  piProviderId?: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  models: string[];
  modelCapabilities?: Record<string, ModelCapabilitySetting>;
  lastCheckedAt?: string;
  probeError?: string;
  status: 'unconfigured' | 'configured' | 'available' | 'error' | 'checking';
}

export interface CreateModelProviderInput {
  name: string;
  baseUrl?: string;
  piProviderId?: string;
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
  contextWindow?: number;
  maxOutputTokens?: number;
}

// Runtime Trace 事件
export interface TraceEventBase {
  step: number;
  timestamp: string;
}

// DISJOINT 桶语义（与 host 侧 src/llm/token-usage.ts 一致）：
// inputTokens = 未缓存输入；cache 命中/写入单独计桶；reasoningTokens ⊆ outputTokens。
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface LlmCallEvent extends TraceEventBase {
  type: 'llm_call';
  messageCount: number;
  iteration: number;
  response: string;
  reasoning?: string;
  hasToolCalls: boolean;
  usage?: TokenUsage;
}

// LLM 调用已发出、尚未收到任何流式增量（首 token 等待期的信号）
export interface LlmCallStartedEvent extends TraceEventBase {
  type: 'llm_call_started';
  iteration: number;
  messageCount: number;
  estimatedInputTokens?: number;
}

// Provider HTTP 请求真正发出（piFetch 内 fetch 调用前）。
// 与 llm_call_started 的间隔 = Host 侧整理耗时；与首个 delta 的间隔 = Provider 首包/网络。
export interface LlmRequestSentEvent extends TraceEventBase {
  type: 'llm_request_sent';
  iteration: number;
  attempt: number;
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

/** 工具产出的图片引用：工作区相对路径，二进制经 GET /runs/:id/files/<path> 读取 */
export interface TraceImage {
  mimeType: string;
  path: string;
}

export interface ToolResultEvent extends TraceEventBase {
  type: 'tool_result';
  tool: string;
  result: string;
  durationMs: number;
  /** 多模态工具结果附带的图片（如视觉模型读取图片文件） */
  images?: TraceImage[];
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
  systemTokens?: number;
  toolSchemaTokens: number;
  scratchpadTokens: number;
  /** Plan 投影注入 system 的估算 token（旧事件无此字段）。 */
  planTokens?: number;
  estimatedInputTokens: number;
  // 上次 provider 实际上报的 prompt 侧真实用量（未缓存输入 + cache 流量），
  // 环形指示器的真实压力锚点；首轮或 provider 未上报时缺省。
  pressureTokens?: number;
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

// v1.8 空回合不变量：模型没有可见输出，Harness 策略已追加恢复提示。
export interface EmptyTurnRecoveredEvent extends TraceEventBase {
  type: 'empty_turn_recovered';
  attempt: number;
  maxAttempts: number;
}

// Finalization guard：非空但明显未完成的文本回合，按 Harness 策略恢复或失败。
export interface FinalizationGuardEvent extends TraceEventBase {
  type: 'finalization_guard';
  reason: string;
  attempt: number;
  maxAttempts: number;
  disposition: 'retry' | 'fail';
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
  platform: 'macos' | 'windows';
  /** 可选：windows-acl 执行器为部分写入隔离（partial）；macOS 事件不携带该字段。 */
  enforcement?: 'full' | 'partial';
}

export interface ShellSandboxDeniedEvent extends TraceEventBase {
  type: 'shell_sandbox_denied';
  platform: 'macos' | 'windows';
  reason: 'workspace_policy';
}

export interface ScratchpadUpdateEvent extends TraceEventBase {
  type: 'scratchpad_update';
  currentStep: string;
  completedSteps: number;
  lastResult: string;
}

export interface PlanUpdateEvent extends TraceEventBase {
  type: 'plan_update';
  /** 单调递增：前端取 revision 最大的一条即可重建，对乱序/重放幂等。 */
  revision: number;
  /** 全量清单（不是增量）。 */
  items: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>;
  completed: number;
  total: number;
}

export interface PlanIncompleteAtFinishEvent extends TraceEventBase {
  type: 'plan_incomplete_at_finish';
  revision: number;
  completed: number;
  total: number;
  unfinished: Array<{ id: string; title: string; status: 'pending' | 'in_progress' }>;
}

/**
 * v2.3 后台任务完成通知：Agent Loop 在迭代边界把会话完成队列注入模型视图。
 * 只作观测（前端不新增恢复/继续交互）；未消费的通知仍留在会话队列。
 */
export interface BackgroundJobNotifiedEvent extends TraceEventBase {
  type: 'background_job_notified';
  jobs: Array<{ jobId: string; status: string }>;
}

export interface ErrorEvent extends TraceEventBase {
  type: 'error';
  message: string;
}

/** 用户随任务上传的图片附件（已落盘到会话工作区 input/attachments/） */
export interface RunAttachment {
  name: string;
  mimeType: string;
  path: string;
}

// Host 生命周期事件（无 step 字段）
export interface RunStartedEvent {
  type: 'run_started';
  runId: string;
  timestamp: string;
  attachments?: RunAttachment[];
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
  | LlmCallStartedEvent
  | LlmRequestSentEvent
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
  | EmptyTurnRecoveredEvent
  | FinalizationGuardEvent
  | SideEffectSkipEvent
  | SideEffectUncertainEvent
  | ToolOutputTruncatedEvent
  | ShellSandboxStartedEvent
  | ShellSandboxDeniedEvent
  | ScratchpadUpdateEvent
  | PlanUpdateEvent
  | PlanIncompleteAtFinishEvent
  | BackgroundJobNotifiedEvent
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
