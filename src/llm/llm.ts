// 模块 1: LLM 封装 — OpenAI 兼容 chat/completions（纯 fetch，无 SDK 依赖）

const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`LLM API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const msg = data.choices[0].message;
  return {
    role: "assistant",
    content: msg.content ?? "",
    tool_calls: msg.tool_calls,
    reasoning_content: typeof msg.reasoning_content === "string" ? msg.reasoning_content : undefined,
  };
}
