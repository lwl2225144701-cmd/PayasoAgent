// 模块: LLM 出站 SSE 归一化 —— 把 OpenAI Chat Completions 的流式响应整成 pi-ai 可消费的 SSE
// 职责边界：只做"线路上的字节整形"，不发起请求、不重试、不超时（那些在 llm-transport）。
//   修正 tool_call 分片协议：空串 id/name 不是身份；跨分片的 name/arguments 累积后
//   回填给 diagnostics，供 toLegacyMessage 恢复原始参数。真实的 SSE 行原样透传，
//   只有 data: 行被解析-重组。单发 JSON → SSE 的转换留在 llm-transport 的 piFetch
//   （它需要保留原响应的 id/model/usage 字段）。

import { isRecord } from './llm-messages.js';
import type { LlmTransportEvent } from './llm-types.js';

export interface FetchDiagnostics {
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
  responseReceived?: boolean;
  onTransport?: (event: Omit<LlmTransportEvent, 'attempt' | 'elapsedMs'>) => void;
}

/**
 * Some existing providers/tests return one JSON Chat Completions response even
 * when `stream: true` is requested. pi-ai intentionally consumes the streaming
 * wire protocol, so normalize that non-stream response at the fetch boundary.
 * Real SSE responses pass through untouched.
 */
export function normalizeSseResponse(response: Response, diagnostics: FetchDiagnostics): Response {
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
