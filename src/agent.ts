// 模块 3: Agent Loop — 控制 LLM 与 Tool 交互（含入口）

import { chat, type ChatMessage } from "./llm.js";
import { execute, getSchemas } from "./tools.js";
import { createTrace, addEvent, printTrace } from "./trace.js";

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

// Agent 核心循环（只新增 Trace 记录，不改 Loop 逻辑）
export async function runAgent(task: string): Promise<string> {
  const trace = createTrace();
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      console.log(`\n--- 迭代 ${i + 1} ---`);

      // 1. 调用 LLM 判断下一步
      const assistantMsg = await chat(messages, getSchemas());
      messages.push(assistantMsg);

      // Trace: LLM 调用（输入消息数 / 迭代次数 / 返回内容 / 是否产生 tool_call）
      addEvent(trace, {
        type: "llm_call",
        messageCount: messages.length,
        iteration: i + 1,
        response: assistantMsg.content,
        hasToolCalls: !!assistantMsg.tool_calls?.length,
      });

      // 2. LLM 决策日志：是否选择工具
      if (!assistantMsg.tool_calls?.length) {
        console.log("[LLM 决策] 未选择工具 → 生成最终答案");
        // 历史消息保留原始 content（维持推理链），仅展示时去除 think 标签
        const answer = stripThink(assistantMsg.content);

        // Trace: 最终答案 + 总执行步骤数
        addEvent(trace, {
          type: "final_answer",
          content: answer,
          totalSteps: i + 1,
        });
        printTrace(trace);
        return answer;
      }

      const toolNames = assistantMsg.tool_calls
        .map((c) => c.function.name)
        .join(", ");
      console.log(`[LLM 决策] 选择工具: ${toolNames}`);

      // 3. 执行工具
      for (const call of assistantMsg.tool_calls) {
        console.log(`[Tool 调用] ${call.function.name}(${call.function.arguments})`);
        const args = JSON.parse(call.function.arguments);

        // Trace: 工具调用前
        addEvent(trace, { type: "tool_call", tool: call.function.name, args });

        const start = performance.now();
        const result = await execute(call.function.name, args);
        const durationMs = Math.round((performance.now() - start) * 100) / 100;
        console.log(`[Tool 返回] ${result}`);

        // Trace: 工具结果（含耗时）
        addEvent(trace, {
          type: "tool_result",
          tool: call.function.name,
          result,
          durationMs,
        });

        // 4. 将工具结果返回给 LLM
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }
      // 5. 循环 → LLM 继续判断
    }
  } catch (err) {
    // Trace: 错误
    addEvent(trace, { type: "error", message: (err as Error).message });
    printTrace(trace);
    throw err;
  }

  addEvent(trace, { type: "error", message: "超过最大循环次数限制" });
  printTrace(trace);
  throw new Error("超过最大循环次数限制");
}

// ---- 入口 ----
const task = process.argv[2] || "帮我计算 15 * 37";
console.log(`任务: ${task}`);
try {
  const answer = await runAgent(task);
  console.log(`\n最终答案: ${answer}`);
} catch (err) {
  console.error(`\n[Error] ${(err as Error).message}`);
  process.exit(1);
}
