// 模块 3: Agent Loop — 控制 LLM 与 Tool 交互（Runtime 内核，不含 CLI 入口）

import type { AgentContextHarness } from '../harness/context-harness.js';
import type { ContextHarnessState } from '../harness/context-state.js';
import {
  type ChatMessage,
  type ChatStreamDelta,
  chat,
  type MessageImage,
  type ModelConfig,
} from '../llm/llm.js';
import { promptSideTokens, type TokenUsage } from '../llm/token-usage.js';
import { storedPermissionMode } from '../permission-mode.js';
import { drainJobCompletionNotifications } from '../sandbox/background-jobs.js';
import type { ToolchainPreparationPort } from '../sandbox/toolchain-preparation.js';
import { getSchemas } from '../tools/tools.js';
import { throwIfAborted } from '../util/abort.js';
import { createAgentContext } from './agent-context.js';
import type { ApprovalPort } from './approval-port.js';
import type { CheckpointSnapshot, CheckpointWriter } from './checkpoint-port.js';
import type { AgentExecutionContext } from './contracts.js';
import { materializeMessagesForModel } from './image-materialize.js';
import type { RuntimeObserver } from './observer-port.js';
import { updateState } from './state.js';
import { invokeToolCall } from './tool-invocation/process-manager.js';
import type { TraceEvent } from './trace.js';
import { decideEmptyTurn, decideIncompleteTurn } from './turn-policy.js';

// Harness may request a graceful stop after the current tool turn. This is
// intentionally distinct from an execution error: Host turns it into the
// normal stopped terminal state and can preserve the checkpoint for resume.
export class AgentStopRequestedError extends Error {
  constructor(message = 'Agent turn stopped by Harness policy') {
    super(message);
    this.name = 'AgentStopRequestedError';
  }
}

// v1.8 空回合不变量：模型既没有工具调用也没有可见内容时，Runtime 绝不把它当成
// 最终答案（那会让 Run 以空结果"成功"结束，用户什么都看不到）。先按 Harness
// 策略有界恢复，恢复次数用尽后抛此错误 → Run 落 failed 并给出明确原因。
export class AgentEmptyAnswerError extends Error {
  constructor(recoveries: number) {
    super(
      `Model produced no visible content and no tool call after ${recoveries} recovery attempt(s); ` +
        'the run cannot be completed with an empty answer.',
    );
    this.name = 'AgentEmptyAnswerError';
  }
}

/**
 * The model emitted a non-empty plan-like response, did not call a tool, and
 * remained incomplete after the bounded finalization recovery. This is a
 * failed/stalled run, never a successful completion.
 */
export class AgentStalledError extends Error {
  constructor(reason: string, recoveries: number) {
    super(
      `Model stopped before completing the task: ${reason} ` +
        `(${recoveries} finalization recovery attempt(s) used).`,
    );
    this.name = 'AgentStalledError';
  }
}

// Agent 核心循环：模型持续产生工具调用时继续执行；停止由模型收尾、取消、
// 工具/请求错误或 Harness 策略决定，不以固定迭代次数截断。
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
    // 本轮用户消息附带的图片（工作区相对路径引用；Host 已落盘到
    // input/attachments/）。随首条 user 消息进入 transcript，调用模型前物化。
    attachments?: MessageImage[];
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
    // 会话级上下文延续（非 resume）：新 Run 复用上一轮 checkpoint 的完整
    // transcript + harness 摘要状态（conversationSummary / summarizedMessageCount），
    // 使模型视图跨轮累计而不是每轮重置。
    previousHarnessState?: ContextHarnessState;
    // v2.0.1 JIT Approval：网络访问即时授权端口。ask 模式下网络工具执行前
    // 调用 request()；未注入 → fail-closed（denyAll，一律拒绝）。
    approvalPort?: ApprovalPort;
    // macOS toolchain preparation：缺失的 allowlisted tool 只能在用户明确
    // 批准后由 Host 执行固定安装计划；不注入则保持普通可恢复失败。
    toolchainPreparationPort?: ToolchainPreparationPort;
  },
): Promise<string> {
  const { executionContext } = opts;
  const runId = resume ? resume.state.runId : executionContext.runId;
  if (executionContext.runId !== runId) {
    throw new Error('Execution context runId does not match Runtime state');
  }
  const workspaceRoot = executionContext.workspaceRoot;
  const permissionMode = executionContext.permissionMode;
  const toolchain = executionContext.toolchain;
  if (resume?.workspaceRoot && resume.workspaceRoot !== workspaceRoot) {
    throw new Error('Execution context Workspace does not match checkpoint');
  }
  if (resume?.permissionMode && storedPermissionMode(resume.permissionMode) !== permissionMode) {
    throw new Error('Execution context permission does not match checkpoint');
  }
  // 视觉能力随模型配置固化：read 等读图工具据此决定返回图片块还是文本占位。
  const visionEnabled = opts.modelConfig?.vision === true;

  // 装配：State / Harness / Scratchpad / Trace / Checkpoint / 观测闭包
  // 全部由 createAgentContext 完成（唯一 owner），主循环只消费解构出的符号。
  const {
    toolContext,
    state,
    scratchpad,
    sideEffectGuard,
    messages,
    contextHarness,
    modelContext,
    observer,
    startIter,
    emit,
    save,
    observeState,
    observeScratchpad,
    observeTrace,
    pushToolCallError,
  } = createAgentContext({
    runId,
    sessionId: executionContext.sessionId,
    task,
    workspaceRoot,
    permissionMode,
    toolchain,
    visionEnabled,
    resume,
    opts,
  });

  // 真实用量锚点（Adapter/投影思想）：记录最近一次 provider 上报的用量，
  // 供下一轮 context_usage 携带 prompt 侧真实压力（pressureTokens）校准估算。
  let lastRequestUsage: TokenUsage | undefined;
  // v1.8 空回合恢复计数（每次 Run 独立；resume 后从 0 重新计数，避免旧 checkpoint
  // 把恢复额度永久耗尽）。
  let emptyTurnRecoveries = 0;
  // Finalization guard 恢复计数（每次 Run 独立；只允许有限次，避免模型以计划文本
  // 无限触发额外请求）。
  let incompleteTurnRecoveries = 0;

  // ---- v2.3 Background Job 完成通知（docs/long-task-timeout-plan.md 步骤 5）----
  // 作业归属 Session；本 Run 在迭代边界抽取会话的完成通知并注入模型视图。
  // 连续唤醒有上限（每轮 Run 独立计数）：通知风暴下模型既不被锁死在通知循环里，
  // 未消费的通知也仍留在会话队列（后续 Run / 显式 list 可继续消费）。
  const jobSessionKey = executionContext.sessionId ?? `run-${runId}`;
  const MAX_JOB_COMPLETION_WAKEUPS = 3;
  let jobCompletionWakeups = 0;
  const injectJobNotifications = (): boolean => {
    if (jobCompletionWakeups >= MAX_JOB_COMPLETION_WAKEUPS) {
      // 上限已到：不 drain——通知留在会话队列，不丢。
      return false;
    }
    const completed = drainJobCompletionNotifications(jobSessionKey);
    if (completed.length === 0) return false;
    const names = completed.map((n) => `${n.jobId} (${n.status})`).join('、');
    const notice =
      `[后台任务通知] 以下后台任务已完成：${names}。` +
      `如当前任务仍在等待它们的结果，请用 shellJob {action:"output", jobId:"<作业id>"} 读取输出后继续；` +
      `如已不再需要，请忽略本条通知。`;
    messages.push({ role: 'user', content: notice });
    emit({
      type: 'background_job_notified',
      jobs: completed.map((n) => ({ jobId: n.jobId, status: n.status })),
    });
    observer.log(
      `[后台任务通知] ${names} → 已注入模型视图（连续唤醒 ${jobCompletionWakeups + 1}/${MAX_JOB_COMPLETION_WAKEUPS}）`,
    );
    save();
    jobCompletionWakeups++;
    return true;
  };

  try {
    // No fixed iteration cap: a turn continues while the model keeps
    // producing tool calls. Cancellation, tool safety, and the optional
    // Harness stop policy are the termination mechanisms.
    for (let i = startIter; ; i++) {
      // True cancellation（v1.6）：迭代边界检查 —— 上一轮工具完成后、发起新一轮
      // LLM 请求前生效。中途取消由 signal 传播进 chat()/tool 执行负责。
      throwIfAborted(opts.signal);
      // v2.3 后台任务完成通知：迭代边界注入（本轮 LLM 调用即看到）。
      // 注意：计数只在"模型做出真实进展（执行工具调用）"时重置——绝不能在这里
      // 因为顶部抽空就清零，否则上一轮收尾注入的计数会被立即抹掉，上限形同虚设。
      injectJobNotifications();
      observer.log(`\n--- 迭代 ${i + 1} ---`);

      // State: 进入循环，更新迭代次数
      updateState(state, { iteration: i + 1, currentStep: 'llm_call' });
      observeState('summary');

      // 0. Harness 投影本轮模型视图。完整 transcript 不被裁剪或改写；
      // system / permission / Scratchpad 和历史预算全部由 Harness 决定。
      const schemas = getSchemas();
      const ctx = await contextHarness.prepareTurn(messages, scratchpad, schemas, opts.signal);
      emit({
        type: 'context_trim',
        beforeMessages: ctx.usage.beforeMessages,
        afterMessages: ctx.usage.afterMessages,
      });
      emit({
        type: 'context_usage',
        model: modelContext.model,
        modelSource: modelContext.modelSource,
        configSource: modelContext.source,
        emergencyTrim: ctx.usage.emergencyTrim,
        contextWindowTokens: modelContext.contextWindowTokens,
        maxOutputTokens: modelContext.maxOutputTokens,
        safetyTokens: modelContext.safetyTokens,
        inputBudgetTokens: ctx.usage.inputBudgetTokens,
        messageTokens: ctx.usage.messageTokens,
        systemTokens: ctx.usage.systemTokens,
        toolSchemaTokens: ctx.usage.toolSchemaTokens,
        scratchpadTokens: ctx.scratchpadTokens,
        planTokens: ctx.planTokens,
        estimatedInputTokens: ctx.usage.estimatedInputTokens,
        ...(lastRequestUsage === undefined
          ? {}
          : { pressureTokens: promptSideTokens(lastRequestUsage) }),
        usageRatio: ctx.usage.usageRatio,
        trimmedMessages: ctx.usage.trimmedMessages,
        overBudget: ctx.usage.overBudget,
      });
      if (ctx.compaction) {
        emit({
          type: 'context_compaction',
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
            `budget ${ctx.usage.inputBudgetTokens}`,
        );
      }

      // 1. 调用 LLM 判断下一步
      // 1. 调用 LLM 判断下一步（signal 直达 HTTP/流式层：abort 立即中断在途请求）
      // 图片在调用边界物化：Harness 视图里的图片是路径引用，这里读取为 base64
      // 副本（不污染 transcript / checkpoint）；非视觉模型则剥离图片并文本注明。
      const modelMessages = materializeMessagesForModel(ctx.messages, workspaceRoot, visionEnabled);
      // Trace: LLM 调用开始 —— llm_call 只在调用结束后落盘，大上下文 prefill 的
      // 首 token 等待期（可达数十秒）必须有自己的事件，否则前端在该窗口完全静默。
      emit({
        type: 'llm_call_started',
        iteration: i + 1,
        messageCount: messages.length,
        estimatedInputTokens: ctx.usage.estimatedInputTokens,
      });
      const assistantMsg = await chat(
        modelMessages,
        schemas,
        opts.onStreamDelta,
        opts.modelConfig,
        opts.signal,
        // Provider HTTP 请求真正发出的打点：把 llm_call_started → 首个 delta
        // 拆成「Host 侧整理」与「Provider 首包/网络」两段。
        (attempt) => {
          emit({
            type: 'llm_request_sent',
            iteration: i + 1,
            attempt,
          });
        },
      );
      // Provider reasoning_content and inline <think> blocks are trace/display
      // concerns only; neither is persisted into the next LLM context.
      const { reasoning_content } = assistantMsg;
      const { usage: requestUsage, ...messageForHistory } = assistantMsg;
      const assistantHistoryMessage = contextHarness.sanitizeAssistantMessage(messageForHistory);
      messages.push(assistantHistoryMessage);
      // 记录本次真实用量，供下一轮 context_usage 的 pressureTokens 锚点使用。
      if (requestUsage !== undefined) lastRequestUsage = requestUsage;

      // Trace: LLM 调用（输入消息数 / 迭代次数 / 返回内容 / 是否产生 tool_call）
      emit({
        type: 'llm_call',
        messageCount: messages.length,
        iteration: i + 1,
        response: assistantMsg.content,
        reasoning: reasoning_content,
        usage: requestUsage,
        hasToolCalls: !!assistantMsg.tool_calls?.length,
      });

      // 2. LLM 决策日志：是否选择工具
      if (!assistantMsg.tool_calls?.length) {
        // v2.3 完成通知竞态：模型"询一句、准备收尾"的 LLM 调用进行期间作业完成——
        // 先注入通知并继续（"读取结果后再回答"），而不是让 Run 以旧结论直接结束。
        if (injectJobNotifications()) {
          continue;
        }
        observer.log('[LLM 决策] 未选择工具 → 检查是否为最终答案');
        const answer = contextHarness.sanitizeFinalAnswer(assistantMsg.content);

        // v1.8 空回合不变量：没有工具调用且没有可见内容 → 不是答案。
        // 按 Harness 策略追加提示并重试（有界）；用尽后 fail loudly。
        // 预算判定归 TurnPolicy（纯函数）；副作用留在主循环。
        if (answer.trim() === '') {
          const decision = decideEmptyTurn(contextHarness.emptyTurnPolicy?.(), emptyTurnRecoveries);
          if (decision.kind === 'recover') {
            emptyTurnRecoveries = decision.attempt;
            observer.log(
              `[空回合] 模型未产生可见输出，按 Harness 策略追加提示（${decision.attempt}/${decision.maxAttempts}）`,
            );
            emit({
              type: 'empty_turn_recovered',
              attempt: decision.attempt,
              maxAttempts: decision.maxAttempts,
            });
            updateState(state, {
              currentStep: 'empty_turn_recovery',
              currentError: 'empty assistant turn',
            });
            observeState('summary');
            messages.push({ role: 'user', content: decision.nudge });
            save();
            continue;
          }
          throw new AgentEmptyAnswerError(emptyTurnRecoveries);
        }

        const incompleteDecision = decideIncompleteTurn(
          contextHarness.incompleteTurnPolicy?.(answer),
          incompleteTurnRecoveries,
        );
        if (incompleteDecision.kind === 'recover' || incompleteDecision.kind === 'fail') {
          const attempt = incompleteDecision.attempt;
          emit({
            type: 'finalization_guard',
            reason: incompleteDecision.reason ?? '',
            attempt,
            maxAttempts: incompleteDecision.maxAttempts,
            disposition: incompleteDecision.kind === 'recover' ? 'retry' : 'fail',
          });
          if (incompleteDecision.kind === 'recover') {
            incompleteTurnRecoveries = attempt;
            observer.log(
              `[Finalization Guard] 检测到未完成回合，追加提示并重试（${attempt}/${incompleteDecision.maxAttempts}）`,
            );
            updateState(state, {
              currentStep: 'finalization_guard',
              currentError: incompleteDecision.reason ?? '',
            });
            observeState('summary');
            messages.push({
              role: 'user',
              content: incompleteDecision.nudge,
            });
            save();
            continue;
          }
          throw new AgentStalledError(
            incompleteDecision.reason ?? 'incomplete turn',
            incompleteTurnRecoveries,
          );
        }

        // Trace: 计划收尾审计 —— 仍留有未完成项时留痕（不阻断收尾；Harness 只报告）。
        const planReport = contextHarness.planReport?.();
        if (planReport && planReport.unfinished.length > 0) {
          emit({
            type: 'plan_incomplete_at_finish',
            revision: planReport.revision,
            completed: planReport.completed,
            total: planReport.total,
            unfinished: planReport.unfinished.map((item) => ({
              id: item.id,
              title: item.title,
              status: item.status === 'in_progress' ? 'in_progress' : 'pending',
            })),
          });
        }

        // Trace: 最终答案 + 总执行步骤数
        emit({
          type: 'final_answer',
          content: answer,
          totalSteps: i + 1,
        });

        // State: 完成（清空当前错误与待执行动作；历史错误保留在 lastToolError / failedSteps / Trace）
        updateState(state, {
          status: 'completed',
          currentStep: 'final_answer',
          currentError: undefined,
          pendingAction: undefined,
        });
        observeState('summary');
        // Checkpoint: 完成时保存
        save('completed');
        observeState('full');
        observeScratchpad();
        observeTrace();
        return answer;
      }

      const toolNames = assistantMsg.tool_calls.map((c) => c.function.name).join(', ');
      observer.log(`[LLM 决策] 选择工具: ${toolNames}`);

      // 3. 执行工具（含重试 + 失败恢复 + 防死循环）
      for (const call of assistantMsg.tool_calls) {
        // True cancellation：工具间检查 —— 前一个工具返回后用户 Stop，
        // 不再执行本条消息里剩余的 tool_calls，也不发下一轮 LLM。
        throwIfAborted(opts.signal);
        // 一次工具调用的完整生命周期（parse → 审批 → 执行 → 校验 → 重试 →
        // 恢复）由 ToolInvocationProcessManager 负责；返回即该 call 处理完毕。
        await invokeToolCall(
          {
            runId,
            toolContext,
            messages,
            state,
            scratchpad,
            sideEffectGuard,
            contextHarness,
            signal: opts.signal,
            approvalPort: opts.approvalPort,
            toolchainPreparationPort: opts.toolchainPreparationPort,
            // v2.4 前台 shell 流式输出：把工具执行期的 stdout/stderr 增量接进同一条
            // 流式通道（不落 trace）。messageId 取本次工具调用 id，前端据此归行。
            onToolOutput: opts.onStreamDelta
              ? (chunk: string) =>
                  opts.onStreamDelta?.({ messageId: call.id, type: 'shell_output_delta', delta: chunk })
              : undefined,
            emit,
            save,
            observer,
            observeState,
            observeScratchpad,
            pushToolCallError,
          },
          call,
        );
      }

      // v2.3 连续唤醒计数重置：本迭代确实执行了工具（模型在做真实工作），
      // 之后的完成通知重新允许唤醒（不再视作"连续空转被通知锁死"的状态）。
      jobCompletionWakeups = 0;

      // Harness owns context policy. It may stop cleanly after a completed
      // tool turn (for example before the next turn would exceed its budget).
      // The hook is optional and does not alter the Runtime's tool semantics.
      if (
        contextHarness.shouldStopAfterTurn &&
        (await contextHarness.shouldStopAfterTurn({ iteration: i + 1, usage: ctx.usage }))
      ) {
        throw new AgentStopRequestedError();
      }
      // 5. 循环 → LLM 继续判断
    }
  } catch (err) {
    if (err instanceof AgentStopRequestedError) {
      // Graceful policy stop: preserve the running checkpoint without
      // emitting an error event. Host finalizes the Run as stopped.
      save();
      throw err;
    }
    // State: 失败
    const stalled = err instanceof AgentStalledError;
    updateState(state, {
      status: 'failed',
      currentStep: stalled ? 'stalled' : 'error',
      ...(stalled ? { currentError: (err as Error).message } : {}),
    });
    observeState('summary');
    // Checkpoint: 失败时保存（含错误状态，可 resume）
    save('failed');
    observeState('full');
    // Trace: 错误
    emit({ type: 'error', message: (err as Error).message });
    observeTrace();
    throw err;
  }
}
