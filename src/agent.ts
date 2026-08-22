// 模块 3: Agent Loop — 控制 LLM 与 Tool 交互（含入口）

import { chat, type ChatMessage } from "./llm.js";
import { execute, getSchemas } from "./tools.js";
import { createTrace, addEvent, printEvent, printTrace } from "./trace.js";
import { createState, updateState, printState, printStateSummary } from "./state.js";

const MAX_ITERATIONS = 10; // 最大循环次数限制
const MAX_RETRY = 2; // 工具执行最大重试次数（总尝试 = 1 + MAX_RETRY）

const SYSTEM_PROMPT = `你是一个助手，可以使用工具帮助用户完成任务。
遇到任何计算任务，必须调用 calculator 工具获取结果，禁止自行计算。
当不需要工具时，直接给出最终答案。`;

// 去除推理模型（如 MiniMax-M3）内嵌的 <think> 思考标签
function stripThink(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (out.includes("<think>")) out = out.split("<think>")[0]; // 未闭合的思考块
  return out.trim();
}

// Agent 核心循环（只新增 State/Trace 记录，不改 Loop 逻辑）
export async function runAgent(task: string): Promise<string> {
  // State: 启动时创建
  const state = createState(task);
  const trace = createTrace();
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      console.log(`\n--- 迭代 ${i + 1} ---`);

      // State: 进入循环，更新迭代次数
      updateState(state, { iteration: i + 1, currentStep: "llm_call" });
      printStateSummary(state);

      // 1. 调用 LLM 判断下一步
      const assistantMsg = await chat(messages, getSchemas());
      messages.push(assistantMsg);

      // Trace: LLM 调用（输入消息数 / 迭代次数 / 返回内容 / 是否产生 tool_call）
      printEvent(
        addEvent(trace, {
          type: "llm_call",
          messageCount: messages.length,
          iteration: i + 1,
          response: assistantMsg.content,
          hasToolCalls: !!assistantMsg.tool_calls?.length,
        })
      );

      // 2. LLM 决策日志：是否选择工具
      if (!assistantMsg.tool_calls?.length) {
        console.log("[LLM 决策] 未选择工具 → 生成最终答案");
        // 历史消息保留原始 content（维持推理链），仅展示时去除 think 标签
        const answer = stripThink(assistantMsg.content);

        // Trace: 最终答案 + 总执行步骤数
        printEvent(
          addEvent(trace, {
            type: "final_answer",
            content: answer,
            totalSteps: i + 1,
          })
        );

        // State: 完成
        updateState(state, { status: "completed", currentStep: "final_answer" });
        printStateSummary(state);
        printState(state);
        printTrace(trace);
        return answer;
      }

      const toolNames = assistantMsg.tool_calls
        .map((c) => c.function.name)
        .join(", ");
      console.log(`[LLM 决策] 选择工具: ${toolNames}`);

      // 3. 执行工具（含重试）
      for (const call of assistantMsg.tool_calls) {
        // State: 调用工具前
        updateState(state, { currentStep: `tool_call:${call.function.name}` });
        printStateSummary(state);

        console.log(`[Tool 调用] ${call.function.name}(${call.function.arguments})`);
        const args = JSON.parse(call.function.arguments);

        // Trace: 工具调用前
        printEvent(
          addEvent(trace, { type: "tool_call", tool: call.function.name, args })
        );

        // 工具执行 + 重试（最多 MAX_RETRY 次）
        let result = "";
        for (let attempt = 1; attempt <= MAX_RETRY + 1; attempt++) {
          try {
            const start = performance.now();
            result = await execute(call.function.name, args);
            const durationMs = Math.round((performance.now() - start) * 100) / 100;
            console.log(`[Tool 返回] ${result}`);

            // State: 工具完成
            updateState(state, {
              toolCalls: state.toolCalls + 1,
              currentStep: "tool_result",
            });
            printStateSummary(state);

            // Trace: 工具结果（含耗时）
            printEvent(
              addEvent(trace, {
                type: "tool_result",
                tool: call.function.name,
                result,
                durationMs,
              })
            );

            // 4. 将工具结果返回给 LLM
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: result,
            });
            break; // 成功，跳出重试
          } catch (err) {
            const msg = (err as Error).message;
            console.log(`[Tool 错误] ${call.function.name}: ${msg}`);

            // Trace: 工具错误事件
            printEvent(
              addEvent(trace, {
                type: "error",
                message: `tool ${call.function.name} 失败 (尝试 ${attempt}/${MAX_RETRY + 1}): ${msg}`,
              })
            );

            // State: 错误状态
            updateState(state, { currentStep: "tool_error", error: msg });
            printStateSummary(state);

            if (attempt > MAX_RETRY) {
              // 超过重试次数 → 任务失败
              updateState(state, { status: "failed", error: msg });
              printStateSummary(state);
              printState(state);
              printTrace(trace);
              throw new Error(
                `工具 ${call.function.name} 执行失败，已超过最大重试次数 ${MAX_RETRY}: ${msg}`
              );
            }
            console.log(
              `[重试 ${attempt}/${MAX_RETRY}] 工具 ${call.function.name} 失败，正在重试...`
            );
          }
        }
      }
      // 5. 循环 → LLM 继续判断
    }
  } catch (err) {
    // State: 失败
    updateState(state, { status: "failed", currentStep: "error" });
    printStateSummary(state);
    printState(state);
    // Trace: 错误
    printEvent(
      addEvent(trace, { type: "error", message: (err as Error).message })
    );
    printTrace(trace);
    throw err;
  }

  // 超出最大迭代次数
  updateState(state, { status: "failed", currentStep: "error" });
  printStateSummary(state);
  printState(state);
  printEvent(addEvent(trace, { type: "error", message: "超过最大循环次数限制" }));
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
