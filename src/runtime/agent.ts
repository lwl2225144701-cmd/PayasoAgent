// 模块 3: Agent Loop — 控制 LLM 与 Tool 交互（Runtime 内核，不含 CLI 入口）

import { chat, type ChatMessage, type ChatStreamDelta, type ModelConfig } from "../llm/llm.js";
import { execute, formatToolCallError, getTool, getSchemas, parseToolArguments, toolNotFoundError, validateToolResult, type ToolCallError, type ToolSandboxEvent } from "../tools/tools.js";
import { createTrace, addEvent, type TraceEvent, type TraceEventInput } from "./trace.js";
import { createState, updateState } from "./state.js";
import { DefaultContextHarness, type AgentContextHarness } from "../harness/context-harness.js";
import { guardToolOutput } from "./output-guard.js";
import { storedPermissionMode } from "../permission-mode.js";
import type { AgentExecutionContext } from "./contracts.js";
import type { CheckpointSnapshot, CheckpointWriter } from "./checkpoint-port.js";
import { protectRuntimeObserver, type RuntimeObserver } from "./observer-port.js";
import {
  createSideEffectGuard,
  markExecuted,
  resolveOperation,
  operationIdentity,
} from "./side-effect.js";
import { isAbortError, throwIfAborted } from "../util/abort.js";
import {
  createScratchpad,
  setNextStep,
  completeStep,
  recordFailure,
  isBlocked,
  clearFailure,
  recordInvalid,
} from "./scratchpad.js";

const MAX_ITERATIONS = 10; // 最大循环次数限制
const MAX_RETRY = 2; // 工具执行最大重试次数（总尝试 = 1 + MAX_RETRY）

// Agent 核心循环（只新增 State/Trace/Checkpoint 记录，不改 Loop 逻辑）
// resume: 传入 checkpoint 则从中断点恢复执行（State/Scratchpad/Messages 一并恢复）
// executionContext: 由 Host/bootstrap 授权并注入；Runtime 不创建 Workspace、不升级权限。
export async function runAgent(
  task: string,
  resume: CheckpointSnapshot | undefined,
  opts: {
    executionContext: AgentExecutionContext;
    // Required Runtime port: composition chooses the persistence adapter.
    checkpointWriter: CheckpointWriter;
    observer: RuntimeObserver;
    conversationHistory?: ChatMessage[];
    onStreamDelta?: (delta: ChatStreamDelta) => void;
    onTrace?: (ev: TraceEvent) => void;
    // True cancellation (v1.6)：Run 的 AbortSignal，是唯一取消机制。
    // 检查点：迭代边界、每个 tool_call 之前；并传播进 chat()（HTTP/流式）
    // 与 ToolContext.signal（shell 进程组终止）。Host 在 abort 前负责把
    // Run 置为 stopping，agent 以 AbortError 退出后由 Host 落 stopped。
    signal?: AbortSignal;
    modelConfig?: ModelConfig;
    // Harness owns the model-visible projection. Host/tests may inject a
    // different implementation without changing Runtime execution semantics.
    contextHarness?: AgentContextHarness;
  }
): Promise<string> {
  const { executionContext } = opts;
  const runId = resume ? resume.state.runId : executionContext.runId;
  if (executionContext.runId !== runId) {
    throw new Error("Execution context runId does not match Runtime state");
  }
  const workspaceRoot = executionContext.workspaceRoot;
  const permissionMode = executionContext.permissionMode;
  if (resume?.workspaceRoot && resume.workspaceRoot !== workspaceRoot) {
    throw new Error("Execution context Workspace does not match checkpoint");
  }
  if (resume?.permissionMode && storedPermissionMode(resume.permissionMode) !== permissionMode) {
    throw new Error("Execution context permission does not match checkpoint");
  }
  const toolContext = { runId, workspaceRoot, permissionMode };
  const observer = protectRuntimeObserver(opts.observer);
  const emit = (input: TraceEventInput): TraceEvent => {
    const event = addEvent(trace, input);
    observer.traceEvent(structuredClone(event));
    return event;
  };

  // State: 新建或从 checkpoint 恢复
  const state = resume ? resume.state : createState(task, runId);
  const trace = createTrace(runId, opts.onTrace);
  const observeState = (detail: "summary" | "full"): void => {
    observer.state(structuredClone(state), detail);
  };
  const observeScratchpad = (): void => {
    observer.scratchpad(structuredClone(scratchpad));
  };
  const observeTrace = (): void => {
    observer.trace({ run_id: trace.run_id, events: structuredClone(trace.events) });
  };
  // Context Harness：决定模型看到的指令、历史视图、Scratchpad 视图与预算。
  // Runtime 只持有完整 transcript，并消费 prepareTurn() 的临时模型视图。
  const contextHarness = opts.contextHarness ?? new DefaultContextHarness({
    permissionMode,
    modelConfig: opts.modelConfig,
  });
  contextHarness.restoreState(resume?.harnessState);
  const modelContext = contextHarness.modelContext;
  const scratchpad = resume ? resume.scratchpad : createScratchpad(task);
  // v1.3 Side-Effect Safety：记录已成功执行的 non_idempotent 操作；resume 时从 checkpoint 恢复
  const sideEffectGuard = createSideEffectGuard(resume?.sideEffects ?? []);
  let messages: ChatMessage[] = resume
    ? resume.messages
    : contextHarness.createTranscript(task, opts.conversationHistory);
  // 恢复时从上一轮重试（该轮可能未完成）；否则从 0 开始
  const startIter = resume ? Math.max(0, resume.iteration - 1) : 0;

  // Checkpoint 保存（tool_result / tool_error / 完成 / 失败时调用）
  const save = (status?: string) => {
    const file = opts.checkpointWriter.save({
      runId,
      task: state.task,
      status: status ?? state.status,
      iteration: state.iteration,
      scratchpad,
      messages,
      state,
      workspaceRoot,
      permissionMode,
      sideEffects: sideEffectGuard.snapshot(),
      harnessState: contextHarness.snapshotState(),
    });
    observer.log(`[Checkpoint] saved → ${file}`);
  };

  if (resume) {
    observer.log(
      `[恢复] 从 checkpoint 继续: runId=${resume.runId} 已完成 ${scratchpad.completedSteps.length} 步, 重跑迭代 ${startIter + 1}`
    );
  }

  // v1.6 Tool Call Pipeline：invocation error（malformed JSON / 非 object 参数 /
  // 未知工具）→ 标准化 tool error result（保留 tool_call_id 关联）+ trace +
  // checkpoint。工具不执行、不创建 side-effect operation，由模型下一轮自行修正。
  const pushToolCallError = (toolCallId: string, toolName: string, error: ToolCallError): void => {
    updateState(state, {
      currentStep: "tool_call_invalid",
      currentError: `${error.code}: ${error.message}`,
    });
    observeState("summary");
    emit({
      type: "tool_call_invalid",
      toolCallId,
      tool: toolName,
      code: error.code,
    });
    observer.log(`[Tool Call Invalid] ${toolName}: ${error.code}`);
    messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: formatToolCallError(error),
    });
    save();
  };

  try {
    for (let i = startIter; i < MAX_ITERATIONS; i++) {
      // True cancellation（v1.6）：迭代边界检查 —— 上一轮工具完成后、发起新一轮
      // LLM 请求前生效。中途取消由 signal 传播进 chat()/tool 执行负责。
      throwIfAborted(opts.signal);
      observer.log(`\n--- 迭代 ${i + 1} ---`);

      // State: 进入循环，更新迭代次数
      updateState(state, { iteration: i + 1, currentStep: "llm_call" });
      observeState("summary");

      // 0. Harness 投影本轮模型视图。完整 transcript 不被裁剪或改写；
      // system / permission / Scratchpad 和历史预算全部由 Harness 决定。
      const schemas = getSchemas();
      const ctx = await contextHarness.prepareTurn(messages, scratchpad, schemas, opts.signal);
      emit({
        type: "context_trim",
        beforeMessages: ctx.usage.beforeMessages,
        afterMessages: ctx.usage.afterMessages,
      });
      emit({
        type: "context_usage",
        model: modelContext.model,
        configSource: modelContext.source,
        contextWindowTokens: modelContext.contextWindowTokens,
        maxOutputTokens: modelContext.maxOutputTokens,
        safetyTokens: modelContext.safetyTokens,
        inputBudgetTokens: ctx.usage.inputBudgetTokens,
        messageTokens: ctx.usage.messageTokens,
        toolSchemaTokens: ctx.usage.toolSchemaTokens,
        scratchpadTokens: ctx.scratchpadTokens,
        estimatedInputTokens: ctx.usage.estimatedInputTokens,
        usageRatio: ctx.usage.usageRatio,
        trimmedMessages: ctx.usage.trimmedMessages,
        overBudget: ctx.usage.overBudget,
      });
      if (ctx.compaction) {
        emit({
          type: "context_compaction",
          summarizedMessages: ctx.compaction.summarizedMessages,
          totalSummarizedMessages: ctx.compaction.totalSummarizedMessages,
          summaryTokens: ctx.compaction.summaryTokens,
        });
      }
      if (ctx.usage.beforeMessages !== ctx.usage.afterMessages) {
        observer.log(`\n=== Context ===`);
        observer.log(`before:\n${ctx.usage.beforeMessages} messages`);
        observer.log(`after:\n${ctx.usage.afterMessages} messages`);
        observer.log(`trimmed:\n${ctx.usage.trimmedMessages}`);
      }
      if (ctx.usage.overBudget) {
        throw new Error(
          `Context budget exceeded: estimated ${ctx.usage.estimatedInputTokens} input tokens, ` +
          `budget ${ctx.usage.inputBudgetTokens}`
        );
      }

      // 1. 调用 LLM 判断下一步
      // 1. 调用 LLM 判断下一步（signal 直达 HTTP/流式层：abort 立即中断在途请求）
      const assistantMsg = await chat(ctx.messages, schemas, opts.onStreamDelta, opts.modelConfig, opts.signal);
      // Provider reasoning_content and inline <think> blocks are trace/display
      // concerns only; neither is persisted into the next LLM context.
      const { reasoning_content } = assistantMsg;
      const assistantHistoryMessage = contextHarness.sanitizeAssistantMessage(assistantMsg);
      messages.push(assistantHistoryMessage);

      // Trace: LLM 调用（输入消息数 / 迭代次数 / 返回内容 / 是否产生 tool_call）
      emit({
        type: "llm_call",
        messageCount: messages.length,
        iteration: i + 1,
        response: assistantMsg.content,
        reasoning: reasoning_content,
        hasToolCalls: !!assistantMsg.tool_calls?.length,
      });

      // 2. LLM 决策日志：是否选择工具
      if (!assistantMsg.tool_calls?.length) {
        observer.log("[LLM 决策] 未选择工具 → 生成最终答案");
        const answer = contextHarness.sanitizeFinalAnswer(assistantMsg.content);

        // Trace: 最终答案 + 总执行步骤数
        emit({
          type: "final_answer",
          content: answer,
          totalSteps: i + 1,
        });

        // State: 完成（清空当前错误与待执行动作；历史错误保留在 lastToolError / failedSteps / Trace）
        updateState(state, {
          status: "completed",
          currentStep: "final_answer",
          currentError: undefined,
          pendingAction: undefined,
        });
        observeState("summary");
        // Checkpoint: 完成时保存
        save("completed");
        observeState("full");
        observeScratchpad();
        observeTrace();
        return answer;
      }

      const toolNames = assistantMsg.tool_calls
        .map((c) => c.function.name)
        .join(", ");
      observer.log(`[LLM 决策] 选择工具: ${toolNames}`);

      // 3. 执行工具（含重试 + 失败恢复 + 防死循环）
      for (const call of assistantMsg.tool_calls) {
        // True cancellation：工具间检查 —— 前一个工具返回后用户 Stop，
        // 不再执行本条消息里剩余的 tool_calls，也不发下一轮 LLM。
        throwIfAborted(opts.signal);
        const toolName = call.function.name;

        // v1.6 Tool Call Pipeline ①②：Parse + Validate。
        // malformed / 非 object 的 arguments 是可恢复 invocation error：
        // 工具绝不执行、side-effect 绝不创建，结构化错误回传模型修正。
        const parsed = parseToolArguments(call.function.arguments);
        if (!parsed.ok) {
          pushToolCallError(call.id, toolName, parsed.error);
          continue;
        }
        const args = parsed.args;

        // v1.6 Pipeline ③：Resolve —— 未知工具同样是 invocation error，
        // 直接回传错误结果，不进入 execution retry（模型修正 ≠ 瞬态重试）。
        const toolDef = getTool(toolName);
        if (!toolDef) {
          pushToolCallError(call.id, toolName, toolNotFoundError(toolName));
          continue;
        }

        // 规范化输入：calculator 用表达式原文；其余工具用规范化 JSON（消除 LLM 序列化空白差异，
        // 否则同参数换空格写法可绕过 isBlocked 的防重调/防死循环判定）
        const input =
          "expression" in args ? String(args.expression) : JSON.stringify(args);

        // v1.3.2 Side-Effect Safety：non_idempotent 操作生命周期 ——
        //   succeeded  → 回放首次结果，不执行
        //   executing / uncertain → 不执行，返回明确 uncertain recovery 信息（不伪造成功）
        //   start      → 正常开始（execute 前持久化 executing，见下）
        // 置于防死循环判定之前。
        if (toolDef?.effect === "non_idempotent") {
          // 注入 ToolContext（runId + workspaceRoot）供路径工具归一化 identity；LLM 不可覆盖
          const disposition = resolveOperation(sideEffectGuard, toolDef, args, toolContext);
          if (disposition.kind === "replay") {
            observer.log(
              `[Side-Effect Skip] ${toolName} 操作已成功执行过（同一 canonical operation key），回放结果，不重复执行副作用`
            );
            emit({
              type: "side_effect_skip",
              tool: toolName,
              key: operationIdentity(toolDef, args, toolContext),
              replayed: true,
            });
            messages.push({ role: "tool", tool_call_id: call.id, content: disposition.result });
            continue;
          }
          if (disposition.kind === "uncertain") {
            const uncertainMsg =
              `工具 ${toolName} 该操作（canonical key=${operationIdentity(toolDef, args, toolContext)}）` +
              `此前已开始执行但结果不确定（executing/uncertain），Runtime 不会再次自动执行以防重复副作用。` +
              `请勿再次使用相同参数调用；请修正参数、换其他方法或向用户说明。`;
            observer.log(`[Side-Effect Uncertain] ${uncertainMsg}`);
            emit({
              type: "side_effect_uncertain",
              tool: toolName,
              key: operationIdentity(toolDef, args, toolContext),
            });
            messages.push({ role: "tool", tool_call_id: call.id, content: uncertainMsg });
            continue;
          }
        }

        // 防死循环：相同 tool + 相同参数已失败超过重试次数 → 禁止再次调用
        if (isBlocked(scratchpad, toolName, input, MAX_RETRY)) {
          const blockMsg = `工具 ${toolName} 参数 "${input}" 已产生无效结果或失败超过重试次数，禁止再次调用相同参数。请修正参数、换其他方法或向用户说明原因。`;
          observer.log(`[Blocked] ${blockMsg}`);

          // State: 记录被禁状态（不推进步骤）
          updateState(state, {
            currentStep: "tool_blocked",
            currentError: "重复无效/失败被禁止调用",
            lastToolError: {
              tool: toolName,
              input,
              error: "重复无效/失败被禁止调用",
              retries: MAX_RETRY + 1,
            },
          });
          observeState("summary");

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
        observeState("summary");

        observer.log(`[Tool 调用] ${toolName}(${call.function.arguments})`);

        // Scratchpad: 记录计划执行的下一步（未完成，不进 completedSteps）
        setNextStep(scratchpad, { tool: toolName, input });

        // Trace: 工具调用前
        emit({ type: "tool_call", tool: toolName, args });

        // 工具执行 + 重试（最多 MAX_RETRY 次）；重试耗尽进入失败恢复
        // v1.3.1 修复：non_idempotent（高风险副作用）禁止自动 Retry ——
        // execute 一旦开始执行，throw 时无法判定副作用是否已发生；盲目重跑会导致同一副作用重复执行。
        // 首次失败直接进入 Recovery，由 LLM 决策。read / idempotent 保持原重试行为。
        // v1.3.2：non_idempotent 开始执行前先持久化 executing 状态；
        //   persist(executing) 失败 → 禁止 execute，作为 Runtime 错误处理（防止无保护的副作用执行）。
        if (toolDef?.effect === "non_idempotent") {
          const opKey = operationIdentity(toolDef, args, toolContext);
          sideEffectGuard.begin(opKey);
          try {
            save();
          } catch (persistErr) {
            const persistMsg = `[Side-Effect Persist Failed] 无法持久化 operation executing 状态（${opKey}），禁止执行 non_idempotent 工具: ${(persistErr as Error).message}`;
            observer.log(persistMsg);
            throw new Error(persistMsg);
          }
        }
        const effectiveRetries = toolDef?.effect === "non_idempotent" ? 0 : MAX_RETRY;
        for (let attempt = 1; attempt <= effectiveRetries + 1; attempt++) {
          try {
            const start = performance.now();
            // ToolContext 由 Runtime 注入：runId/workspaceRoot 均不可见、不可通过 args 覆盖
            const rawResult = await execute(toolName, args, {
              ...toolContext,
              signal: opts.signal,
              onSandboxEvent: (event: ToolSandboxEvent) => {
                if (event.type === "shell_sandbox_started") {
                  emit({
                    type: "shell_sandbox_started",
                    platform: event.platform,
                  });
                } else {
                  emit({
                    type: "shell_sandbox_denied",
                    platform: event.platform,
                    reason: event.reason,
                  });
                }
              },
            });
            const durationMs = Math.round((performance.now() - start) * 100) / 100;

            // ---- v1.2 Tool Result Validation：执行成功 ≠ 结果有效（validateResult 必须看到完整 raw）----
            const vr = validateToolResult(toolName, rawResult);

            // ---- v1.3.3 Tool Output Guard：validation 之后，任何进入 Runtime 状态 / LLM Context 的内容一律受限 ----
            const guarded = guardToolOutput(rawResult);
            if (guarded.truncated) {
              emit({
                type: "tool_output_truncated",
                tool: toolName,
                originalBytes: guarded.originalBytes,
                returnedBytes: guarded.returnedBytes,
              });
            }
            const result = guarded.content; // 后续所有使用处（trace/scratchpad/messages/recovery）均为受限结果
            observer.log(`[Tool 返回] ${result}`);

            // v1.3 Side-Effect Safety：非幂等 execute 成功后记录操作身份（记录受限结果，防回放大内容）
            if (toolDef) markExecuted(sideEffectGuard, toolDef, args, result, toolContext);

            // State: 工具执行成功（execute 维度，先于结果有效性判定）
            updateState(state, {
              successfulToolCalls: state.successfulToolCalls + 1,
              currentStep: "tool_result",
              pendingAction: undefined,
              currentError: undefined,
            });
            observeState("summary");

            if (!vr.valid) {
              // 结果无效：不进 completedSteps、不计入失败，单独计入 invalidToolResults
              updateState(state, {
                invalidToolResults: state.invalidToolResults + 1,
                currentStep: "tool_result_invalid",
                currentError: `结果无效: ${vr.reason ?? ""}`,
              });
              observeState("summary");

              // Trace: 结果无效事件（区别于 tool_result / tool_error）
              emit({
                type: "tool_result_invalid",
                tool: toolName,
                result,
                reason: vr.reason ?? "结果无效",
              });

              // Scratchpad: 记录无效结果（不进 completedSteps）
              recordInvalid(scratchpad, {
                tool: toolName,
                input,
                result,
                reason: vr.reason ?? "结果无效",
              });
              observeScratchpad();

              // 将"执行成功但结果无效"作为恢复消息回传 LLM，由其业务决策
              const recoveryMsg =
                `工具 ${toolName} 执行成功，但返回结果不可用于后续任务。\n` +
                `工具：${toolName}\n` +
                `结果：${typeof result === "string" ? result : JSON.stringify(result)}\n` +
                `原因：${vr.reason ?? "结果无效"}\n` +
                `请根据当前任务决定：1) 是否重新调用工具（如更换参数）；2) 是否换其他方法；` +
                `3) 是否停止依赖该结果的后续步骤；4) 是否向用户说明无法继续。`;
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: recoveryMsg,
              });
              // Checkpoint: 结果无效时保存
              save();
              break; // 工具本身未抛错，无需重试
            }

            // Trace: 工具结果（含耗时，仅结果有效时记录 tool_result）
            emit({
              type: "tool_result",
              tool: toolName,
              result,
              durationMs,
            });

            // Scratchpad: 工具成功 → 当前步骤移入 completedSteps，清空 nextStep，并解禁该参数
            completeStep(scratchpad, result);
            clearFailure(scratchpad, toolName, input);
            observeScratchpad();
            emit({
              type: "scratchpad_update",
              currentStep: scratchpad.nextStep
                ? `${scratchpad.nextStep.tool}(${scratchpad.nextStep.input})`
                : "(等待 LLM 决策)",
              completedSteps: scratchpad.completedSteps.length,
              lastResult: scratchpad.lastResult,
            });

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
            observer.log(`[Tool 错误] ${toolName}: ${msg}`);

            // v1.3.2：non_idempotent execute throw → 操作转为 uncertain（副作用可能已发生），
            // 之后的相同 canonical key 请求将被阻断（resolveOperation 命中 uncertain），不再重复执行。
            if (toolDef?.effect === "non_idempotent") {
              sideEffectGuard.markUncertain(operationIdentity(toolDef, args, toolContext));
            }

            // True cancellation（v1.6）：abort 是终态 —— 不重试、不写恢复消息、
            // 不记 failedSteps（uncertain 才是中止时唯一的真实语义）。
            // checkpoint 保留现场后向上抛出，由 Host 落 stopped。
            if (isAbortError(err)) {
              save();
              throw err;
            }

            // Scratchpad: 记录失败（不推进 completedSteps，不推进 nextStep）
            recordFailure(scratchpad, { tool: toolName, input, error: msg });

            // Trace: 工具错误事件
            emit({
              type: "tool_error",
              tool: toolName,
              error: msg,
              attempt,
              exhausted: attempt > effectiveRetries,
            });

            // State: 错误状态（当前错误 + 失败历史 lastToolError，不推进步骤）
            updateState(state, {
              currentStep: "tool_error",
              currentError: msg,
              lastToolError: { tool: toolName, input, error: msg, retries: attempt },
            });
            observeState("summary");
            // Checkpoint: 工具失败后保存
            save();

            if (attempt > effectiveRetries) {
              // 重试耗尽 → 失败恢复：将错误作为消息返回 LLM，由其决策
              observer.log(
                `[恢复] 工具 ${toolName} 重试 ${effectiveRetries} 次仍失败，将错误返回 LLM 由其决策`
              );
              // State: 工具失败（仅当所有重试均失败）
              updateState(state, {
                failedToolCalls: state.failedToolCalls + 1,
              });
              emit({
                type: "recovery_decision",
                tool: toolName,
                decision: `工具 ${toolName} 重试 ${effectiveRetries} 次仍失败，已将错误返回 LLM，由其决定：修正参数重新调用 / 换其他方法 / 直接向用户说明失败原因`,
              });
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: `工具 ${toolName} 参数 "${input}" 执行失败（重试 ${effectiveRetries} 次）：${msg}。禁止再次使用相同参数调用，请修正参数或换其他方法。`,
              });
              break; // 跳出重试，外层循环继续 → LLM 重新决策
            }
            observer.log(
              `[重试 ${attempt}/${effectiveRetries}] 工具 ${toolName} 失败，正在重试...`
            );
          }
        }
      }
      // 5. 循环 → LLM 继续判断
    }
  } catch (err) {
    // State: 失败
    updateState(state, { status: "failed", currentStep: "error" });
    observeState("summary");
    // Checkpoint: 失败时保存（含错误状态，可 resume）
    save("failed");
    observeState("full");
    // Trace: 错误
    emit({ type: "error", message: (err as Error).message });
    observeTrace();
    throw err;
  }

  // 超出最大迭代次数
  updateState(state, { status: "failed", currentStep: "error" });
  observeState("summary");
  // Checkpoint: 超限时保存
  save("failed");
  observeState("full");
  emit({ type: "error", message: "超过最大循环次数限制" });
  observeTrace();
  throw new Error("超过最大循环次数限制");
}
