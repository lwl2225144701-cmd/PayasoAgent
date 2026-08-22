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
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

// 调用 LLM，返回 assistant 消息（可能含 tool_calls）
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
  };
}
