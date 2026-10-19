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
import { materializeMessagesForModel, resolveInlineImageBudget } from './image-materialize.js';
import type { RuntimeObserver } from './observer-port.js';
import { updateState } from './state.js';
import { invokeToolCall } from './tool-invocation/process-manager.js';
import type { TraceEvent } from './trace.js';
import { decideEmptyTurn, decideIncompleteTurn } from './turn-policy.js';

/** 耗尽后注入的收尾指令（一次性；携带确定的事实，不代模型下结论）。 */
const BUDGET_WRAP_UP_INSTRUCTION =
  '[Execution budget exhausted] The configured execution budget for this run is spent. ' +
  'Do not start any new investigation or tool work. Deliver the final answer now, based only on ' +
  'what is already established: state plainly which parts of the original goal are done, which are ' +
  'not, and why. If nothing was accomplished, say so explicitly.';
/** 工具被预算准入拦下时回传给模型的说明（工具未执行，无副作用）。 */
const BUDGET_TOOL_BLOCKED_MESSAGE =
  'EXECUTION_BUDGET_EXHAUSTED: this tool call was not executed (execution budget spent, no new tool work). ' +
  'Deliver the final answer now based on established results; state what is done and what is not.';

/** 预算看门狗轮询间隔：请求进行中每 250ms 做一次投影判定（廉价，且测试可控）。 */
const BUDGET_WATCHDOG_INTERVAL_MS = 250;

/**
 * 派生模型调用信号：把「用户取消」与「预算硬截止」合并成一个 AbortSignal。
 *
 * 为什么需要派生：v2.6 阶段二的持续长输出约束要求**请求进行中**就能中止——
 * 累计活动时长越过 maxActiveMs 时不能等响应结束（那时模型可能已经又吐了几千
 * token）。chat() 只接受一个 signal，因此这里把两个中止源汇到一个派生控制器：
 *   - 用户取消：原样传播（语义不变，Host 仍按 stopped/用户主动处理）；
 *   - 预算截止：onHardStop 先打标记（Runtime 据此与用户取消区分），再 abort。
 * 没有 hardStop 时零开销，直接透传用户信号。
 */
function deriveModelCallSignal(
  userSignal: AbortSignal | undefined,
  hardStop: (() => boolean) | undefined,
  onHardStop: () => void,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (!hardStop) return { signal: userSignal, dispose: () => {} };
  const controller = new AbortController();
  let settled = false;
  const stop = (reason?: unknown): void => {
    if (settled) return;
    settled = true;
    controller.abort(reason);
  };
  const timer = setInterval(() => {
    if (hardStop()) {
      onHardStop();
      stop(new Error('execution budget exhausted during model request'));
    }
  }, BUDGET_WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  const onUserAbort = (): void => stop(userSignal?.reason);
  if (userSignal) {
    if (userSignal.aborted) stop(userSignal.reason);
    else userSignal.addEventListener('abort', onUserAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearInterval(timer);
      userSignal?.removeEventListener('abort', onUserAbort);
    },
  };
}

// Harness may request a graceful stop after the current tool turn. This is
// intentionally distinct from an execution error: Host turns it into the
// normal stopped terminal state and can preserve the checkpoint for resume.

/**
 * 稳定停止原因码（Host 持久化与界面展示的唯一身份，禁止用自然语言充当）。
 * - budget_exhausted：执行预算耗尽，新工作已停止（交付结果必为 partial）；
 * - policy_denied：策略/审批拒绝导致无法继续；
 * - tool_unavailable：依赖工具不可用且未获准备；
 * - outcome_uncertain：副作用结果不确定，无法安全继续；
 * - user_cancelled：用户主动停止（Runtime 侧 abort 路径，Host 亦可自行判定）。
 */
export type AgentStopReasonCode =
  | 'budget_exhausted'
  | 'policy_denied'
  | 'tool_unavailable'
  | 'outcome_uncertain'
  | 'user_cancelled';

export interface AgentStopReason {
  code: AgentStopReasonCode;
  /** 面向用户的确定停止说明（Host 落库为 Run 结果，不替代模型答复）。 */
  notice?: string;
}

export class AgentStopRequestedError extends Error {
  constructor(
    readonly stop?: AgentStopReason,
    message = 'Agent turn stopped by Harness policy',
  ) {
    super(message);
    this.name = 'AgentStopRequestedError';
  }
}

/** 近期工具结果的有界摘要（周期性目标审查用；只取最后一条 tool 消息）。 */
function lastToolResultDigest(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'tool') continue;
    const text =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return undefined;
    return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
  }
  return undefined;
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
  // v2.4 计划收尾提醒：每次 Run 只提醒一次（不循环）；提醒后无论模型是否收尾都继续收尾。
  let planFinalizeReminded = false;

  // ---- v2.3 Background Job 完成通知（docs/plans/long-task-timeout-plan.md 步骤 5）----
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

  // v2.6 执行预算（Harness 持有）：活动时长用单调标记做增量累计，避免
  // 「每迭代重算 start→now」漏掉工具执行时间。恢复场景由 Harness 从
  // checkpoint 累计值继续，新 Run 从零开始。
  // 模型调用数按**真实 Provider 请求**计（onRequestSent 每次 HTTP 尝试 +1，
  // 含 chat() 内部重试）——按成功响应计会漏算重试，违背「含每次重试」的口径。
  // 声明在 try 之外：失败/取消路径的 catch 也要能入账（失败不漏账）。
  let budgetMarkAt = performance.now();
  let budgetModelCalls = 0;
  // v2.6 阶段二强制收尾：耗尽后注入一次收尾指令，只保留预留的收尾生成；
  // 模型若连续两轮仍发起工具调用（忽略收尾指令），Runtime 优雅停止。
  let wrapUpInjected = false;
  let wrapUpStartedAt: number | undefined;
  let wrapUpIgnoredTurns = 0;
  const MAX_WRAP_UP_IGNORED_TURNS = 2;
  // v2.6：本次模型请求是否被预算硬截止中止（与用户取消、执行失败三方区分）。
  let budgetAborted = false;
  try {
    // No fixed iteration cap: a turn continues while the model keeps
    // producing tool calls. Cancellation, tool safety, and the optional
    // Harness stop policy are the termination mechanisms.
    for (let i = startIter; ; i++) {
      // True cancellation（v1.6）：迭代边界检查 —— 上一轮工具完成后、发起新一轮
      // LLM 请求前生效。中途取消由 signal 传播进 chat()/tool 执行负责。
      throwIfAborted(opts.signal);
      // v2.6 预算准入（阶段二）：耗尽即停止新工作。注入一次收尾指令后仍允许
      // 本轮生成（预留的小额收尾预算）；模型持续输出由独立累计时限
      // （maxActiveMs）在准入边界约束，单请求内的停滞由 idle 看门狗负责。
      if ((contextHarness.executionBudgetLevel?.() ?? 'none') === 'exhausted') {
        if (!wrapUpInjected) {
          wrapUpInjected = true;
          wrapUpStartedAt = performance.now();
          messages.push({ role: 'user', content: BUDGET_WRAP_UP_INSTRUCTION });
          save();
          observer.log('[预算] 执行预算耗尽，注入收尾指令，停止新工具工作');
        }
      }
      const turnStartedAt = performance.now();
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
      // v2.6：压缩摘要发生在 prepareTurn 内部（Harness 自持的模型调用）——
      // 全部模型请求统一计量，这里的跨阈决策与主循环的 observeExecution 同路：
      // 发事件、随本轮 checkpoint 落盘。
      for (const decision of ctx.budgetDecisions ?? []) {
        const decisionLevel = decision.level;
        if (decision.buckets.length > 0 && decisionLevel !== 'none') {
          emit({
            type: 'budget_decision',
            level: decisionLevel,
            buckets: decision.buckets,
            modelCalls: decision.state.usage.modelCalls,
            outputTokens: decision.state.usage.outputTokens,
            activeMs: decision.state.usage.activeMs,
          });
          save();
        }
      }
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
          sourceTokens: ctx.compaction.sourceTokens,
          cacheAligned: ctx.compaction.cacheAligned,
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
      const modelMessages = materializeMessagesForModel(
        ctx.messages,
        workspaceRoot,
        visionEnabled,
        resolveInlineImageBudget(),
      );
      // Trace: LLM 调用开始 —— llm_call 只在调用结束后落盘，大上下文 prefill 的
      // 首 token 等待期（可达数十秒）必须有自己的事件，否则前端在该窗口完全静默。
      emit({
        type: 'llm_call_started',
        iteration: i + 1,
        messageCount: messages.length,
        estimatedInputTokens: ctx.usage.estimatedInputTokens,
      });
      // 请求体规模的可观测代理 ≈ HTTP body 字节数（messages + tools 序列化；
      // 鉴权头与少量请求参数不计，恒小于真实 body）。补这个字段之前，
      // 「请求体 ≤1.5MB / 图片不再全量 base64」这条验收项没有任何观测点。
      const requestBodyBytes = JSON.stringify([modelMessages, schemas]).length;
      // v2.6 阶段二：请求进行中的预算硬截止 + 收尾独立额度。
      // hardStop 两种形态：常规请求 = 累计活动时长投影（usage.activeMs + 本次已
      // 进行时间 ≥ maxActiveMs 即中止在途请求——持续长输出不能等响应结束才记账）；
      // 收尾请求 = 独立的 wrapUp 时限（wrapUpStartedAt 起算，总预算已耗尽，
      // 收尾另有小额，两者不互相侵蚀）。
      const wrapUpActive = wrapUpInjected;
      const hardStop = contextHarness.executionBudgetProjection
        ? () => {
            if (wrapUpActive) {
              const wrapUpMaxMs = contextHarness.executionBudgetWrapUpLimits?.()?.maxActiveMs;
              return (
                wrapUpMaxMs !== undefined &&
                wrapUpStartedAt !== undefined &&
                performance.now() - wrapUpStartedAt >= wrapUpMaxMs
              );
            }
            return (
              contextHarness.executionBudgetProjection?.(performance.now() - budgetMarkAt) ?? false
            );
          }
        : undefined;
      budgetAborted = false;
      const derived = deriveModelCallSignal(opts.signal, hardStop, () => {
        budgetAborted = true;
      });
      // 收尾请求使用裁剪后的输出上限：独立小额额度，不用普通请求的完整上限。
      const wrapUpLimits = wrapUpActive
        ? contextHarness.executionBudgetWrapUpLimits?.()
        : undefined;
      const effectiveModelConfig =
        wrapUpActive && wrapUpLimits?.maxOutputTokens !== undefined && opts.modelConfig
          ? {
              ...opts.modelConfig,
              maxOutputTokens: Math.min(
                opts.modelConfig.maxOutputTokens ?? wrapUpLimits.maxOutputTokens,
                wrapUpLimits.maxOutputTokens,
              ),
            }
          : opts.modelConfig;
      let assistantMsg: ChatMessage & { usage?: TokenUsage };
      try {
        assistantMsg = await chat(
          modelMessages,
          schemas,
          contextHarness.reviewFinalAnswer ? undefined : opts.onStreamDelta,
          effectiveModelConfig,
          derived.signal,
          // Provider HTTP 请求真正发出的打点：把 llm_call_started → 首个 delta
          // 拆成「Host 侧整理」与「Provider 首包/网络」两段。
          (attempt) => {
            // 每次真实 HTTP 请求（含 chat() 内部重试）都计入模型调用预算。
            budgetModelCalls += 1;
            emit({
              type: 'llm_request_sent',
              iteration: i + 1,
              attempt,
              requestBodyBytes,
            });
          },
        );
      } finally {
        derived.dispose();
      }
      // Provider reasoning_content and inline <think> blocks are trace/display
      // concerns only; neither is persisted into the next LLM context.
      const { reasoning_content } = assistantMsg;
      const { usage: requestUsage, ...messageForHistory } = assistantMsg;
      const assistantHistoryMessage = contextHarness.sanitizeAssistantMessage(messageForHistory);
      messages.push(assistantHistoryMessage);
      // 成功响应后消费提醒；随本轮原有的工具/终态 checkpoint 保存。
      // 若响应尚未持久化即崩溃，恢复时 pending 提醒和该请求一起重新投影。
      // 顺序不可换：acknowledge 消费的是「本轮 prepareTurn 已注入模型视图」的提醒，
      // 必须发生在 observeExecution 入队新提醒**之前**——否则本轮刚跨阈的预算提醒
      // 会在入队后立刻被清空，模型永远收不到（v2.6 接线事故，集成测试锁定）。
      contextHarness.acknowledgeProgressReminder?.();
      contextHarness.acknowledgeConvergenceReminders?.();
      // v2.6 执行预算累计（阶段一观察模式）：累计本轮流式请求发出的全部模型
      // 调用（含内部重试）+ 真实输出 token + 自上一标记以来的活动时长（含本迭代
      // 内的工具执行）。Harness 只分级与排队提醒，不拦截；exhausted 转优雅停止
      // 是阶段二的事。
      if (contextHarness.observeExecution) {
        const now = performance.now();
        const budgetDecision = contextHarness.observeExecution({
          modelCalls: budgetModelCalls,
          // usage 缺失时记 0：宁可少算也不把估算写成真实消耗。
          outputTokens: requestUsage?.outputTokens ?? 0,
          activeMs: now - budgetMarkAt,
        });
        budgetMarkAt = now;
        budgetModelCalls = 0; // 已入账，下一轮重新计数
        // 只在本轮新跨阈值时发事件并落 checkpoint。level 是粘滞档位，跨过 warn 后
        // 会一直保持；若按 level 判断，事件和 checkpoint 会在后续每一轮重复产生。
        // undefined = 该 Harness 未启用预算策略（SDK 注入了旧实现）：跳过，行为不变。
        if (budgetDecision && budgetDecision.buckets.length > 0) {
          // 显式收窄：buckets 非空即已跨过某档，但 TS 无法从数组长度推出 level 的取值。
          const budgetLevel = budgetDecision.level;
          if (budgetLevel !== 'none') {
            emit({
              type: 'budget_decision',
              level: budgetLevel,
              buckets: budgetDecision.buckets,
              modelCalls: budgetDecision.state.usage.modelCalls,
              outputTokens: budgetDecision.state.usage.outputTokens,
              activeMs: budgetDecision.state.usage.activeMs,
            });
            // 预算档位随原有 checkpoint 保存：恢复后累计值与档位延续（不重跑已耗尽的预算）。
            save();
          }
        }
      }
      // 记录本次真实用量，供下一轮 context_usage 的 pressureTokens 锚点使用。
      if (requestUsage !== undefined) lastRequestUsage = requestUsage;

      // Trace: LLM 调用（输入消息数 / 迭代次数 / 返回内容 / 是否产生 tool_call）
      emit({
        type: 'llm_call',
        messageCount: messages.length,
        iteration: i + 1,
        response: assistantMsg.content,
        ...(contextHarness.reviewFinalAnswer &&
        state.toolCalls > 0 &&
        !assistantMsg.tool_calls?.length
          ? { purpose: 'final_draft' as const }
          : {}),
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
        let answer = contextHarness.sanitizeFinalAnswer(assistantMsg.content);

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

        // v2.4 计划收尾提醒（一次性）：模型准备收尾但计划仍有未完成项时，
        // 先提醒它自己把计划收尾（Runtime 不代写计划，只给一次机会）。
        // 放在 finalization guard 之后：后者针对"文本看起来没说完"，这里针对
        // "话已说完，但计划状态没跟着收敛"——这是两个独立的信号。
        if (!planFinalizeReminded) {
          const finalizePolicy = contextHarness.planFinalizePolicy?.();
          if (finalizePolicy) {
            planFinalizeReminded = true;
            observer.log(
              `[计划收尾] 收尾时仍有 ${finalizePolicy.unfinished} 项未完成，追加提醒一次`,
            );
            emit({
              type: 'plan_finalize_reminder',
              unfinished: finalizePolicy.unfinished,
            });
            updateState(state, { currentStep: 'plan_finalize_reminder' });
            observeState('summary');
            messages.push({ role: 'user', content: finalizePolicy.nudge });
            save();
            continue;
          }
        }

        // Runtime 仅执行 Harness 的可选交付策略；检查调用无工具、无副作用重放。
        if (contextHarness.reviewFinalAnswer && state.toolCalls > 0) {
          answer = await contextHarness.reviewFinalAnswer({
            messages: ctx.messages,
            answer,
            call: async (reviewMessages) => {
              throwIfAborted(opts.signal);
              emit({
                type: 'llm_call_started',
                iteration: i + 1,
                messageCount: reviewMessages.length,
              });
              // 最终审查也是模型请求：计入执行预算（含内部重试与真实输出 token），
              // 并与主请求共用同一套预算硬截止 / 收尾额度（审查同样可能长输出）。
              let reviewModelCalls = 0;
              const reviewMarkAt = performance.now();
              budgetAborted = false;
              const reviewDerived = deriveModelCallSignal(opts.signal, hardStop, () => {
                budgetAborted = true;
              });
              let reviewed: ChatMessage & { usage?: TokenUsage };
              try {
                reviewed = await chat(
                  reviewMessages,
                  [],
                  undefined,
                  effectiveModelConfig,
                  reviewDerived.signal,
                  (attempt) => {
                    reviewModelCalls += 1;
                    emit({
                      type: 'llm_request_sent',
                      iteration: i + 1,
                      attempt,
                      requestBodyBytes: JSON.stringify(reviewMessages).length,
                    });
                  },
                );
              } catch (reviewErr) {
                // 交付检查请求失败也入账（尝试次数 + 活动时长）——失败路径不漏账。
                contextHarness.observeExecution?.({
                  modelCalls: reviewModelCalls,
                  outputTokens: 0,
                  activeMs: performance.now() - reviewMarkAt,
                });
                throw reviewErr;
              } finally {
                reviewDerived.dispose();
              }
              const reviewDecision = contextHarness.observeExecution?.({
                modelCalls: reviewModelCalls,
                outputTokens: reviewed.usage?.outputTokens ?? 0,
                activeMs: performance.now() - reviewMarkAt,
              });
              if (reviewDecision && reviewDecision.buckets.length > 0) {
                const reviewLevel = reviewDecision.level;
                if (reviewLevel !== 'none') {
                  emit({
                    type: 'budget_decision',
                    level: reviewLevel,
                    buckets: reviewDecision.buckets,
                    modelCalls: reviewDecision.state.usage.modelCalls,
                    outputTokens: reviewDecision.state.usage.outputTokens,
                    activeMs: reviewDecision.state.usage.activeMs,
                  });
                  save();
                }
              }
              emit({
                type: 'llm_call',
                purpose: 'final_review',
                iteration: i + 1,
                messageCount: reviewMessages.length,
                response: reviewed.content,
                reasoning: reviewed.reasoning_content,
                hasToolCalls: !!reviewed.tool_calls?.length,
                usage: reviewed.usage,
              });
              return reviewed;
            },
          });
          throwIfAborted(opts.signal);
          messages[messages.length - 1] = { role: 'assistant', content: answer };
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
      let readCalls = 0;
      let otherCalls = 0;

      // 3. 执行工具（含重试 + 失败恢复 + 防死循环）
      // v2.6 预算准入（阶段二）：耗尽后不执行任何新工具——模型即使忽略收尾
      // 提醒也无法继续消耗。工具未执行、无副作用，回传确定说明。
      const budgetExhausted = (contextHarness.executionBudgetLevel?.() ?? 'none') === 'exhausted';
      if (budgetExhausted) wrapUpIgnoredTurns += 1;
      for (const call of assistantMsg.tool_calls) {
        // True cancellation：工具间检查 —— 前一个工具返回后用户 Stop，
        // 不再执行本条消息里剩余的 tool_calls，也不发下一轮 LLM。
        throwIfAborted(opts.signal);
        if (budgetExhausted) {
          emit({
            type: 'tool_execution_skipped',
            tool: call.function.name,
            reason: 'budget_exhausted',
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: BUDGET_TOOL_BLOCKED_MESSAGE,
          });
          continue;
        }
        // 一次工具调用的完整生命周期（parse → 审批 → 执行 → 校验 → 重试 →
        // 恢复）由 ToolInvocationProcessManager 负责；返回即该 call 处理完毕。
        const outcome = await invokeToolCall(
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
                  opts.onStreamDelta?.({
                    messageId: call.id,
                    type: 'shell_output_delta',
                    delta: chunk,
                  })
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
        if (!outcome) otherCalls++;
        else if (outcome.tool !== 'updatePlan') {
          // 更新计划是中性动作，不伪装成写入进展。
          if (outcome.effect === 'read') readCalls++;
          else otherCalls++;
        }
      }

      // v2.6 阶段二：耗尽后模型仍连续发起工具调用（收尾指令被无视两轮）——
      // 停止不再产生新工作，由 Host 落 stopped + stopReason=budget_exhausted
      // 并保存现场；最终说明由 Host 给出（模型未正常收尾）。
      if (wrapUpIgnoredTurns >= MAX_WRAP_UP_IGNORED_TURNS) {
        throw new AgentStopRequestedError({
          code: 'budget_exhausted',
          notice:
            '执行预算已耗尽，且模型在收尾指令后仍连续发起工具调用，Runtime 已停止新工作。' +
            '以上为已建立的证据与部分结果；未完成部分因预算耗尽未能继续。',
        });
      }

      if (contextHarness.observeToolTurn) {
        // v2.6 周期性目标审查需要原始目标与近期结果：目标取 Run.task（模型改写
        // 计划不构成目标变更），近期结果取最后一条 tool 消息的有界摘要。
        const observations = contextHarness.observeToolTurn({
          activity: otherCalls > 0 ? 'other' : readCalls > 0 ? 'read' : 'neutral',
          durationMs: performance.now() - turnStartedAt,
          goal: state.task,
          recentResult: lastToolResultDigest(messages),
        });
        if (observations?.progress) {
          emit({ type: 'progress_reminder', iteration: i + 1, ...observations.progress });
        }
        if (observations?.goalReview) {
          emit({
            type: 'goal_review_reminder',
            iteration: i + 1,
            toolTurns: observations.goalReview.toolTurns,
            activeMs: observations.goalReview.activeMs,
          });
        }
        // 工具本身的 checkpoint 在回合统计之前；此处保存回合计数与 pending 状态。
        save();
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
    // v2.6：失败 / 取消 / 预算中止路径都要入账——未计入的模型调用与活动时长随
    // 终态 checkpoint 落盘。否则"全部模型请求统一计量"在失败路径上漏账：
    // 主请求抛出前的 attempts（含内部重试）与此前累计的活动时长就此消失。
    if (budgetModelCalls > 0 && contextHarness.observeExecution) {
      contextHarness.observeExecution({
        modelCalls: budgetModelCalls,
        outputTokens: 0,
        activeMs: performance.now() - budgetMarkAt,
      });
      budgetModelCalls = 0;
      save();
    }
    // v2.6：请求进行中被预算硬截止中止 ≠ 用户取消 ≠ 执行失败。落优雅停止，
    // Host 保存现场并以 budget_exhausted 说明——模型未产出可用响应，
    // 绝不按 failed 计，也绝不冒充 completed。
    if (budgetAborted) {
      throw new AgentStopRequestedError({
        code: 'budget_exhausted',
        notice:
          '执行预算（累计活动时长）在模型请求进行中耗尽，Runtime 已中止在途请求，未获得完整响应。' +
          '以上为已建立的证据与部分结果；未完成部分因预算耗尽未能继续。',
      });
    }
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
