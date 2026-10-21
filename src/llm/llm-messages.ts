// 模块: LLM 消息转换层 —— PayasoAgent 旧 ChatMessage 契约 ⇄ pi-ai Context/AssistantMessage
// 职责边界：纯转换，无 IO、无重试、无超时。含两个方向的解析：
//   - 出站：ChatMessage[] + ToolSchema[] → pi-ai Context（toPiContext 及助手函数）
//   - 入站：pi-ai AssistantMessage → ChatMessage（toLegacyMessage）
//   - 兼容层解析：非流式 JSON 响应的 parseAssistantMessage / parseToolCalls
//   - InlineThinkEmitter：把内联 <think> 标签切成 reasoning_delta / assistant_delta
// 所有函数确定性可测；malformed 一律抛结构化错误（fail-closed）。

import type { Api, AssistantMessage, Context, ImageContent, TSchema } from '@earendil-works/pi-ai';
import type { ChatMessage, ChatStreamDelta, ToolCall, ToolSchema } from './llm-types.js';
import { matchesProviderContinuation } from './provider-continuation.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseToolCalls(value: unknown): ToolCall[] | undefined {
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

export function parseAssistantMessage(data: unknown): ChatMessage {
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
  continuationIdentity?: string,
): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  if (
    api === 'openai-completions' &&
    message.tool_calls?.length &&
    matchesProviderContinuation(message.providerContinuation, continuationIdentity)
  ) {
    content.push({
      type: 'thinking',
      thinking: message.providerContinuation.text,
      thinkingSignature: message.providerContinuation.field,
    });
  } else if (message.reasoning_content && !message.providerContinuation) {
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

export function toPiContext(
  messages: ChatMessage[],
  tools: ToolSchema[] | undefined,
  providerId: string,
  modelId: string,
  api: Api,
  continuationIdentity?: string,
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
      converted.push(toPiAssistant(message, providerId, modelId, api, continuationIdentity));
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

export function toLegacyMessage(
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

// 内联 <think> 标签的流式切割器：把混在正文流里的思考块切成
// reasoning_delta，其余按 assistant_delta 发出。保留可能跨 delta 的半截标签前缀
// （如 "<thi"），等下一个上游 delta 到达后再判定，绝不在同一前缀上空转。
export class InlineThinkEmitter {
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
