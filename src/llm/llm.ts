// 模块 1: LLM 封装 — OpenAI 兼容 chat/completions（纯 fetch，无 SDK 依赖）

const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 100;
const MAX_ERROR_BODY_CHARS = 2_000;

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
export async function chat(
  messages: ChatMessage[],
  tools?: ToolSchema[]
): Promise<ChatMessage> {
  const body: Record<string, unknown> = { model: MODEL, messages };
  if (tools?.length) body.tools = tools;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await wait(retryDelay(attempt, null));
        continue;
      }
      const reason = controller.signal.aborted ? "request timed out" : (err as Error).message;
      throw new Error(`LLM API request failed after ${attempt + 1} attempts: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      if (retryableStatus(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = res.headers.get("retry-after");
        try { await res.body?.cancel(); } catch { /* ignore response cleanup failure */ }
        await wait(retryDelay(attempt, retryAfter));
        continue;
      }
      const errorBody = (await res.text()).slice(0, MAX_ERROR_BODY_CHARS);
      throw new Error(`LLM API error: ${res.status} ${errorBody}`.trim());
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error("LLM API malformed response: invalid JSON");
    }
    return parseAssistantMessage(data);
  }

  throw new Error("LLM API request failed");
}
