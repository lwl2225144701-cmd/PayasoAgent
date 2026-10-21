// 模块: LLM 传输层 —— fetch 封装（连接超时 / Retry-After / JSON→SSE 兼容）+ 重试与退避策略
// 职责边界：发起一次 HTTP 尝试并决定"是否值得重试、退避多久、最终错误长什么样"。
//   不组装模型、不消费事件流（编排在 llm.ts）；SSE 行整形在 llm-sse.ts。
// 关键不变量（v2.3 分层超时）：连接超时在 fetch resolve 前中止"本次尝试"；用户取消与
//   超时都经由派生 AbortController，但语义可区分（TimeoutAbortError vs AbortError）。

import type { AssistantMessage } from '@earendil-works/pi-ai';
import { positiveIntMs, TimeoutAbortError } from '../util/timeout.js';
import { isRecord, parseAssistantMessage } from './llm-messages.js';
import { type FetchDiagnostics, normalizeSseResponse } from './llm-sse.js';
import type { ChatMessage, LlmTimeoutPolicy, ResolvedEndpointConfig } from './llm-types.js';

const DEFAULT_LLM_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_LLM_IDLE_TIMEOUT_MS = 120_000;
const LLM_TIMEOUT_MIN_MS = 1_000;

// 缺省为正数、非法 env 值回退缺省（fail-closed，绝不因配置错误放开限制）。
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

export async function piFetch(
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
  // fetch 调用前打点；不代表响应头、网络字节或模型增量已经到达。
  onRequestSent?.();
  // 响应头返回（fetch resolve）前超时 → 中止本次 HTTP 尝试。
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
  diagnostics.responseReceived = true;
  diagnostics.onTransport?.({
    phase: 'response_headers',
    status: response.status,
    contentType: response.headers.get('content-type')?.slice(0, 120) ?? undefined,
  });
  // 在归一化/适配器之前观察真实 body，区分网络等待与解析等待；保持背压与取消传播。
  if (response.body && diagnostics.onTransport) {
    let observed = false;
    response = new Response(
      response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            if (!observed && chunk.byteLength > 0) {
              observed = true;
              diagnostics.onTransport?.({
                phase: 'first_body_chunk',
                chunkBytes: chunk.byteLength,
              });
            }
            controller.enqueue(chunk);
          },
        }),
      ),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
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
      if (Number.isFinite(parsed) && parsed >= 0)
        diagnostics.retryAfterMs = Math.min(parsed, 120_000);
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
  // index 必须是同批内的位置（0,1,2…）：SSE 消费端按 index 归集工具调用，
  // 全部写成 0 会把同批多个调用合并成一个（WIRE-01：JSON 兼容响应丢工具）。
  (message.tool_calls ?? []).forEach((call, position) => {
    push({
      tool_calls: [
        {
          index: position,
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: call.function.arguments },
        },
      ],
    });
  });
  // JSON 兼容响应同样保留服务端的 length；不能把输出截断伪装成正常 stop。
  const firstChoice = Array.isArray(original.choices) ? original.choices[0] : undefined;
  const wireFinishReason = isRecord(firstChoice) ? firstChoice.finish_reason : undefined;
  const finishReason =
    typeof wireFinishReason === 'string'
      ? wireFinishReason
      : message.tool_calls?.length
        ? 'tool_calls'
        : 'stop';
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

// OpenCode Go's Console Go gateway uses this header for request routing. The
// pi-ai provider catalog intentionally does not hard-code it because the
// value belongs to the host application's conversation/session boundary.
export function requestHeadersFor(
  config: ResolvedEndpointConfig,
): Record<string, string> | undefined {
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

// 只有"瞬时错误"才重试：HTTP 408/429/5xx，或未产生 HTTP 状态的网络错误
// 此函数不靠错误字符串重试超时；本地连接超时由chat依据结构化来源单独处理。
export function shouldRetry(result: AssistantMessage, diagnostics: FetchDiagnostics): boolean {
  if (result.stopReason !== 'error') return false;
  if (result.errorMessage === 'Request timed out.') return false;
  if (diagnostics.status !== undefined) {
    return diagnostics.status === 408 || diagnostics.status === 429 || diagnostics.status >= 500;
  }
  if (diagnostics.error !== undefined) {
    return !isAbortOrTimeoutMessage(diagnostics.error.message);
  }
  // 流式 provider 掐流（如 "terminated"）：无 HTTP 状态、无 transport error，但按消息归类
  // 仍属瞬时错误。是否安全重放由调用方用 emittedContent（未产出正文/工具调用）兜底。
  return isTransientStreamError(result.errorMessage ?? '');
}

// 瞬时传输/服务端错误分类（按错误消息，不靠结构化信号）：provider 掐流（terminated）、
// 网络抖动（fetch failed / connection / socket / reset）等。
// 与 shouldRetry 互补：shouldRetry 面向 stream.result() 返回的 error 结果；这里面向
// for-await 直接抛出的错误。刻意排除 abort/timeout——它们由派生 AbortController 的
// 结构化语义（TimeoutAbortError / AbortError）单独处理，绝不该靠字符串猜测重试一条
// 正在超时或已取消的请求。
export function isTransientStreamError(message: string): boolean {
  if (isAbortOrTimeoutMessage(message)) return false;
  return /terminated|fetch failed|network|connection|overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|socket|reset|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|premature/i.test(
    message,
  );
}

export function retryDelayMs(attempt: number, diagnostics: FetchDiagnostics): number {
  // 429 限速：毫秒级退避无意义，采用秒级指数退避（5s→10s→20s…上限 60s），
  // 服务端给了 Retry-After 时以其为准。其余错误保持原有快速退避语义；
  // 503 仅在显式携带 Retry-After 时按建议值等待，否则维持毫秒级。
  if (diagnostics.status === 429) {
    return Math.min(diagnostics.retryAfterMs ?? 5_000 * 2 ** attempt, 60_000);
  }
  if (diagnostics.status === 503 && diagnostics.retryAfterMs !== undefined) {
    return diagnostics.retryAfterMs;
  }
  return 25 * 2 ** attempt;
}

export function retryDelay(
  attempt: number,
  diagnostics: FetchDiagnostics,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      retryDelayMs(attempt, diagnostics),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function formatTransportError(
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
