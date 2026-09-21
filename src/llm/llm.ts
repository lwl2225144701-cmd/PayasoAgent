// 模块 1: LLM 适配 — PayasoAgent 的旧 ChatMessage 契约由 pi-ai 驱动。
// Runtime 仍然消费本文件的 OpenAI 风格消息；Provider、认证、SSE/tool-call
// 拼装和请求重试交给 @earendil-works/pi-ai。

import {
  type Api,
  type AssistantMessage,
  type Context,
  createModels,
  createProvider,
  type ImageContent,
  type Model,
  type ModelThinkingLevel,
  type ProviderStreams,
  type ThinkingLevel,
  type TSchema,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { resolveModelContextConfig } from '../harness/model-context.js';
import { asProviderStreams, getPiAiProviderModel } from '../host/pi-ai-providers.js';
import { createIdleWatchdog, positiveIntMs, TimeoutAbortError } from '../util/timeout.js';
import { normalizeTokenUsage, type TokenUsage } from './token-usage.js';
import {
  mergeRawArguments,
  rawArgumentsByToolCallId,
  ToolArgumentAccumulator,
} from './tool-call-arguments.js';

const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_RETRIES = 2;

// ---- 分层超时策略（docs/long-task-timeout-plan.md 步骤 2）----
// LLM 层不再设"单请求总时限"（那会掐断持续输出中的长生成），改为两个边界：
// - connectMs：HTTP 请求发出到响应头返回（覆盖 TCP/TLS/排队挂死）
// - idleMs：流式事件之间的最大空档（prefill 首 token 等待也计入；收到数据即续期，
//   持续输出永不触发）
// 缺省为正数、非法 env 值回退缺省（fail-closed，绝不因配置错误放开限制）。
const DEFAULT_LLM_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_LLM_IDLE_TIMEOUT_MS = 120_000;
const LLM_TIMEOUT_MIN_MS = 1_000;

export interface LlmTimeoutPolicy {
  connectMs: number;
  idleMs: number;
}

export function llmTimeoutPolicy(
  env: Record<string, string | undefined> = process.env,
): LlmTimeoutPolicy {
  return {
    connectMs: Math.max(
      positiveIntMs(env.PAYASO_LLM_CONNECT_TIMEOUT_MS) ?? DEFAULT_LLM_CONNECT_TIMEOUT_MS,
      LLM_TIMEOUT_MIN_MS,
    ),
    idleMs: Math.max(
      positiveIntMs(env.PAYASO_LLM_IDLE_TIMEOUT_MS) ?? DEFAULT_LLM_IDLE_TIMEOUT_MS,
      LLM_TIMEOUT_MIN_MS,
    ),
  };
}

// 思考档次归一化：'off' 与未配置等价——两者都不介入请求，保持端点默认行为。
// 返回 undefined 表示"这次请求不配置思考档次"（走与引入该功能前一致的旧路径）。
function activeThinkingLevel(level: ModelThinkingLevel | undefined): ThinkingLevel | undefined {
  if (level === undefined || level === 'off') return undefined;
  return level;
}

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

import type { TextAttachmentRef } from '../attachment-types.js';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolCalls(value: unknown): ToolCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('LLM API malformed response: tool_calls must be an array');
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      item.type !== 'function' ||
      !isRecord(item.function)
    ) {
      throw new Error('LLM API malformed response: invalid tool_call');
    }
    const fn = item.function;
    if (typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
      throw new Error('LLM API malformed response: invalid tool_call function');
    }
    return { id: item.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
  });
}

function parseAssistantMessage(data: unknown): ChatMessage {
  if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error('LLM API malformed response: missing choices');
  }
  const choice = data.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new Error('LLM API malformed response: missing assistant message');
  }
  const msg = choice.message;
  if (msg.content !== undefined && msg.content !== null && typeof msg.content !== 'string') {
    throw new Error('LLM API malformed response: content must be a string or null');
  }
  return {
    role: 'assistant',
    content: typeof msg.content === 'string' ? msg.content : '',
    tool_calls: parseToolCalls(msg.tool_calls),
    reasoning_content:
      typeof msg.reasoning_content === 'string' ? msg.reasoning_content : undefined,
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : {};
  } catch {
    // pi-ai 的流式协议必须提供对象；PayasoAgent 的 Runtime 仍会在下一步
    // 对工具调用做最终的 JSON/契约校验，因此这里 fail-closed。
    return {};
  }
}

function zeroUsage(): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toPiTool(schema: ToolSchema) {
  return {
    name: schema.function.name,
    description: schema.function.description,
    // PayasoAgent 的注册表目前存的是已生成 JSON Schema；pi-ai 的 API 层
    // 接受同一份 JSON Schema，TypeBox 只在定义/校验 Tool 时提供类型能力。
    parameters: schema.function.parameters as TSchema,
  };
}

function findToolName(messages: ChatMessage[], toolCallId: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const call = message.tool_calls?.find((item) => item.id === toolCallId);
    if (call) return call.function.name;
  }
  return 'tool';
}

function toPiAssistant(
  message: ChatMessage,
  providerId: string,
  modelId: string,
  api: Api,
): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  if (message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }
  if (message.content) content.push({ type: 'text', text: message.content });
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: 'toolCall',
      id: call.id,
      name: call.function.name,
      arguments: parseToolArguments(call.function.arguments),
    });
  }
  return {
    role: 'assistant',
    content,
    api,
    provider: providerId,
    model: modelId,
    usage: zeroUsage(),
    stopReason: message.tool_calls?.length ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
}

// 把消息上的图片引用转成 pi-ai ImageContent 块。只有已物化 base64（data）的
// 图片才会进入模型请求：canonical transcript / checkpoint 中只存 path，
// 由 Runtime 在调用边界物化；未物化的图片（如摘要器的裁剪消息）直接跳过。
function toPiImageBlocks(images: ChatMessage['images']): ImageContent[] {
  if (!images) return [];
  const blocks: ImageContent[] = [];
  for (const image of images) {
    if (typeof image.data === 'string' && image.data.length > 0) {
      blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    }
  }
  return blocks;
}

function toPiContext(
  messages: ChatMessage[],
  tools: ToolSchema[] | undefined,
  providerId: string,
  modelId: string,
  api: Api,
): Context {
  const systemMessages = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .filter(Boolean);

  const converted: Context['messages'] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      const imageBlocks = toPiImageBlocks(message.images);
      if (imageBlocks.length > 0) {
        converted.push({
          role: 'user',
          content: [
            ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
            ...imageBlocks,
          ],
          timestamp: Date.now(),
        });
      } else {
        converted.push({ role: 'user', content: message.content, timestamp: Date.now() });
      }
      continue;
    }

    if (message.role === 'assistant') {
      converted.push(toPiAssistant(message, providerId, modelId, api));
      continue;
    }

    converted.push({
      role: 'toolResult',
      toolCallId: message.tool_call_id ?? 'unknown-tool-call',
      toolName: findToolName(messages, message.tool_call_id ?? ''),
      content: [{ type: 'text', text: message.content }, ...toPiImageBlocks(message.images)],
      isError: false,
      timestamp: Date.now(),
    });
  }

  return {
    systemPrompt: systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined,
    messages: converted,
    tools: tools?.map(toPiTool),
  };
}

function toLegacyMessage(
  message: AssistantMessage,
  toolNamesById?: ReadonlyMap<string, string>,
  toolArgumentsById?: ReadonlyMap<string, string>,
): ChatMessage {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
  const thinking = message.content
    .filter((block) => block.type === 'thinking')
    .map((block) => (block.type === 'thinking' ? block.thinking : ''))
    .join('');
  const toolCalls = message.content
    .filter((block) => block.type === 'toolCall')
    .map((block) =>
      block.type === 'toolCall'
        ? {
            id: block.id,
            type: 'function' as const,
            function: {
              name: toolNamesById?.get(block.id) ?? block.name,
              // pi-ai 的流式 reducer 会把尚未闭合的 JSON 暂时表示为 {}。
              // 如果适配层保存了原始片段，必须把它交给 Runtime 的统一解析器，
              // 否则 malformed tool call 会被误当成合法空对象而执行工具。
              arguments: toolArgumentsById?.get(block.id) ?? JSON.stringify(block.arguments),
            },
          }
        : undefined,
    )
    .filter((call): call is ToolCall => call !== undefined);

  return {
    role: 'assistant',
    content: text,
    reasoning_content: thinking || undefined,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

class InlineThinkEmitter {
  private pending = '';
  private inside = false;

  constructor(private readonly emit: (type: ChatStreamDelta['type'], delta: string) => void) {}

  push(input: string, final = false): void {
    this.pending += input;
    while (this.pending) {
      const tag = this.inside ? '</think>' : '<think>';
      const index = this.pending.indexOf(tag);
      if (index >= 0) {
        const before = this.pending.slice(0, index);
        if (before) this.emit(this.inside ? 'reasoning_delta' : 'assistant_delta', before);
        this.pending = this.pending.slice(index + tag.length);
        this.inside = !this.inside;
        continue;
      }
      const max = Math.min(this.pending.length, tag.length - 1);
      let retained = 0;
      if (!final) {
        for (let size = max; size > 0; size--) {
          if (tag.startsWith(this.pending.slice(-size))) {
            retained = size;
            break;
          }
        }
      }
      const ready = this.pending.slice(0, this.pending.length - retained);
      if (ready) this.emit(this.inside ? 'reasoning_delta' : 'assistant_delta', ready);
      this.pending = this.pending.slice(this.pending.length - retained);
      // Retained tag prefixes (for example "<thi") intentionally stay in the
      // buffer until the next upstream delta; do not spin on the same prefix.
      if (retained > 0 || !this.pending) break;
    }
  }
}

/**
 * Some existing providers/tests return one JSON Chat Completions response even
 * when `stream: true` is requested. pi-ai intentionally consumes the streaming
 * wire protocol, so normalize that non-stream response at the fetch boundary.
 * Real SSE responses pass through untouched.
 */
interface FetchDiagnostics {
  attempts: number;
  error?: Error;
  status?: number;
  body?: string;
  // 429/503 时的服务端建议等待秒数（Retry-After）；限速退避依据，缺失则用指数退避。
  retryAfterMs?: number;
  toolNamesById?: Map<string, string>;
  toolArgumentsById?: Map<string, string>;
  // v2.3 分层超时：连接超时需要在 fetch 边界中止"本次 HTTP 尝试"的控制权，
  // 由 chat() 每次 attempt 注入；undefined = 不启用连接超时（防御性兼容）。
  timeoutController?: AbortController;
  connectTimeoutMs?: number;
}

function normalizeSseResponse(response: Response, diagnostics: FetchDiagnostics): Response {
  if (!response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const toolNames = new Map<number, string>();
  const toolIds = new Map<number, string>();
  const toolArguments = new Map<number, string>();

  const transformLine = (line: string): string => {
    if (!line.startsWith('data:')) return `${line}\n`;
    const payload = line.slice(5).trimStart();
    if (!payload || payload === '[DONE]') return `${line}\n\n`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return `${line}\n\n`;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return `${line}\n\n`;

    const choice = parsed.choices[0];
    if (!isRecord(choice) || !isRecord(choice.delta)) {
      return `data: ${JSON.stringify(parsed)}\n\n`;
    }

    if (!Array.isArray(choice.delta.tool_calls)) {
      const pendingNames = [...toolNames.entries()];
      if (pendingNames.length === 0) return `data: ${JSON.stringify(parsed)}\n\n`;
      const finishDelta = {
        tool_calls: pendingNames.map(([index, name]) => ({
          index,
          ...(toolIds.get(index) ? { id: toolIds.get(index) } : {}),
          type: 'function',
          function: { name },
        })),
      };
      diagnostics.toolNamesById ??= new Map();
      for (const [index, name] of pendingNames) {
        const id = toolIds.get(index);
        if (id) diagnostics.toolNamesById.set(id, name);
      }
      toolNames.clear();
      return `data: ${JSON.stringify({ ...parsed, choices: [{ ...choice, delta: finishDelta }] })}\n\n`;
    }

    const delta = { ...choice.delta, tool_calls: [] as Record<string, unknown>[] };
    for (const rawCall of choice.delta.tool_calls) {
      if (!isRecord(rawCall)) continue;
      const call = { ...rawCall };
      const index = typeof call.index === 'number' ? call.index : 0;
      // 兼容端点会把同一个调用拆成多片，后续分片带 `id: ""`（实测 MiniMax-M3：第 1 片
      // 带 id+name、arguments 为空，第 2/3 片 id 与 name 都是空串，真正的参数只在最后
      // 一片）。空串不是身份：既不能覆盖已知 id，也不能让分片身份被清空 —— 否则累计
      // 参数会丢掉，Runtime 只拿到空串 → INVALID_ARGUMENT_JSON。删掉空 id 后，我们
      // 转发出去的流与 OpenAI 官方协议一致（后续分片省略 id，下游按 index 合并）。
      if (typeof call.id === 'string' && call.id !== '') toolIds.set(index, call.id);
      else if (call.id === '') delete call.id;
      const functionPart = isRecord(call.function) ? { ...call.function } : undefined;
      if (functionPart && functionPart.name === '') delete functionPart.name;
      if (functionPart && typeof functionPart.name === 'string') {
        const previousName = toolNames.get(index) ?? '';
        // A few OpenAI-compatible endpoints split the function name across
        // deltas ("cal" + "culator"), while others repeat the full name on
        // each delta. Keep a canonical name for the legacy result, but leave
        // the wire delta untouched so pi-ai's reducer can still consume it.
        const fullName =
          previousName && !functionPart.name.startsWith(previousName)
            ? previousName + functionPart.name
            : functionPart.name;
        toolNames.set(index, fullName);
      }
      const hasArguments = functionPart && typeof functionPart.arguments === 'string';
      if (hasArguments) {
        const fullArguments = (toolArguments.get(index) ?? '') + functionPart.arguments;
        toolArguments.set(index, fullArguments);
        const fullName = toolNames.get(index);
        const id = toolIds.get(index);
        if (id) {
          diagnostics.toolArgumentsById ??= new Map();
          diagnostics.toolArgumentsById.set(id, fullArguments);
          if (fullName) {
            diagnostics.toolNamesById ??= new Map();
            diagnostics.toolNamesById.set(id, fullName);
          }
        }
      }
      if (functionPart) call.function = functionPart;
      delta.tool_calls.push(call);
    }

    const next = { ...parsed, choices: [{ ...choice, delta }] };
    return `data: ${JSON.stringify(next)}\n\n`;
  };

  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) controller.enqueue(encoder.encode(transformLine(line)));
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(transformLine(buffer)));
      },
    }),
  );
  return new Response(stream, { status: response.status, headers: response.headers });
}

async function piFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  diagnostics: FetchDiagnostics,
  normalizeOpenAiResponse: boolean,
  onRequestSent?: () => void,
): Promise<Response> {
  diagnostics.attempts++;
  const requestHeaders = new Headers(init?.headers);
  const headers: Record<string, string> = {};
  for (const [key, value] of requestHeaders.entries()) {
    headers[key.toLowerCase() === 'authorization' ? 'Authorization' : key] = value;
  }
  const requestInit = { ...init, headers };
  // HTTP 请求真正发出的瞬间打点（在发起 fetch 之前调用回调）：
  // llm_call_started → 此处 = Host 侧整理耗时；此处 → 首个 delta = Provider 首包/网络。
  onRequestSent?.();
  // v2.3 连接超时：响应头返回（fetch resolve）前无任何数据 → 中止本次 HTTP 尝试。
  const connectMs = diagnostics.connectTimeoutMs;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  if (connectMs !== undefined && diagnostics.timeoutController) {
    connectTimer = setTimeout(() => {
      diagnostics.timeoutController?.abort(
        new TimeoutAbortError(
          'llm-connect',
          `LLM request timed out: no response received within ${connectMs}ms`,
        ),
      );
    }, connectMs);
    connectTimer.unref?.();
  }
  let response: Response;
  try {
    response = await globalThis.fetch(input, requestInit);
  } catch (error) {
    diagnostics.error = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
  }
  if (!response.ok) {
    diagnostics.status = response.status;
    diagnostics.body = (await response.clone().text()).slice(0, 2_000);
    // 限速响应常带 Retry-After（秒或 HTTP 日期）；解析失败时留空走指数退避。
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter && (response.status === 429 || response.status === 503)) {
      const seconds = Number(retryAfter);
      const parsed = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retryAfter) - Date.now();
      // 允许 0：服务端显式要求立即重试（现有测试依赖此快路径）。
      if (Number.isFinite(parsed) && parsed >= 0) diagnostics.retryAfterMs = Math.min(parsed, 120_000);
    }
    return response;
  }

  if (
    normalizeOpenAiResponse &&
    response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')
  ) {
    return normalizeSseResponse(response, diagnostics);
  }

  // Anthropic/Google/Mistral 等 pi-ai 原生适配器各自解析自己的 wire response，
  // 不能套用 OpenAI Chat Completions 的 JSON→SSE 兼容转换。
  if (!normalizeOpenAiResponse) return response;

  const raw = await response.clone().text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const error = new Error('LLM API malformed response: invalid JSON');
    diagnostics.error = error;
    throw error;
  }

  // 保持既有错误语义，同时把兼容服务的单次 JSON 响应转换成 SSE。
  let message: ChatMessage;
  try {
    message = parseAssistantMessage(parsed);
  } catch (error) {
    diagnostics.error = error instanceof Error ? error : new Error(String(error));
    throw error;
  }
  for (const call of message.tool_calls ?? []) {
    diagnostics.toolArgumentsById ??= new Map();
    diagnostics.toolArgumentsById.set(call.id, call.function.arguments);
  }
  const original = isRecord(parsed) ? parsed : {};
  const chunks: string[] = [];
  const id = typeof original.id === 'string' ? original.id : crypto.randomUUID();
  const model = typeof original.model === 'string' ? original.model : undefined;

  const push = (delta: Record<string, unknown>): void => {
    chunks.push(
      `data: ${JSON.stringify({
        id,
        ...(model ? { model } : {}),
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    );
  };

  if (message.reasoning_content) push({ reasoning_content: message.reasoning_content });
  if (message.content) push({ content: message.content });
  for (const call of message.tool_calls ?? []) {
    push({
      tool_calls: [
        {
          index: 0,
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: call.function.arguments },
        },
      ],
    });
  }
  const finishReason = message.tool_calls?.length ? 'tool_calls' : 'stop';
  chunks.push(
    `data: ${JSON.stringify({
      id,
      ...(model ? { model } : {}),
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      ...(isRecord(original.usage) ? { usage: original.usage } : {}),
    })}\n\n`,
  );
  chunks.push('data: [DONE]\n\n');

  return new Response(chunks.join(''), {
    status: response.status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function resolveEndpointConfig(modelConfig?: ModelConfig): {
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
} {
  if (modelConfig) {
    if (!modelConfig.baseUrl || !modelConfig.apiKey || !modelConfig.model) {
      throw new Error(
        'modelConfig is incomplete: baseUrl, apiKey and model are all required ' +
          '(no per-field fallback to environment config)',
      );
    }
    return {
      // Host 已经解析并固定本轮 Provider。baseUrl 是用户配置的权威值，传输层
      // 不得再根据模型名静默切换计费或订阅通道。
      baseUrl: modelConfig.baseUrl,
      apiKey: modelConfig.apiKey,
      model: modelConfig.model,
      providerId: modelConfig.providerId || 'payaso-configured',
      ...(modelConfig.piProviderId ? { piProviderId: modelConfig.piProviderId } : {}),
      ...(modelConfig.sessionId ? { sessionId: modelConfig.sessionId } : {}),
      contextWindow: modelConfig.contextWindow,
      maxOutputTokens: modelConfig.maxOutputTokens,
      vision: modelConfig.vision === true,
      ...(modelConfig.thinkingLevel ? { thinkingLevel: modelConfig.thinkingLevel } : {}),
    };
  }
  return {
    // CLI/env fallback 同样尊重显式地址；路由纠正应由配置入口提示用户，而不是
    // 在发请求时悄悄改成另一个端点。
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    model: MODEL,
    providerId: 'payaso-env',
    vision: false,
  };
}

function createConfiguredModel(config: ReturnType<typeof resolveEndpointConfig>): {
  models: ReturnType<typeof createModels>;
  model: Model<Api>;
} {
  const auth = {
    apiKey: {
      name: `${config.providerId} API key`,
      resolve: async () => ({
        // Explicit ModelConfig values are validated before this point. The
        // env fallback path keeps its historical behavior for an empty key.
        auth: { apiKey: config.apiKey || 'unused' },
        source: 'PayasoAgent Run snapshot',
      }),
    },
  };

  if (config.piProviderId) {
    const resolved = getPiAiProviderModel(config.piProviderId, config.model);
    if (!resolved) {
      throw new Error(
        `pi-ai provider/model is not available: ${config.piProviderId}/${config.model}`,
      );
    }
    const sourceModel = resolved.model;
    const modelContext = resolveModelContextConfig({
      model: config.model,
      contextWindowTokens: config.contextWindow ?? sourceModel.contextWindow,
      maxOutputTokens: config.maxOutputTokens ?? sourceModel.maxTokens,
    });
    // 内置 Provider 的 input 能力来自注册表；设置位显式开启视觉时补登记 image，
    // 让 openai-completions 适配层把图片块转成 image_url（它按 model.input 判定）。
    const input: Model<Api>['input'] =
      config.vision && !sourceModel.input.includes('image')
        ? ([...sourceModel.input, 'image'] as Model<Api>['input'])
        : sourceModel.input;
    const model: Model<Api> = {
      ...sourceModel,
      id: config.model,
      provider: config.providerId,
      baseUrl: config.baseUrl,
      input,
      contextWindow: modelContext.contextWindowTokens,
      maxTokens: modelContext.maxOutputTokens,
    };
    const provider = createProvider({
      id: config.providerId,
      name: config.providerId,
      baseUrl: config.baseUrl,
      auth,
      models: [model],
      api: asProviderStreams(resolved.provider) as ProviderStreams,
    });
    const models = createModels();
    models.setProvider(provider);
    return { models, model };
  }

  const modelContext = resolveModelContextConfig({
    model: config.model,
    contextWindowTokens: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
  });
  const model: Model<Api> = {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: config.providerId,
    baseUrl: config.baseUrl,
    // 思考能力按"是否配置了档次"打开：配了档次 → true，未配置/off → false。
    // reasoning 是 pi-ai 的两道闸门之一（false 时任何档次都会被 clamp 成 off），
    // 同时它也决定 pi-ai 是否主动发"关闭思考"参数：对 deepseek/zai/together/
    // openrouter 这类按 URL 自动探测的端点，reasoning: true + 未配档次会发出
    // thinking:{type:"disabled"} / reasoning:{enabled:false} 等显式关闭指令，
    // 反而把本来默认开思考的模型关掉。故只在用户显式配置档次时才打开——
    // 未配置的请求与引入该功能前逐字节一致。
    reasoning: activeThinkingLevel(config.thinkingLevel) !== undefined,
    // 自定义 OpenAI 兼容端点：视觉能力由设置页按模型显式声明（无法从协议探测）。
    input: config.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelContext.contextWindowTokens,
    maxTokens: modelContext.maxOutputTokens,
    compat: {
      // PayasoAgent 的现有 Provider 契约是 Chat Completions + max_tokens。
      maxTokensField: 'max_tokens',
      supportsStore: false,
      supportsDeveloperRole: false,
      // 不再硬编码 supportsReasoningEffort: false：pi-ai 的 getCompat 会按
      // baseUrl 自动探测该能力（model.compat 里缺的字段用 detected 兜底）。
      // deepseek.com → thinkingFormat 'deepseek' + reasoning_effort 支持；
      // 通用 OpenAI 兼容 → reasoning_effort；zai/moonshot/grok 等排除名单
      // 自动探测为 false，但各自原生 thinkingFormat 分支只依赖 model.reasoning。
      // Some of the existing compatible endpoints terminate with [DONE]
      // without a final finish_reason; pi-ai can infer stop/toolUse safely.
      supportsFinishReason: false,
    },
  };

  const provider = createProvider({
    id: config.providerId,
    name: config.providerId,
    baseUrl: config.baseUrl,
    auth,
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

function requestHeadersFor(
  config: ReturnType<typeof resolveEndpointConfig>,
): Record<string, string> | undefined {
  // OpenCode Go's Console Go gateway uses this header for request routing. The
  // pi-ai provider catalog intentionally does not hard-code it because the
  // value belongs to the host application's conversation/session boundary.
  if (config.piProviderId === 'opencode-go' && config.sessionId) {
    return { 'x-opencode-session': config.sessionId };
  }
  return undefined;
}

function isAbortOrTimeoutMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('abort') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out')
  );
}

function shouldRetry(result: AssistantMessage, diagnostics: FetchDiagnostics): boolean {
  if (result.stopReason !== 'error') return false;
  if (result.errorMessage === 'Request timed out.') return false;
  if (diagnostics.status !== undefined) {
    return diagnostics.status === 408 || diagnostics.status === 429 || diagnostics.status >= 500;
  }
  return diagnostics.error !== undefined && !isAbortOrTimeoutMessage(diagnostics.error.message);
}

function retryDelay(attempt: number, diagnostics: FetchDiagnostics): Promise<void> {
  // 429 限速：毫秒级退避无意义，采用秒级指数退避（5s→10s→20s…上限 60s），
  // 服务端给了 Retry-After 时以其为准。其余错误保持原有快速退避语义；
  // 503 仅在显式携带 Retry-After 时按建议值等待，否则维持毫秒级。
  if (diagnostics.status === 429) {
    return new Promise((resolve) =>
      setTimeout(resolve, Math.min(diagnostics.retryAfterMs ?? 5_000 * 2 ** attempt, 60_000)),
    );
  }
  if (diagnostics.status === 503 && diagnostics.retryAfterMs !== undefined) {
    return new Promise((resolve) => setTimeout(resolve, diagnostics.retryAfterMs));
  }
  return new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
}

function formatTransportError(
  result: AssistantMessage,
  diagnostics: FetchDiagnostics,
  totalAttempts: number,
): Error {
  if (diagnostics.error) {
    const message = diagnostics.error.message;
    if (isAbortOrTimeoutMessage(message)) {
      return new Error('LLM request failed: transport timeout');
    }
    if (message.startsWith('LLM API malformed response:')) return diagnostics.error;
    return new Error(`LLM API request failed after ${totalAttempts} attempts: ${message}`);
  }
  if (diagnostics.status !== undefined) {
    return new Error(`LLM API error: ${diagnostics.status} ${diagnostics.body ?? ''}`.trim());
  }
  if (result.errorMessage === 'Request timed out.') {
    return new Error('LLM request timed out (provider reported)');
  }
  return new Error(result.errorMessage ?? 'LLM request failed');
}

export async function chat(
  messages: ChatMessage[],
  tools?: ToolSchema[],
  onDelta?: (delta: ChatStreamDelta) => void,
  modelConfig?: ModelConfig,
  signal?: AbortSignal,
  onRequestSent?: (attempt: number) => void,
): Promise<ChatMessage & { usage?: TokenUsage }> {
  const config = resolveEndpointConfig(modelConfig);
  const { models, model } = createConfiguredModel(config);
  const context = toPiContext(messages, tools, config.providerId, config.model, model.api);
  const messageId = crypto.randomUUID();
  const policy = llmTimeoutPolicy();
  let totalAttempts = 0;

  // pi-ai's stream owns one request lifecycle. Keep its internal retry count at
  // zero and retry the whole lifecycle here so timeout/abort errors are never
  // retried, while transient HTTP/network errors still get two retries.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // v2.3 分层超时：每次尝试一个派生 AbortController——
    // - 用户取消 → 以标准 AbortError 传播（与引入前语义逐字节一致）
    // - 连接/空闲超时 → 以 TimeoutAbortError 标记来源，绝不当作用户取消
    const timeoutController = new AbortController();
    const onUserAbort = (): void => {
      timeoutController.abort(new DOMException('Aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) onUserAbort();
      else signal.addEventListener('abort', onUserAbort, { once: true });
    }
    const diagnostics: FetchDiagnostics = {
      attempts: 0,
      timeoutController,
      connectTimeoutMs: policy.connectMs,
    };
    // 流空闲看门狗：每个事件续期；prefill 首 token 漫长等待与中途停滞都会触发。
    const idleWatchdog = createIdleWatchdog(policy.idleMs, () => {
      timeoutController.abort(
        new TimeoutAbortError(
          'llm-idle',
          `LLM request timed out: no stream data for ${policy.idleMs}ms ` +
            '(continuous output renews the idle budget; only a stall trips it)',
        ),
      );
    });
    // 统一把"本次尝试被中止"翻译成可区分语义的错误。
    const abortError = (): Error => {
      const reason = timeoutController.signal.reason;
      if (reason instanceof TimeoutAbortError) return new Error(reason.message);
      return new DOMException('Aborted', 'AbortError');
    };

    const inline = new InlineThinkEmitter((type, delta) => {
      if (delta) onDelta?.({ messageId, type, delta });
    });
    // 思考档次只在用户显式配置（且非 off）时才介入请求，两条路径：
    //  - 未配置/off → models.stream：与引入思考档次前逐字节一致。不主动发任何
    //    思考参数，也不会引入 streamSimple 的两个副作用（anthropic 系 provider
    //    的 thinking:{type:"disabled"} 字段、maxTokens 按剩余窗口钳制）。
    //  - 配置了档次 → models.streamSimple：pi-ai 的 provider 无关思考入口，
    //    reasoning 被 clampThinkingLevel 按模型能力收敛，并按 thinkingFormat/
    //    thinkingLevelMap 映射成厂商参数（deepseek thinking:{type} +
    //    reasoning_effort、通用 reasoning_effort、anthropic thinking+budget 等），
    //    同时封顶思考预算。两者事件流（thinking_delta/toolcall_delta）完全一致。
    const thinkingLevel = activeThinkingLevel(config.thinkingLevel);
    const streamOptions = {
      // 传派生信号而非用户信号：连接/空闲超时能真实中止在途 fetch；
      // 用户取消经由派生控制器仍以 AbortError 抵达（语义不变）。
      signal: timeoutController.signal,
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        piFetch(
          input,
          init,
          diagnostics,
          model.api === 'openai-completions',
          // 每次 HTTP 请求发出都通知（重试时 attempt 递增）。
          () => onRequestSent?.(attempt + 1),
        ),
      sessionId: config.sessionId,
      headers: requestHeadersFor(config),
      // v2.3 分层超时：不再传统一 timeoutMs。单请求总时限会掐断持续输出中的
      // 长生成；连接与空闲两个边界已由本层接管。
      maxRetries: 0,
      maxTokens: model.maxTokens,
    };
    const stream = thinkingLevel
      ? models.streamSimple(model, context, { ...streamOptions, reasoning: thinkingLevel })
      : models.stream(model, context, streamOptions);

    try {
      // v1.10：原生适配器（Anthropic/Google…）只暴露已解析的参数对象，畸形 JSON
      // 会被解成 {}；这里累积 toolcall_delta 的原始片段，交给 Runtime 统一解析器。
      const rawArguments = new ToolArgumentAccumulator();
      for await (const event of stream) {
        idleWatchdog.poke();
        if (event.type === 'text_delta') inline.push(event.delta);
        if (event.type === 'thinking_delta') {
          onDelta?.({ messageId, type: 'reasoning_delta', delta: event.delta });
        }
        if (event.type === 'toolcall_delta') rawArguments.push(event.contentIndex, event.delta);
        if (event.type === 'error' && event.reason === 'aborted') {
          throw abortError();
        }
      }
      inline.push('', true);

      const result = await stream.result();
      totalAttempts += diagnostics.attempts;
      if (result.stopReason === 'aborted' || timeoutController.signal.aborted) {
        throw abortError();
      }
      if (result.stopReason !== 'error') {
        // 恢复被适配器丢弃的原始参数：只在解码结果为空且原文非 "{}" 时接管。
        diagnostics.toolArgumentsById = mergeRawArguments(
          diagnostics.toolArgumentsById,
          rawArgumentsByToolCallId(result.content, rawArguments.snapshot()),
        );
        const message = toLegacyMessage(
          result,
          diagnostics.toolNamesById,
          diagnostics.toolArgumentsById,
        );
        // 运行时 usage 可能缺失/损坏（第三方兼容端点）。normalizeTokenUsage
        // 宁缺勿错：任一桶异常即整体拒绝，绝不因统计字段让整次调用失败。
        const usage = normalizeTokenUsage(result.usage);
        return Object.assign(message, usage === undefined ? {} : { usage });
      }
      if (attempt < MAX_RETRIES && shouldRetry(result, diagnostics)) {
        await retryDelay(attempt, diagnostics);
        continue;
      }
      throw formatTransportError(result, diagnostics, totalAttempts);
    } finally {
      // 无论成功、失败还是被中止：清理本尝试的空闲看门狗与用户取消监听。
      idleWatchdog.dispose();
      signal?.removeEventListener('abort', onUserAbort);
    }
  }

  throw new Error('LLM request failed');
}
