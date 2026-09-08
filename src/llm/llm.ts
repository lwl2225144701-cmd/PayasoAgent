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
  type ProviderStreams,
  type TSchema,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { resolveModelContextConfig } from '../harness/model-context.js';
import { asProviderStreams, getPiAiProviderModel } from '../host/pi-ai-providers.js';

const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_RETRIES = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 240_000;

function requestTimeoutMs(): number {
  const raw = process.env.LLM_REQUEST_TIMEOUT_MS;
  if (raw && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
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

export interface ChatMessage {
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
  type: 'assistant_delta' | 'reasoning_delta';
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
  toolNamesById?: Map<string, string>;
  toolArgumentsById?: Map<string, string>;
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
      if (typeof call.id === 'string') toolIds.set(index, call.id);
      const functionPart = isRecord(call.function) ? { ...call.function } : undefined;
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
): Promise<Response> {
  diagnostics.attempts++;
  const requestHeaders = new Headers(init?.headers);
  const headers: Record<string, string> = {};
  for (const [key, value] of requestHeaders.entries()) {
    headers[key.toLowerCase() === 'authorization' ? 'Authorization' : key] = value;
  }
  const requestInit = { ...init, headers };
  let response: Response;
  try {
    response = await globalThis.fetch(input, requestInit);
  } catch (error) {
    diagnostics.error = error instanceof Error ? error : new Error(String(error));
    throw error;
  }
  if (!response.ok) {
    diagnostics.status = response.status;
    diagnostics.body = (await response.clone().text()).slice(0, 2_000);
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
} {
  if (modelConfig) {
    if (!modelConfig.baseUrl || !modelConfig.apiKey || !modelConfig.model) {
      throw new Error(
        'modelConfig is incomplete: baseUrl, apiKey and model are all required ' +
          '(no per-field fallback to environment config)',
      );
    }
    return {
      // 自定义 Provider 的 baseUrl 是用户配置的权威值；只有内置 pi-ai Provider
      // 继续沿用其已有的厂商路由兼容逻辑。
      baseUrl: modelConfig.piProviderId
        ? resolveKnownProviderBaseUrl(modelConfig.baseUrl, modelConfig.model)
        : modelConfig.baseUrl,
      apiKey: modelConfig.apiKey,
      model: modelConfig.model,
      providerId: modelConfig.providerId || 'payaso-configured',
      ...(modelConfig.piProviderId ? { piProviderId: modelConfig.piProviderId } : {}),
      ...(modelConfig.sessionId ? { sessionId: modelConfig.sessionId } : {}),
      contextWindow: modelConfig.contextWindow,
      maxOutputTokens: modelConfig.maxOutputTokens,
      vision: modelConfig.vision === true,
    };
  }
  return {
    baseUrl: resolveKnownProviderBaseUrl(BASE_URL, MODEL),
    apiKey: API_KEY,
    model: MODEL,
    providerId: 'payaso-env',
    vision: false,
  };
}

function resolveKnownProviderBaseUrl(baseUrl: string, model: string): string {
  try {
    const url = new URL(baseUrl);
    // StepFun 的 step_plan 通道只接受 step-router-v1；标准模型应走 /v1。
    if (
      url.hostname === 'api.stepfun.com' &&
      url.pathname.replace(/\/$/, '') === '/step_plan/v1' &&
      model !== 'step-router-v1'
    ) {
      url.pathname = '/v1';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    // 保持原值，让 pi-ai 返回可诊断的 URL 错误。
  }
  return baseUrl;
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
    reasoning: false,
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
      supportsReasoningEffort: false,
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

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
}

function formatTransportError(
  result: AssistantMessage,
  diagnostics: FetchDiagnostics,
  timeoutMs: number,
  totalAttempts: number,
): Error {
  if (diagnostics.error) {
    const message = diagnostics.error.message;
    if (isAbortOrTimeoutMessage(message)) {
      return new Error(`LLM request timed out after ${timeoutMs}ms`);
    }
    if (message.startsWith('LLM API malformed response:')) return diagnostics.error;
    return new Error(`LLM API request failed after ${totalAttempts} attempts: ${message}`);
  }
  if (diagnostics.status !== undefined) {
    return new Error(`LLM API error: ${diagnostics.status} ${diagnostics.body ?? ''}`.trim());
  }
  if (result.errorMessage === 'Request timed out.') {
    return new Error(`LLM request timed out after ${timeoutMs}ms`);
  }
  return new Error(result.errorMessage ?? 'LLM request failed');
}

export async function chat(
  messages: ChatMessage[],
  tools?: ToolSchema[],
  onDelta?: (delta: ChatStreamDelta) => void,
  modelConfig?: ModelConfig,
  signal?: AbortSignal,
): Promise<ChatMessage & { usage?: { totalTokens: number } }> {
  const config = resolveEndpointConfig(modelConfig);
  const { models, model } = createConfiguredModel(config);
  const context = toPiContext(messages, tools, config.providerId, config.model, model.api);
  const messageId = crypto.randomUUID();
  const timeoutMs = requestTimeoutMs();
  let totalAttempts = 0;

  // pi-ai's stream owns one request lifecycle. Keep its internal retry count at
  // zero and retry the whole lifecycle here so timeout/abort errors are never
  // retried, while transient HTTP/network errors still get two retries.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const diagnostics: FetchDiagnostics = { attempts: 0 };
    const inline = new InlineThinkEmitter((type, delta) => {
      if (delta) onDelta?.({ messageId, type, delta });
    });
    const stream = models.stream(model, context, {
      signal,
      fetch: (input, init) => piFetch(input, init, diagnostics, model.api === 'openai-completions'),
      sessionId: config.sessionId,
      headers: requestHeadersFor(config),
      timeoutMs,
      maxRetries: 0,
      maxTokens: model.maxTokens,
    });

    for await (const event of stream) {
      if (event.type === 'text_delta') inline.push(event.delta);
      if (event.type === 'thinking_delta') {
        onDelta?.({ messageId, type: 'reasoning_delta', delta: event.delta });
      }
      if (event.type === 'error' && event.reason === 'aborted') {
        throw new DOMException('Aborted', 'AbortError');
      }
    }
    inline.push('', true);

    const result = await stream.result();
    totalAttempts += diagnostics.attempts;
    if (result.stopReason === 'aborted' || signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (result.stopReason !== 'error') {
      const message = toLegacyMessage(
        result,
        diagnostics.toolNamesById,
        diagnostics.toolArgumentsById,
      );
      // 类型上 usage 必填，但第三方 OpenAI 兼容端点运行时可能省略 —— 缺失时
      // 走 NaN → 下方守卫直接不携带 usage，绝不因统计字段让整次调用失败。
      const totalTokens = result.usage?.totalTokens ?? Number.NaN;
      return Object.assign(
        message,
        Number.isFinite(totalTokens) && totalTokens > 0 ? { usage: { totalTokens } } : {},
      );
    }
    if (attempt < MAX_RETRIES && shouldRetry(result, diagnostics)) {
      await retryDelay(attempt);
      continue;
    }
    throw formatTransportError(result, diagnostics, timeoutMs, totalAttempts);
  }

  throw new Error('LLM request failed');
}
