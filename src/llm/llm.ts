// 模块 1: LLM 封装 — OpenAI 兼容 chat/completions（纯 fetch，无 SDK 依赖）

import { resolveModelContextConfig } from "../runtime/model-context.js";

const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 100;
const MAX_ERROR_BODY_CHARS = 2_000;

// Total per-attempt request budget. Reading env per call keeps it configurable
// at runtime (tests set a tiny value) and defaults to a safe generous ceiling.
// A timeout ANYWHERE in the attempt — waiting for headers OR reading the body —
// is a terminal failure for that run. We never auto-retry a long generation:
// that would multiply latency (3 × timeout) and bill the same completion twice.
// Ordinary connection errors / 408 / 429 / 5xx still retry as before.
const DEFAULT_REQUEST_TIMEOUT_MS = 240_000;

function requestTimeoutMs(): number {
  const raw = process.env.LLM_REQUEST_TIMEOUT_MS;
  if (raw && raw.trim() !== "") {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface ChatStreamDelta {
  messageId: string;
  type: "assistant_delta" | "reasoning_delta";
  delta: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolCalls(value: unknown): ToolCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("LLM API malformed response: tool_calls must be an array");
  return value.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || item.type !== "function" || !isRecord(item.function)) {
      throw new Error("LLM API malformed response: invalid tool_call");
    }
    const fn = item.function;
    if (typeof fn.name !== "string" || typeof fn.arguments !== "string") {
      throw new Error("LLM API malformed response: invalid tool_call function");
    }
    return { id: item.id, type: "function", function: { name: fn.name, arguments: fn.arguments } };
  });
}

function parseAssistantMessage(data: unknown): ChatMessage {
  if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error("LLM API malformed response: missing choices");
  }
  const choice = data.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new Error("LLM API malformed response: missing assistant message");
  }
  const msg = choice.message;
  if (msg.content !== undefined && msg.content !== null && typeof msg.content !== "string") {
    throw new Error("LLM API malformed response: content must be a string or null");
  }
  return {
    role: "assistant",
    content: typeof msg.content === "string" ? msg.content : "",
    tool_calls: parseToolCalls(msg.tool_calls),
    reasoning_content: typeof msg.reasoning_content === "string" ? msg.reasoning_content : undefined,
  };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelay(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.min(Math.max(0, dateMs - Date.now()), 5000);
  }
  return RETRY_BASE_DELAY_MS * 2 ** attempt;
}

async function wait(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Result of a single attempt. status: HTTP status, 0 = no response (network
// error before headers), -1 = response body was not valid JSON.
interface RawResult {
  status: number;
  data?: unknown;
  errorBody: string;
  networkError?: string;
  timedOut: boolean;
  retryAfter: string | null;
}

// One attempt under a single abort timer that stays armed across BOTH the
// header phase and the body read, so a stalled body (or stalled error body)
// cannot hang forever. clearTimeout runs only after the body/error is read.
async function doRequest(
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  apiKey: string,
  onDelta?: (delta: ChatStreamDelta) => void,
): Promise<RawResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      return {
        status: 0,
        errorBody: "",
        networkError: (err as Error).message,
        timedOut: controller.signal.aborted,
        retryAfter: null,
      };
    }

    if (!res.ok) {
      let errorBody = "";
      try {
        errorBody = (await res.text()).slice(0, MAX_ERROR_BODY_CHARS);
      } catch {
        // Timed out while reading the error body; timedOut below reports it.
        errorBody = "";
      }
      return {
        status: res.status,
        errorBody,
        timedOut: controller.signal.aborted,
        retryAfter: res.headers.get("retry-after"),
      };
    }

    let data: unknown;
    try {
      const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
      data = contentType.includes("text/event-stream")
        ? { choices: [{ message: await readStreamingMessage(res, onDelta) }] }
        : await res.json();
    } catch {
      return { status: -1, errorBody: "", timedOut: controller.signal.aborted, retryAfter: null };
    }

    return { status: 200, data, errorBody: "", timedOut: false, retryAfter: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function readStreamingMessage(
  res: Response,
  onDelta?: (delta: ChatStreamDelta) => void,
): Promise<ChatMessage> {
  if (!res.body) throw new Error("LLM streaming response has no body");
  const messageId = crypto.randomUUID();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let inlinePending = "";
  let insideInlineThink = false;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  const emitInline = (type: ChatStreamDelta["type"], delta: string): void => {
    if (delta) onDelta?.({ messageId, type, delta });
  };
  const retainedTagPrefix = (value: string, tag: string): number => {
    const max = Math.min(value.length, tag.length - 1);
    for (let size = max; size > 0; size--) {
      if (tag.startsWith(value.slice(-size))) return size;
    }
    return 0;
  };
  const feedInlineContent = (delta: string, final = false): void => {
    inlinePending += delta;
    while (inlinePending) {
      const tag = insideInlineThink ? "</think>" : "<think>";
      const index = inlinePending.indexOf(tag);
      if (index >= 0) {
        emitInline(insideInlineThink ? "reasoning_delta" : "assistant_delta", inlinePending.slice(0, index));
        inlinePending = inlinePending.slice(index + tag.length);
        insideInlineThink = !insideInlineThink;
        continue;
      }
      const retained = final ? 0 : retainedTagPrefix(inlinePending, tag);
      const ready = inlinePending.slice(0, inlinePending.length - retained);
      emitInline(insideInlineThink ? "reasoning_delta" : "assistant_delta", ready);
      inlinePending = inlinePending.slice(inlinePending.length - retained);
      break;
    }
  };

  let finishReason: string | null = null;

  const consumeBlock = (block: string): void => {
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload || payload === "[DONE]") return;
    const parsed = JSON.parse(payload) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.choices) || parsed.choices.length === 0) return;
    const choice = parsed.choices[0];
    if (!isRecord(choice)) return;

    // 先检查 finish_reason：某些 provider 最后一个 chunk 可能没有 delta 字段。
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      finishReason = choice.finish_reason;
    }

    if (!isRecord(choice.delta)) return;
    const delta = choice.delta;
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      feedInlineContent(delta.content);
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      onDelta?.({ messageId, type: "reasoning_delta", delta: delta.reasoning_content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        if (!isRecord(raw)) throw new Error("LLM streaming response has invalid tool_call delta");
        const index = typeof raw.index === "number" ? raw.index : 0;
        const previous = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof raw.id === "string") previous.id += raw.id;
        if (isRecord(raw.function)) {
          if (typeof raw.function.name === "string") previous.name += raw.function.name;
          if (typeof raw.function.arguments === "string") previous.arguments += raw.function.arguments;
        }
        toolCalls.set(index, previous);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) consumeBlock(block);
    if (done || finishReason) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
  feedInlineContent("", true);

  const assembledTools: ToolCall[] = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => {
      if (!call.id || !call.name) throw new Error("LLM streaming response has incomplete tool_call");
      // Validate completeness now; Runtime must never execute partial JSON.
      JSON.parse(call.arguments);
      return { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } };
    });
  return {
    role: "assistant",
    content,
    reasoning_content: reasoning || undefined,
    tool_calls: assembledTools.length ? assembledTools : undefined,
  };
}

// 调用 LLM，返回 assistant 消息（可能含 tool_calls）
// ---- 模拟中断开关（测试用，已注释）----
// 需要模拟"任务执行中途网络中断"时，取消注释下面 4 行，并带 SIMULATE_INTERRUPT=1 运行：
//   SIMULATE_INTERRUPT=1 npx tsx --env-file=.env src/cli.ts "任务"
// 第 2 次 LLM 调用会抛网络错误，用于验证 checkpoint --resume 恢复链路。
// let __callCount = 0;
// export async function chat(
//   messages: ChatMessage[],
//   tools?: ToolSchema[]
// ): Promise<ChatMessage> {
//   __callCount++;
//   if (process.env.SIMULATE_INTERRUPT === "1" && __callCount === 2) {
//     throw new Error("Simulated network interruption: fetch failed (ECONNRESET)");
//   }
export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId?: string;
}

// 模型配置是原子元组：传入 modelConfig 则三个字段必须齐全并整体采用，
// 绝不逐字段回退环境配置（否则 provider A 的 baseUrl 会拿到 provider B 的密钥）；
// 未传入才整体回退环境配置三元组。
function resolveEndpointConfig(modelConfig?: ModelConfig): { baseUrl: string; apiKey: string; model: string } {
  if (modelConfig) {
    if (!modelConfig.baseUrl || !modelConfig.apiKey || !modelConfig.model) {
      throw new Error(
        "modelConfig is incomplete: baseUrl, apiKey and model are all required " +
        "(no per-field fallback to environment config)"
      );
    }
    return { baseUrl: modelConfig.baseUrl, apiKey: modelConfig.apiKey, model: modelConfig.model };
  }
  return { baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL };
}

export async function chat(
  messages: ChatMessage[],
  tools?: ToolSchema[],
  onDelta?: (delta: ChatStreamDelta) => void,
  modelConfig?: ModelConfig,
): Promise<ChatMessage> {
  const endpoint = resolveEndpointConfig(modelConfig);
  const resolvedBaseUrl = endpoint.baseUrl;
  const resolvedApiKey = endpoint.apiKey;
  const resolvedModel = endpoint.model;
  // max_tokens 必须来自当前实际请求的模型（Run snapshot 或环境 fallback），
  // 逐请求解析；禁止模块加载时按环境模型冻结能力。
  const modelContext = resolveModelContextConfig({ model: resolvedModel });
  const body: Record<string, unknown> = {
    model: resolvedModel,
    messages,
    max_tokens: modelContext.maxOutputTokens,
    stream: process.env.LLM_STREAMING !== "0",
  };
  if (tools?.length) body.tools = tools;

  const url = `${resolvedBaseUrl}/chat/completions`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const timeoutMs = requestTimeoutMs();
    const result = await doRequest(url, body, timeoutMs, resolvedApiKey, onDelta);

    // Total request timeout (no headers, stalled body, or stalled error body)
    // is terminal: do not auto-retry a long generation.
    if (result.timedOut) {
      throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    }

    // Connection error before any response → retry (bounded).
    if (result.status === 0) {
      if (attempt < MAX_RETRIES) {
        await wait(retryDelay(attempt, null));
        continue;
      }
      throw new Error(`LLM API request failed after ${attempt + 1} attempts: ${result.networkError}`);
    }

    // Body was not valid JSON → not transient, do not retry.
    if (result.status === -1) {
      throw new Error("LLM API malformed response: invalid JSON");
    }

    // Non-2xx. Retry only transient statuses (408/429/5xx).
    if (result.status !== 200) {
      if (retryableStatus(result.status) && attempt < MAX_RETRIES) {
        await wait(retryDelay(attempt, result.retryAfter));
        continue;
      }
      throw new Error(`LLM API error: ${result.status} ${result.errorBody}`.trim());
    }

    return parseAssistantMessage(result.data);
  }

  throw new Error("LLM API request failed");
}
