// 模块 3: Agent Loop — 控制 LLM 与 Tool 交互（含入口）

import { chat, type ChatMessage } from "./llm.js";
import { execute, getSchemas } from "./tools.js";

const MAX_ITERATIONS = 10; // 最大循环次数限制

const SYSTEM_PROMPT = `你是一个助手，可以使用工具帮助用户完成任务。
遇到任何计算任务，必须调用 calculator 工具获取结果，禁止自行计算。
当不需要工具时，直接给出最终答案。`;

// 去除推理模型（如 MiniMax-M3）内嵌的 <think> 思考标签
function stripThink(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (out.includes("<think>")) out = out.split("<think>")[0]; // 未闭合的思考块
  return out.trim();
}

// Agent 核心循环
export async function runAgent(task: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`\n--- 迭代 ${i + 1} ---`);

    // 1. 调用 LLM 判断下一步
    const assistantMsg = await chat(messages, getSchemas());
    messages.push(assistantMsg);

    // 2. LLM 决策日志：是否选择工具
    if (!assistantMsg.tool_calls?.length) {
      console.log("[LLM 决策] 未选择工具 → 生成最终答案");
      // 历史消息保留原始 content（维持推理链），仅展示时去除 think 标签
      return stripThink(assistantMsg.content);
    }

    const toolNames = assistantMsg.tool_calls
      .map((c) => c.function.name)
      .join(", ");
    console.log(`[LLM 决策] 选择工具: ${toolNames}`);

    // 3. 执行工具
    for (const call of assistantMsg.tool_calls) {
      console.log(`[Tool 调用] ${call.function.name}(${call.function.arguments})`);
      const result = await execute(
        call.function.name,
        JSON.parse(call.function.arguments)
      );
      console.log(`[Tool 返回] ${result}`);

      // 4. 将工具结果返回给 LLM
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    // 5. 循环 → LLM 继续判断
  }

  throw new Error("超过最大循环次数限制");
}

// ---- 入口 ----
const task = process.argv[2] || "帮我计算 15 * 37";
console.log(`任务: ${task}`);
const answer = await runAgent(task);
console.log(`\n最终答案: ${answer}`);
