// 模块 3: Agent Loop — 控制 LLM 与 Tool 交互（含入口）

import { chat, type ChatMessage } from "./llm.js";
import { execute, getSchemas } from "./tools.js";
import { createTrace, addEvent, printEvent, printTrace } from "./trace.js";
import { createState, updateState, printState, printStateSummary } from "./state.js";
import { ContextManager } from "./context.js";
import { saveCheckpoint, loadCheckpoint } from "./checkpoint.js";
import {
  createScratchpad,
  setNextStep,
  completeStep,
  recordFailure,
  isBlocked,
  clearFailure,
  toSystemText,
  printScratchpad,
} from "./scratchpad.js";

const MAX_ITERATIONS = 10; // 最大循环次数限制
const MAX_RETRY = 2; // 工具执行最大重试次数（总尝试 = 1 + MAX_RETRY）
const MAX_CONTEXT_TOKENS = 4000; // 发送给 LLM 的上下文上限（粗略字符数）

const SYSTEM_PROMPT = `你是一个助手，可以使用工具帮助用户完成任务。
遇到任何计算任务，必须调用 calculator 工具获取结果，禁止自行计算。
当不需要工具时，直接给出最终答案。`;

// 去除推理模型（如 MiniMax-M3）内嵌的 <think> 思考标签
function stripThink(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (out.includes("<think>")) out = out.split("<think>")[0]; // 未闭合的思考块
  return out.trim();
}

// Agent 核心循环（只新增 State/Trace/Checkpoint 记录，不改 Loop 逻辑）
// resume: 传入 checkpoint 则从中断点恢复执行（State/Scratchpad/Messages 一并恢复）
export async function runAgent(
  task: string,
  resume?: { runId: string; task: string; status: string; iteration: number; scratchpad: ReturnType<typeof createScratchpad>; messages: ChatMessage[]; state: ReturnType<typeof createState> }
): Promise<string> {
  // 一次 Agent Run = 唯一 runId（State/Trace/Checkpoint 共用；resume 沿用原 runId）
  const runId = resume ? resume.state.runId : crypto.randomUUID();

  // State: 新建或从 checkpoint 恢复
  const state = resume ? resume.state : createState(task, runId);
  const trace = createTrace(runId);
  const contextManager = new ContextManager(MAX_CONTEXT_TOKENS);
  const scratchpad = resume ? resume.scratchpad : createScratchpad(task);
  let messages: ChatMessage[] = resume
    ? resume.messages
    : [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: task },
      ];
  // 恢复时从上一轮重试（该轮可能未完成）；否则从 0 开始
  const startIter = resume ? Math.max(0, resume.iteration - 1) : 0;

  // Checkpoint 保存（tool_result / tool_error / 完成 / 失败时调用）
  const save = (status?: string) => {
    const file = saveCheckpoint({
      runId,
      task: state.task,
      status: status ?? state.status,
      iteration: state.iteration,
      scratchpad,
      messages,
      state,
    });
    console.log(`[Checkpoint] saved → ${file}`);
  };

  if (resume) {
    console.log(
      `[恢复] 从 checkpoint 继续: runId=${resume.runId} 已完成 ${scratchpad.completedSteps.length} 步, 重跑迭代 ${startIter + 1}`
    );
  }

  try {
    for (let i = startIter; i < MAX_ITERATIONS; i++) {
      console.log(`\n--- 迭代 ${i + 1} ---`);

      // State: 进入循环，更新迭代次数
      updateState(state, { iteration: i + 1, currentStep: "llm_call" });
      printStateSummary(state);

      // 0. 将 Scratchpad 注入 system（独立对象，不随 messages 裁剪丢失）
      messages[0] = {
        role: "system",
        content: SYSTEM_PROMPT + "\n\n" + toSystemText(scratchpad),
      };

      // 0.5 上下文裁剪（Scratchpad 不在 messages 中，裁剪不影响其完整性）
      const ctx = contextManager.process(messages);
      messages = ctx.messages;
      printEvent(
        addEvent(trace, {
          type: "context_trim",
          beforeMessages: ctx.before,
          afterMessages: ctx.after,
        })
      );
      if (ctx.before !== ctx.after) {
        console.log(`\n=== Context ===`);
        console.log(`before:\n${ctx.before} messages`);
        console.log(`after:\n${ctx.after} messages`);
        console.log(`trimmed:\n${ctx.before - ctx.after}`);
      }

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

        // State: 完成（清空当前错误与待执行动作；历史错误保留在 lastToolError / failedSteps / Trace）
        updateState(state, {
          status: "completed",
          currentStep: "final_answer",
          currentError: undefined,
          pendingAction: undefined,
        });
        printStateSummary(state);
        // Checkpoint: 完成时保存
        save("completed");
        printState(state);
        printTrace(trace);
        return answer;
      }

      const toolNames = assistantMsg.tool_calls
        .map((c) => c.function.name)
        .join(", ");
      console.log(`[LLM 决策] 选择工具: ${toolNames}`);

      // 3. 执行工具（含重试 + 失败恢复 + 防死循环）
      for (const call of assistantMsg.tool_calls) {
        const toolName = call.function.name;
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        const input =
          "expression" in args ? String(args.expression) : call.function.arguments;

        // 防死循环：相同 tool + 相同参数已失败超过重试次数 → 禁止再次调用
        if (isBlocked(scratchpad, toolName, input, MAX_RETRY)) {
          const blockMsg = `工具 ${toolName} 参数 "${input}" 已失败超过重试次数，禁止再次调用相同参数。请修正参数、换其他方法或向用户说明失败原因。`;
          console.log(`[Blocked] ${blockMsg}`);

          // State: 记录被禁状态（不推进步骤）
          updateState(state, {
            currentStep: "tool_blocked",
            currentError: "重复失败被禁止调用",
            lastToolError: {
              tool: toolName,
              input,
              error: "重复失败被禁止调用",
              retries: MAX_RETRY + 1,
            },
          });
          printStateSummary(state);

          // 将禁止消息返回 LLM，由其重新决策
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: blockMsg,
          });
          continue;
        }

        // State: 调用工具前（总调用次数 +1，记录待执行动作）
        updateState(state, {
          currentStep: `tool_call:${toolName}`,
          toolCalls: state.toolCalls + 1,
          pendingAction: { tool: toolName, input },
        });
        printStateSummary(state);

        console.log(`[Tool 调用] ${toolName}(${call.function.arguments})`);

        // Scratchpad: 记录计划执行的下一步（未完成，不进 completedSteps）
        setNextStep(scratchpad, { tool: toolName, input });

        // Trace: 工具调用前
        printEvent(
          addEvent(trace, { type: "tool_call", tool: toolName, args })
        );

        // 工具执行 + 重试（最多 MAX_RETRY 次）；重试耗尽进入失败恢复
        for (let attempt = 1; attempt <= MAX_RETRY + 1; attempt++) {
          try {
            const start = performance.now();
            const result = await execute(toolName, args);
            const durationMs = Math.round((performance.now() - start) * 100) / 100;
            console.log(`[Tool 返回] ${result}`);

            // State: 工具成功（清空当前错误与待执行动作；lastToolError 保留历史）
            updateState(state, {
              successfulToolCalls: state.successfulToolCalls + 1,
              currentStep: "tool_result",
              pendingAction: undefined,
              currentError: undefined,
            });
            printStateSummary(state);

            // Trace: 工具结果（含耗时）
            printEvent(
              addEvent(trace, {
                type: "tool_result",
                tool: toolName,
                result,
                durationMs,
              })
            );

            // Scratchpad: 工具成功 → 当前步骤移入 completedSteps，清空 nextStep，并解禁该参数
            completeStep(scratchpad, result);
            clearFailure(scratchpad, toolName, input);
            printScratchpad(scratchpad);
            printEvent(
              addEvent(trace, {
                type: "scratchpad_update",
                currentStep: scratchpad.nextStep
                  ? `${scratchpad.nextStep.tool}(${scratchpad.nextStep.input})`
                  : "(等待 LLM 决策)",
                completedSteps: scratchpad.completedSteps.length,
                lastResult: scratchpad.lastResult,
              })
            );

            // 4. 将工具结果返回给 LLM
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: result,
            });
            // Checkpoint: 工具成功后保存
            save();
            break; // 成功，跳出重试
          } catch (err) {
            const msg = (err as Error).message;
            console.log(`[Tool 错误] ${toolName}: ${msg}`);

            // Scratchpad: 记录失败（不推进 completedSteps，不推进 nextStep）
            recordFailure(scratchpad, { tool: toolName, input, error: msg });

            // Trace: 工具错误事件
            printEvent(
              addEvent(trace, {
                type: "tool_error",
                tool: toolName,
                error: msg,
                attempt,
                exhausted: attempt > MAX_RETRY,
              })
            );

            // State: 错误状态（当前错误 + 失败历史 lastToolError，不推进步骤）
            updateState(state, {
              currentStep: "tool_error",
              currentError: msg,
              lastToolError: { tool: toolName, input, error: msg, retries: attempt },
            });
            printStateSummary(state);
            // Checkpoint: 工具失败后保存
            save();

            if (attempt > MAX_RETRY) {
              // 重试耗尽 → 失败恢复：将错误作为消息返回 LLM，由其决策
              console.log(
                `[恢复] 工具 ${toolName} 重试 ${MAX_RETRY} 次仍失败，将错误返回 LLM 由其决策`
              );
              // State: 工具失败（仅当所有重试均失败）
              updateState(state, {
                failedToolCalls: state.failedToolCalls + 1,
              });
              printEvent(
                addEvent(trace, {
                  type: "recovery_decision",
                  tool: toolName,
                  decision: `工具 ${toolName} 重试 ${MAX_RETRY} 次仍失败，已将错误返回 LLM，由其决定：修正参数重新调用 / 换其他方法 / 直接向用户说明失败原因`,
                })
              );
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: `工具 ${toolName} 参数 "${input}" 执行失败（重试 ${MAX_RETRY} 次）：${msg}。禁止再次使用相同参数调用，请修正参数或换其他方法。`,
              });
              break; // 跳出重试，外层循环继续 → LLM 重新决策
            }
            console.log(
              `[重试 ${attempt}/${MAX_RETRY}] 工具 ${toolName} 失败，正在重试...`
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
    // Checkpoint: 失败时保存（含错误状态，可 resume）
    save("failed");
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
  // Checkpoint: 超限时保存
  save("failed");
  printState(state);
  printEvent(addEvent(trace, { type: "error", message: "超过最大循环次数限制" }));
  printTrace(trace);
  throw new Error("超过最大循环次数限制");
}

// ---- 入口 ----
// 用法:
//   npm start "任务"            正常执行
//   npm start -- --resume <runId>   从 checkpoint 恢复执行
const args = process.argv.slice(2);
const resumeIdx = args.indexOf("--resume");
const resumeId = resumeIdx >= 0 ? args[resumeIdx + 1] : undefined;

if (resumeId) {
  const cp = loadCheckpoint(resumeId);
  if (!cp) {
    console.error(`[Error] checkpoint 不存在: .checkpoints/${resumeId}.json`);
    process.exit(1);
  }
  console.log(`任务: ${cp.task}（恢复执行）`);
  try {
    const answer = await runAgent(cp.task, cp);
    console.log(`\n最终答案: ${answer}`);
  } catch (err) {
    console.error(`\n[Error] ${(err as Error).message}`);
    process.exit(1);
  }
} else {
  const task = args[0] || "帮我计算 15 * 37";
  console.log(`任务: ${task}`);
  try {
    const answer = await runAgent(task);
    console.log(`\n最终答案: ${answer}`);
  } catch (err) {
    console.error(`\n[Error] ${(err as Error).message}`);
    process.exit(1);
  }
}
