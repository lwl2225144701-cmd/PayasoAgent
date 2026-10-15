// 模块: LLM 适配的公开契约（类型层）—— PayasoAgent 旧 ChatMessage 契约与 pi-ai 之间的桥接类型
// 职责边界：只放类型与接口，零运行逻辑；src/ 各处（runtime/harness/host/tools）都从
//   这里经 llm.ts 再导出拿契约。拆分层级：llm-types（契约）→ llm-messages（消息转换）
//   → llm-sse / llm-transport（线路与重试）→ llm.ts（编排与模型装配）。

import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { TextAttachmentRef } from '../attachment-types.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// 多模态图片块。canonical transcript / checkpoint 中只存 workspace 相对路径
// （path）与内容键（sha256，P0 起随附件写入产生，可直接推导内容寻址库内
// 对象路径）；base64（data）仅在发起 LLM 请求前物化到模型视图，绝不持久化。
export interface MessageImage {
  mimeType: string;
  // Workspace 相对路径（如 input/attachments/a.png），由 Runtime 在调用边界解析。
  path?: string;
  // 内容寻址键（.data/attachments/v1 内 objects/<前2>/<sha256>），附件写入时产生。
  sha256?: string;
  // 归一化后像素尺寸 / 归一化前原图尺寸（如 "5000x3000"，仅超预算下采样时记录）。
  width?: number;
  height?: number;
  originalDimensions?: string;
  // 临时 base64（无 data: 前缀），只存在于本轮模型视图。
  data?: string;
}

export interface ChatMessage {
  /** 文本附件引用保留在 canonical transcript，不作为 Provider 文件块。 */
  textAttachments?: TextAttachmentRef[];
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  // user / tool 消息可携带图片（user 附件或 read 工具读出的工作区图片）。
  images?: MessageImage[];
}

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface ChatStreamDelta {
  messageId: string;
  // shell_output_delta 不走 LLM：它是前台 shell 的 stdout/stderr 增量，由工具执行层
  // 借同一条流式通道推给 UI。复用该通道而**不是**发 TraceEvent，是因为 delta 不应
  // 作为 trace step 持久化（否则每个输出块都会写进 trace/checkpoint）。
  // 其 messageId 取工具调用 id，便于前端把输出归到对应的工具行。
  type: 'assistant_delta' | 'reasoning_delta' | 'shell_output_delta';
  delta: string;
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId?: string;
  // pi-ai 内置 Provider id；为空时使用通用 OpenAI-compatible Provider。
  piProviderId?: string;
  // 会话级路由标识。OpenCode Go 要求通过 x-opencode-session 传递它，
  // 让同一 Payaso 会话始终路由到同一个上游会话。
  sessionId?: string;
  // Host 按模型解析的能力覆盖（设置页按模型配置；缺省走注册表/fallback），
  // 用于本请求的 max_tokens 与 Harness 的 Context Budget。
  contextWindow?: number;
  maxOutputTokens?: number;
  // 视觉能力：为 true 时模型 input 声明包含 image，pi-ai 才会把图片块
  // 转成 image_url / 原生多模态协议。Host 按"设置位 || pi-ai 注册表"解析。
  vision?: boolean;
  // 思考档次（设置页按模型配置；缺省 undefined = 请求不带思考参数）。
  // pi-ai 内置模型按注册表 thinkingLevelMap 映射厂商参数（如 deepseek
  // 发 thinking:{type} + reasoning_effort）；自定义 OpenAI 兼容端点发
  // reasoning_effort（模型 reasoning 默认开启，档次随时可配）。
  thinkingLevel?: ModelThinkingLevel;
}

// ---- 分层超时策略（docs/plans/long-task-timeout-plan.md 步骤 2）----
// LLM 层不再设"单请求总时限"（那会掐断持续输出中的长生成），改为两个边界：
// - connectMs：HTTP 请求发出到响应头返回（覆盖 TCP/TLS/排队挂死）
// - idleMs：流式事件之间的最大空档（prefill 首 token 等待也计入；收到数据即续期，
//   持续输出永不触发）
// 缺省为正数、非法 env 值回退缺省（fail-closed，绝不因配置错误放开限制）。
export interface LlmTimeoutPolicy {
  connectMs: number;
  idleMs: number;
}

/** resolveEndpointConfig 的解析产物：Host 快照或 CLI/env 回退，二选一后的权威三元组。 */
export interface ResolvedEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: string;
  piProviderId?: string;
  sessionId?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision: boolean;
  thinkingLevel?: ModelThinkingLevel;
}
