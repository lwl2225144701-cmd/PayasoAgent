import { type EvidenceView, isWorkspaceRelativePath } from '../execution-evidence.js';
import type {
  ChatMessage,
  LlmStopReason,
  MessageImage,
  ModelConfig,
  ToolSchema,
} from '../llm/llm.js';
import { getNetworkMode } from '../network-mode.js';
import type { PermissionMode } from '../permission-mode.js';
import type { RuntimeToolchainCapabilities } from '../sandbox/toolchain-manager.js';
import type { TaskConstraints } from '../task-constraints.js';
import { utf8ByteLength } from '../tool-output-budget.js';
import {
  type CompactionPolicy,
  resolveCompactionPolicy,
  resolveCompactionThresholds,
} from './compaction-policy.js';
import { ContextManager, type ContextUsage } from './context-manager.js';
import {
  type ContextHarnessPendingReminders,
  type ContextHarnessState,
  createContextHarnessState,
  normalizeContextHarnessState,
} from './context-state.js';
import {
  type ConversationSummarizer,
  LlmConversationSummarizer,
} from './conversation-summarizer.js';
import {
  advanceExecutionBudget,
  completeExecutionBudgetPolicy,
  type ExecutionBudgetBucket,
  type ExecutionBudgetDecision,
  type ExecutionBudgetLevel,
  type ExecutionBudgetPolicy,
  type ExecutionBudgetState,
  type ExecutionBudgetUsage,
  executionBudgetBucketsFor,
  executionBudgetWouldExceed,
  normalizeExecutionBudgetState,
  renderExecutionBudgetReminder,
  resolveExecutionBudgetPolicy,
} from './execution-policy.js';
import { type FinalReviewInput, reviewFinalAnswer } from './final-review.js';
import {
  advanceGoalReview,
  type GoalReviewPolicy,
  type GoalReviewReminder,
  normalizeGoalReviewState,
  renderGoalReviewReminder,
  resolveGoalReviewPolicy,
} from './goal-review.js';
import { InstructionComposer } from './instruction-composer.js';
import {
  buildBaseSegments,
  envContextPrompt,
  networkSystemPrompt,
  projectInstructionsPrompt,
  toolchainSystemPrompt,
} from './instructions.js';
import {
  estimateJsonTokens,
  estimateTextTokens,
  getKnownModelCapability,
  type ModelContextConfig,
  resolveModelContextConfig,
} from './model-context.js';
import {
  applyPlan,
  buildPlanReport,
  type PlanPort,
  type PlanReport,
  renderBoundedPlanView,
} from './plan.js';
import {
  advanceProgressReminder,
  DEFAULT_PROGRESS_REMINDER_POLICY,
  normalizeProgressReminderState,
  type ProgressReminder,
  type ProgressReminderPolicy,
  renderProgressReminder,
  type ToolTurnProgress,
} from './progress-reminder.js';
import {
  advanceProgressWatch,
  normalizeProgressWatchState,
  type ProgressWatchDecision,
  renderProgressWatchReminder,
} from './progress-watch.js';
import {
  advanceRepeatCall,
  DEFAULT_REPEAT_CALL_POLICY,
  normalizeRepeatCallState,
  type RepeatCallPolicy,
  type RepeatCallReminder,
  renderRepeatCallReminder,
  resolveRepeatCallPolicy,
  type ToolInvocationObservation,
} from './repeat-call-policy.js';
import { renderBoundedScratchpadView, type ScratchpadView } from './scratchpad-view.js';
import { normalizeTaskFocus, renderTaskFocus, resolveTaskFocus } from './task-focus.js';
import {
  type ProjectionPolicy,
  projectStaleToolOutputs,
  resolveProjectionPolicy,
} from './tool-output-projection.js';

export interface ContextCompactionResult {
  summarizedMessages: number;
  totalSummarizedMessages: number;
  summaryTokens: number;
  /** 被压掉的原文 token 量（与 summaryTokens 一起给出压缩比，可审计）。 */
  sourceTokens: number;
  /** 摘要请求是否走了"复现上一请求真前缀"的 KV 缓存快路径。 */
  cacheAligned: boolean;
}

/**
 * Model-facing policy for a turn that produced neither a tool call nor any
 * visible content. The Runtime owns the *invariant* (a run must never end
 * silently with an empty answer); the Harness owns the *words* and the budget.
 */
export interface EmptyTurnObservation {
  stopReason?: LlmStopReason;
  durationMs: number;
  outputTokens?: number;
}

export interface EmptyTurnPolicy {
  /** Instruction appended to the transcript to make the model continue. */
  nudge: string;
  /** Recoveries allowed before the run fails loudly instead of completing empty. */
  maxRecoveries: number;
}

/**
 * Model-facing policy for a non-empty turn that still looks like an unfinished
 * plan. Kept separate from EmptyTurnPolicy so the two recovery budgets remain
 * independently auditable.
 */
export interface IncompleteTurnPolicy extends EmptyTurnPolicy {
  reason: string;
}

/**
 * 收尾前计划收尾提醒（v2.4）：模型准备输出最终答案、但计划里仍有未完成项时，
 * 先注入一次提醒让模型自己把计划收尾（标 completed，或如实保留并说明原因）。
 *
 * 为什么不让 Runtime 直接改计划：计划内容是模型的表述，Runtime 代写会失真；
 * 这里只提供"提醒一次"的机会，收不收尾仍由模型判断。
 * 也不做成硬约束——一次性提醒，不阻断收尾（对应 plan_incomplete_at_finish 仅留痕的既有约定）。
 */
export interface PlanFinalizePolicy {
  /** 追加到 transcript 的提醒文本。 */
  nudge: string;
  /** 未完成项数（仅用于事件审计）。 */
  unfinished: number;
}

export interface PreparedModelTurn {
  messages: ChatMessage[];
  usage: ContextUsage;
  scratchpadTokens: number;
  scratchpadTruncated: boolean;
  /** 计划投影注入 system 消耗的估算 token（有界，见 planViewText）。 */
  planTokens: number;
  compaction?: ContextCompactionResult;
  /** 实际发给模型的工具历史有损投影；与消息删除、摘要压缩分别记录。 */
  toolProjection?: { projectedCount: number; savedBytes: number; unprojectedInputTokens: number };
  /**
   * v2.6：prepareTurn 期间（压缩摘要等 Harness 自持的模型调用）新跨过的预算档位。
   * 全部模型请求统一计量——Runtime 据此发事件并落 checkpoint，与主循环的
   * observeExecution 走同一条决策通路。
   */
  budgetDecisions?: ExecutionBudgetDecision[];
}

/** 一个已完成工具回合的观察结果（progress 与 goal review 各自独立触发）。 */
export interface ToolTurnObservations {
  progress?: ProgressReminder;
  goalReview?: GoalReviewReminder;
  /** v2.5（计划 §8）：事实型进度审查（机械可验证的重复）。 */
  progressWatch?: ProgressWatchDecision;
}

export interface AgentContextHarness {
  beginTask?(
    task: string,
    history: readonly ChatMessage[],
    workspaceRoot: string,
    resuming?: boolean,
  ): string;
  reviewFinalAnswer?: (input: FinalReviewInput) => Promise<string>;
  readonly modelContext: ModelContextConfig;
  createTranscript(
    task: string,
    history?: ChatMessage[],
    attachments?: MessageImage[],
  ): ChatMessage[];
  prepareTurn(
    transcript: ChatMessage[],
    scratchpad: ScratchpadView,
    tools: ToolSchema[],
    signal?: AbortSignal,
    evidenceView?: EvidenceView,
  ): Promise<PreparedModelTurn>;
  restoreState(state: ContextHarnessState | undefined): void;
  snapshotState(): ContextHarnessState;
  // 只观察已结束的工具回合；触发后返回审计数据，由 Runtime 发事件并保存。
  // v2.6：同时驱动周期性目标审查（按全部工具回合），两类提醒独立返回。
  observeToolTurn?(turn: ToolTurnProgress): ToolTurnObservations | undefined;
  // v2.6 执行不收敛治理：一次工具调用的**统一**观察口径。覆盖 process-manager 的
  // 全部出口（成功/失败/拒绝/回放/不确定/参数无效），因此 Harness 的计数是完整
  // 的——Runtime 不能只挑便利的出口上报。返回跨过新阈值的提醒（Runtime 发事件）。
  observeToolInvocation?(observation: ToolInvocationObservation): RepeatCallReminder | undefined;
  // v2.6 执行不收敛治理：累计一次模型调用的机械用量（调用次数 / 输出 token /
  // 活动时长），返回分级决策。exhausted 由 Runtime 转成优雅停止，其余只提醒。
  observeExecution?(usage: ExecutionBudgetUsage): ExecutionBudgetDecision | undefined;
  // v2.6：当前预算档位（粘滞、单调不降）。Runtime 在模型调用前与每个工具执行前
  // 做准入检查；exhausted 即停止新工作，只保留预留的收尾生成。
  executionBudgetLevel?(): ExecutionBudgetLevel;
  // v2.6：请求进行中的预算投影——把「本次请求已进行的时间」叠加到累计用量上，
  // 判断是否已越过 maxActiveMs。Runtime 每 250ms 轮询一次，为 true 即中止在途
  // 请求（持续长输出的硬约束；不配置 maxActiveMs 恒 false）。
  executionBudgetProjection?(elapsedMs: number): boolean;
  // v2.6：预留收尾的独立小额额度（收尾请求专用；未启用预算时 undefined）。
  executionBudgetWrapUpLimits?(): { maxOutputTokens?: number; maxActiveMs?: number } | undefined;
  // 模型成功响应后才消费待发送提醒；请求失败/取消时保留，供恢复后继续投影。
  acknowledgeProgressReminder?(): boolean;
  // v2.6：消费全部待投递提醒（重复调用 + 执行预算）。与 progress 的 acknowledge 同
  // 时序：只在模型真的响应了之后，避免失败请求把提醒白白吃掉。
  acknowledgeConvergenceReminders?(): boolean;
  // v2.6：待投递提醒的注入文本（prepareTurn 拼进 [Context]）。空数组 = 无待投递。
  pendingReminderTexts?(): string[];
  // v2.2 Plan：Harness 持有的任务清单写入口。Runtime 只负责把返回的 changed 变成
  // `plan_update` 事件（Harness 不碰 trace）；fake Harness 不实现也不影响编译，
  // 此时 updatePlan 工具 fail-closed 报错。
  planPort?(): PlanPort;
  // v2.2 Plan：收尾审计 —— 回答「Run 结束时计划还剩什么没做完」。只报告不改行为
  // （刻意不做成"未完成就不许收尾"的硬约束）；Runtime 据此发审计事件。
  planReport?(): PlanReport;
  // v2.4 Plan：收尾前的最后提醒 —— 计划仍有未完成项、模型又准备收尾时，
  // 由 Runtime 注入一次提醒（已有预算约束），让模型自己决定是否收尾。
  // 返回 undefined 表示不需要提醒（计划已完成 / 无计划）。
  planFinalizePolicy?(): PlanFinalizePolicy | undefined;
  sanitizeAssistantMessage(message: ChatMessage): ChatMessage;
  sanitizeFinalAnswer(text: string): string;
  // Optional Harness policy hook. Called after a tool turn and before the
  // Runtime starts the next model turn; returning true requests a graceful
  // stop without changing tool execution semantics.
  shouldStopAfterTurn?(input: {
    iteration: number;
    usage: ContextUsage;
  }): boolean | Promise<boolean>;
  // v1.6 工具链闭环：受控安装完成后由 Host 经准备结果通道刷新当前 Run 的
  // 工具链能力快照，下一轮模型视图即反映新的可用工具（不自动重放原命令）。
  refreshToolchain?(capabilities: RuntimeToolchainCapabilities): void;
  // v1.8 空回合不变量：模型既没有工具调用也没有可见内容时，Runtime 依此策略
  // 追加提示并重试；返回 undefined 表示不做恢复（直接按失败处理）。
  emptyTurnPolicy?(observation?: EmptyTurnObservation): EmptyTurnPolicy;
  // 文本完成度属于 Harness 策略；缺省/返回 undefined 表示接受此回答。
  incompleteTurnPolicy?(answer: string): IncompleteTurnPolicy | undefined;
  // 任务约束（Host 在 Run 创建时固化，非模型可控）：仅影响指令内容，
  // 权限由 Runtime/工具层强制，Harness 文案不得承诺或扩大权限。
  setTaskConstraints?(constraints: TaskConstraints | undefined): void;
}

function stripThink(text: string): string {
  let output = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  if (output.includes('<think>')) output = output.split('<think>')[0];
  return output.trim();
}

import type { TextAttachmentRef } from '../attachment-types.js';
import { attachmentManifest } from './attachment-manifest.js';

export class DefaultContextHarness implements AgentContextHarness {
  reviewFinalAnswer?: (input: FinalReviewInput) => Promise<string>;
  private textAttachments: TextAttachmentRef[] = [];

  setTextAttachments(files: TextAttachmentRef[]): void {
    this.textAttachments = files;
  }
  readonly modelContext: ModelContextConfig;
  private readonly contextManager: ContextManager;
  private readonly composer: InstructionComposer;
  private toolchain: RuntimeToolchainCapabilities | undefined;
  private readonly summarizer: ConversationSummarizer;
  private readonly progressReminderPolicy: ProgressReminderPolicy | undefined;
  // P2-C 投影策略：旧工具结果的确定性降级（env 可调，PAYASO_PROJECT_OLD_TOOL_OUTPUTS=0 关闭）。
  private readonly projectionPolicy: ProjectionPolicy;
  // P2-D 压缩阈值策略：触发线 = min(窗口比例, 独立成本上限)，保留量留出带宽。
  private readonly compactionPolicy: CompactionPolicy;
  // v2.6 执行不收敛治理：重复调用观察（undefined = 关闭）。只提醒、不阻断。
  private readonly repeatCallPolicy: RepeatCallPolicy | undefined;
  // v2.6 执行不收敛治理：机械预算（undefined = 关闭）。默认无上限（保持旧行为）。
  private readonly executionBudgetPolicy: ExecutionBudgetPolicy | false;
  // v2.6 周期性目标审查（undefined = 关闭）。按全部工具回合计数，默认开启。
  private readonly goalReviewPolicy: GoalReviewPolicy | undefined;
  // v2.5（计划 §8）：事实型进度闭环。PAYASO_PROGRESS_WATCH=off 或 options.progressWatch=false 关闭。
  private readonly progressWatchPolicy: boolean;
  private state = createContextHarnessState();
  // v2.6：prepareTurn 期间（压缩摘要）产生的预算决策，随 prepareTurn 结果交回
  // Runtime 发事件；transient，不落 checkpoint。
  private prepareBudgetDecisions: ExecutionBudgetDecision[] = [];

  constructor(options: {
    permissionMode: PermissionMode;
    model?: string;
    modelConfig?: ModelConfig;
    summarizer?: ConversationSummarizer;
    state?: ContextHarnessState;
    modelContext?: ModelContextConfig;
    toolchain?: RuntimeToolchainCapabilities;
    workspaceName?: string;
    projectInstructions?: string;
    finalReview?: boolean;
    progressReminder?: ProgressReminderPolicy | false;
    projection?: ProjectionPolicy;
    compaction?: CompactionPolicy;
    repeatCall?: RepeatCallPolicy | false;
    executionBudget?: ExecutionBudgetPolicy | false;
    goalReview?: GoalReviewPolicy | false;
    progressWatch?: boolean;
  }) {
    this.projectionPolicy = options.projection ?? resolveProjectionPolicy();
    this.compactionPolicy = options.compaction ?? resolveCompactionPolicy();
    // 显式关闭（off / false）优先于任何默认值；未指定时按环境解析（默认开启）。
    const resolvedRepeatCall = options.repeatCall ?? resolveRepeatCallPolicy();
    this.repeatCallPolicy =
      resolvedRepeatCall === false ? undefined : (resolvedRepeatCall ?? DEFAULT_REPEAT_CALL_POLICY);
    if (
      this.repeatCallPolicy &&
      !(
        Number.isSafeInteger(this.repeatCallPolicy.warnAt) &&
        this.repeatCallPolicy.warnAt >= 1 &&
        Number.isSafeInteger(this.repeatCallPolicy.escalateAt) &&
        this.repeatCallPolicy.escalateAt >= 1 &&
        Number.isSafeInteger(this.repeatCallPolicy.blockAt) &&
        this.repeatCallPolicy.blockAt >= 1 &&
        this.repeatCallPolicy.warnAt <= this.repeatCallPolicy.escalateAt &&
        this.repeatCallPolicy.escalateAt <= this.repeatCallPolicy.blockAt
      )
    )
      throw new Error('Invalid repeat call policy');
    // 启用即完备：env 解析与 SDK 注入两条路径都补全缺失维度——
    // "启用但某维度无上限"是静默空转策略（提醒照发、永不拦截），正是治理缺口。
    if (options.executionBudget !== false && options.executionBudget !== undefined) {
      // SDK 注入的显式上限必须本身合法：complete 只补默认值，不洗白非法值
      // （0 / 负数 / NaN / Infinity 会静默取消该维度约束——CFG-04）。
      for (const key of ['maxModelCalls', 'maxOutputTokens', 'maxActiveMs'] as const) {
        const value = options.executionBudget[key];
        if (value === undefined) continue;
        if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) {
          throw new Error(
            `Invalid execution budget: ${key} must be a finite positive integer, got ${String(value)}`,
          );
        }
      }
    }
    this.executionBudgetPolicy =
      options.executionBudget === false
        ? false
        : options.executionBudget === undefined
          ? resolveExecutionBudgetPolicy()
          : completeExecutionBudgetPolicy(options.executionBudget);
    if (
      this.executionBudgetPolicy &&
      !(
        this.executionBudgetPolicy.warnRatio > 0 &&
        this.executionBudgetPolicy.warnRatio <= this.executionBudgetPolicy.convergeRatio &&
        this.executionBudgetPolicy.convergeRatio < 1
      )
    )
      throw new Error('Invalid execution budget policy');
    this.progressReminderPolicy =
      options.progressReminder === false || process.env.PAYASO_PROGRESS_REMINDER === 'off'
        ? undefined
        : { ...DEFAULT_PROGRESS_REMINDER_POLICY, ...options.progressReminder };
    // v2.6 周期性目标审查：显式关闭优先；未指定按环境解析（默认开启）。
    const resolvedGoalReview = options.goalReview ?? resolveGoalReviewPolicy();
    this.goalReviewPolicy = resolvedGoalReview === false ? undefined : resolvedGoalReview;
    this.progressWatchPolicy =
      options.progressWatch !== false && process.env.PAYASO_PROGRESS_WATCH !== 'off';
    if (
      this.progressReminderPolicy &&
      (!Number.isSafeInteger(this.progressReminderPolicy.minReadOnlyTurns) ||
        this.progressReminderPolicy.minReadOnlyTurns < 1 ||
        !Number.isSafeInteger(this.progressReminderPolicy.minReadOnlyMs) ||
        this.progressReminderPolicy.minReadOnlyMs < 0)
    )
      throw new Error('Invalid progress reminder policy');
    const resolvedContext =
      options.modelContext ??
      resolveModelContextConfig({
        model: options.modelConfig?.model ?? options.model,
        // 模型设置按模型配置的能力覆盖优先于内置注册表
        contextWindowTokens: options.modelConfig?.contextWindow,
        maxOutputTokens: options.modelConfig?.maxOutputTokens,
      });
    this.modelContext = resolvedContext;
    if (options.finalReview)
      this.reviewFinalAnswer = (input) =>
        reviewFinalAnswer(input, this.modelContext.maxInputTokens);
    this.contextManager = new ContextManager(this.modelContext.maxInputTokens);
    this.toolchain = options.toolchain;
    this.composer = new InstructionComposer();

    // Resolve model-specific prompt notes from the known model capability registry.
    const known = getKnownModelCapability(resolvedContext.model);

    // Build all base segments and register with the composer.
    // Dynamic segments (network, toolchain, env) are refreshed each turn via
    // systemPromptText() so that runtime state changes stay accurate.
    const projectInstructions = options.projectInstructions ?? '';
    const baseSegments = buildBaseSegments({
      permissionMode: options.permissionMode,
      modelPromptNotes: known?.promptNotes,
      toolchainCapabilities: options.toolchain,
      networkMode: getNetworkMode(),
      workspaceName: options.workspaceName,
      projectInstructions,
    });
    for (const seg of baseSegments) {
      this.composer.addSegment(seg);
    }

    this.summarizer = options.summarizer ?? new LlmConversationSummarizer(options.modelConfig);
    this.restoreState(options.state);
  }

  // 工具链段每轮动态拼装（与 network 段同模式）：受控安装完成后 Host 经
  // refreshToolchain 更新快照，下一轮模型视图即反映新的可用工具（不自动重放原命令）。
  refreshToolchain(capabilities: RuntimeToolchainCapabilities): void {
    this.toolchain = capabilities;
    this.composer.updateContent('platform.toolchain', toolchainSystemPrompt(capabilities));
  }

  // Skills 索引段动态更新（workspace 级 skills 在 Run 启动时扫描注入，运行中不变）。
  setSkills(skills: Array<{ name: string; description: string }>): void {
    const has = this.composer.has('skills.index');
    if (skills.length === 0) {
      if (has) this.composer.removeSegment('skills.index');
      return;
    }
    const lines = skills
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => `- ${s.name}: ${s.description.slice(0, 200)}`)
      .join('\n');
    const content = `## Available Skills\n\nUse the \`loadSkill\` tool to load the full skill content.\n\n${lines}`;
    if (has) {
      this.composer.updateContent('skills.index', content);
    } else {
      this.composer.addSegment({
        id: 'skills.index',
        priority: 40,
        content,
        budgetTokens: 2048,
        mutability: 'per_run',
      });
    }
  }

  // 任务约束段（Host 固化后传入，运行中不变）：写范围与证据模式输出契约。
  // 只描述模型可见的行为边界；真正的强制在 Runtime/工具/沙箱层，文案不得越权承诺。
  setTaskConstraints(constraints: TaskConstraints | undefined): void {
    // 来源摘录已有独立的 Host 原文投影，不能让语义检查重写它的 JSON 协议。
    if (constraints?.evidence) this.reviewFinalAnswer = undefined;
    const has = this.composer.has('task.constraints');
    if (!constraints) {
      if (has) this.composer.removeSegment('task.constraints');
      return;
    }
    const parts: string[] = [];
    if (constraints.writeScope !== undefined) {
      parts.push(
        constraints.writeScope.length === 0
          ? '- Write scope: this run is read-only. No file may be created or modified (write/edit and Shell writes are enforced read-only).'
          : `- Write scope (Host-enforced): ONLY these workspace-relative files may be written: ${constraints.writeScope.join(', ')}. Every other path is read-only; creating directories, scripts or scratch files is denied. Deliver changes through write/edit on exactly these files.`,
      );
    }
    if (constraints.evidence) {
      const items = constraints.evidence.items.map((item, i) => `- item ${i}: ${item}`).join('\n');
      const sources = constraints.evidence.sources
        .map((s, i) => `- source ${i}: ${s.path}`)
        .join('\n');
      parts.push(
        [
          '- Evidence mode: answer ONLY with excerpts from the pinned sources; add no facts of your own.',
          '- Your final answer must be exactly this JSON and nothing else:',
          '  [{"item": <item index>, "citations": [{"source": <source index>, "start": <first line>, "end": <last line>}]}]',
          items,
          sources,
          '- start/end are 1-based line numbers; each span covers at most 40 lines; use an empty citations array when a question has no supporting text.',
          '- The Host verifies every citation against the pinned file versions and renders the excerpts itself. Free-form prose is rejected and not shown to the user.',
        ].join('\n'),
      );
    }
    if (parts.length === 0) {
      if (has) this.composer.removeSegment('task.constraints');
      return;
    }
    const content = `## Task Constraints\n\n${parts.join('\n')}`;
    if (has) this.composer.removeSegment('task.constraints');
    this.composer.addSegment({
      id: 'task.constraints',
      priority: 25,
      content,
      budgetTokens: estimateTextTokens(content),
      mutability: 'per_run',
    });
  }

  // 项目级指令动态更新（一般 per-run 不变，这里保留接口备 Host 侧运行时按需刷新）。
  // 空字符串视为无项目指令：若 composer 里有就移除，没有就不动。
  setProjectInstructions(content: string): void {
    const trimmed = content.trim();
    const has = this.composer.has('project.instructions');
    if (!trimmed) {
      if (has) this.composer.removeSegment('project.instructions');
      return;
    }
    if (has) {
      this.composer.updateContent('project.instructions', projectInstructionsPrompt(trimmed));
    } else {
      this.composer.addSegment({
        id: 'project.instructions',
        priority: 30,
        content: projectInstructionsPrompt(trimmed),
        budgetTokens: 8192,
        mutability: 'per_run',
      });
    }
  }

  createTranscript(
    task: string,
    history: ChatMessage[] = [],
    attachments: MessageImage[] = [],
  ): ChatMessage[] {
    // 会话历史可能来自上一轮 checkpoint 的完整 transcript（含工具交互）。
    // 保留 tool 消息及其 tool_calls / tool_call_id，跨轮调用链对模型保持连贯；
    // 上一轮的 system 不携带（本轮由 Harness 重新构建）。
    // images 只保留路径引用（checkpoint/transcript 轻量），base64 物化在
    // 每轮调用模型前由 Runtime 完成；data 字段不进入 transcript。
    const conversation = history
      .filter(
        (message) =>
          message.role === 'user' || message.role === 'assistant' || message.role === 'tool',
      )
      .map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.textAttachments?.length
          ? { textAttachments: message.textAttachments.map((file) => ({ ...file })) }
          : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.images?.length
          ? {
              images: message.images.map((image) => ({
                mimeType: image.mimeType,
                path: image.path,
              })),
            }
          : {}),
      })) as ChatMessage[];
    return [
      { role: 'system', content: this.systemPromptText() },
      ...conversation,
      {
        role: 'user',
        content: task + attachmentManifest(this.textAttachments),
        ...(this.textAttachments.length
          ? { textAttachments: this.textAttachments.map((file) => ({ ...file })) }
          : {}),
        ...(attachments.length > 0
          ? {
              images: attachments.map((image) => ({
                mimeType: image.mimeType,
                path: image.path,
              })),
            }
          : {}),
      },
    ];
  }

  restoreState(state: ContextHarnessState | undefined): void {
    this.state = normalizeContextHarnessState(state);
  }

  observeToolTurn(turn: ToolTurnProgress): ToolTurnObservations | undefined {
    let progress: ProgressReminder | undefined;
    let goalReview: GoalReviewReminder | undefined;
    if (this.progressReminderPolicy) {
      const previous = normalizeProgressReminderState(this.state.progressReminder);
      const next = advanceProgressReminder(previous, turn, this.progressReminderPolicy);
      this.state.progressReminder = next;
      if (previous.reminder !== 'pending' && next.reminder === 'pending') {
        progress = { readOnlyTurns: next.readOnlyTurns, readOnlyMs: next.readOnlyMs };
      }
    }
    // v2.6 周期性目标审查：按全部已完成工具回合计数（读/写/失败/中性都算），
    // 覆盖「换参数、换命令调查同一问题」这类参数摘要识别不了的反复调查。
    if (this.goalReviewPolicy) {
      const previous = normalizeGoalReviewState(this.state.goalReview);
      const advanced = advanceGoalReview(previous, turn, this.goalReviewPolicy);
      this.state.goalReview = advanced.state;
      if (advanced.reminder) {
        goalReview = advanced.reminder;
        this.state.pending = this.withPending({
          goalReview: {
            toolTurns: advanced.reminder.toolTurns,
            activeMs: advanced.reminder.activeMs,
            goal: (turn.goal ?? '').slice(0, 500),
            ...(turn.recentResult === undefined
              ? {}
              : { recentResult: turn.recentResult.slice(0, 240) }),
          },
        });
      }
    }
    let progressWatch: ProgressWatchDecision | undefined;
    if (this.progressWatchPolicy && turn.facts) {
      const previousWatch = normalizeProgressWatchState(this.state.progressWatch);
      const decision = advanceProgressWatch(previousWatch, turn.facts, turn.durationMs);
      this.state.progressWatch = decision.state;
      if (decision.remind !== 'none') {
        progressWatch = decision;
        this.state.pending = this.withPending({
          progressWatch: {
            level: decision.remind,
            reason: decision.reason ?? '',
            evidenceIds: turn.facts.evidenceIds.slice(0, 8),
          },
        });
      }
    }
    if (progress === undefined && goalReview === undefined && progressWatch === undefined) {
      return undefined;
    }
    return {
      ...(progress === undefined ? {} : { progress }),
      ...(goalReview === undefined ? {} : { goalReview }),
      ...(progressWatch === undefined ? {} : { progressWatch }),
    };
  }

  acknowledgeProgressReminder(): boolean {
    if (!this.progressReminderPolicy || this.state.progressReminder?.reminder !== 'pending')
      return false;
    this.state.progressReminder.reminder = 'delivered';
    return true;
  }

  beginTask(
    task: string,
    history: readonly ChatMessage[],
    workspaceRoot: string,
    resuming = false,
  ): string {
    const previous = normalizeTaskFocus(this.state.taskFocus);
    this.state.taskFocus = resolveTaskFocus(task, previous, history, workspaceRoot);
    if (!resuming) this.state.progressWatch = undefined;
    return task;
  }

  // ---- v2.6 执行不收敛治理：Harness 只累计与投递提醒，阻断由 Runtime 决定 ----

  /**
   * 统一观察一次工具调用的处置（Runtime 在 process-manager 的每个出口上报）。
   * 返回跨过新阈值的提醒；Harness 同时把它挂进 pending，等模型真的响应后再消费。
   */
  observeToolInvocation(observation: ToolInvocationObservation): RepeatCallReminder | undefined {
    if (!this.repeatCallPolicy) return undefined;
    const previous = normalizeRepeatCallState(this.state.repeatCall);
    const { state: next, reminder } = advanceRepeatCall(
      previous,
      observation,
      this.repeatCallPolicy,
    );
    this.state.repeatCall = next;
    if (reminder) this.state.pending = this.withPending({ repeatCall: reminder });
    return reminder;
  }

  /**
   * 累计一次模型调用的机械用量并分级。exhausted 不在这里阻断——Runtime 依此转成
   * 优雅停止（AgentStopRequestedError），checkpoint 与语义保持完整。
   */
  observeExecution(usage: ExecutionBudgetUsage): ExecutionBudgetDecision | undefined {
    if (!this.executionBudgetPolicy) return undefined;
    return this.advanceBudget(usage, false);
  }

  /**
   * 预算累计的唯一入口（observeExecution 与 Harness 自持的摘要调用共用）。
   * collect=true 时把决策暂存到 prepareBudgetDecisions，由 prepareTurn 交回
   * Runtime 发事件——压缩发生在 prepareTurn 内部，Runtime 看不见这次调用。
   */
  private advanceBudget(
    usage: ExecutionBudgetUsage,
    collect: boolean,
  ): ExecutionBudgetDecision | undefined {
    if (!this.executionBudgetPolicy) return undefined;
    const previous = normalizeExecutionBudgetState(this.state.executionBudget);
    const decision = advanceExecutionBudget(previous, usage, this.executionBudgetPolicy);
    this.state.executionBudget = decision.state;
    if (collect && decision.buckets.length > 0) {
      this.prepareBudgetDecisions.push(decision);
    }
    // 只在本轮**新**跨阈值时排队提醒。level 是粘滞档位（跨过就一直保持），
    // 若按 level 判断，warn 之后的每一轮都会重复注入同一段提醒——那本身就是
    // 一种"执行不收敛"。buckets 为空 = 本轮没有新变化，不打扰。
    // exhausted 不投提醒：继续要求模型交付只会让它再多花一轮，与预算目的相反。
    // 显式收窄 level：buckets 非空即意味着跨过某档（不可能还是 none），但 TS 无法
    // 从 buckets.length 推出这一点，写成显式判别让类型与语义同时成立。
    const budgetLevel = decision.level;
    if (decision.buckets.length > 0 && (budgetLevel === 'warn' || budgetLevel === 'converge')) {
      this.state.pending = this.withPending({
        budget: { level: budgetLevel, buckets: decision.buckets },
      });
    }
    return decision;
  }

  acknowledgeConvergenceReminders(): boolean {
    if (!this.state.pending) return false;
    // 目标审查的 delivered 标记随 acknowledge 落定：resume 后不重复投递同一周期。
    if (this.state.pending.goalReview && this.state.goalReview?.review === 'pending') {
      this.state.goalReview = { ...this.state.goalReview, review: 'delivered' };
    }
    this.state.pending = undefined;
    return true;
  }

  /** 当前预算档位（粘滞）。Runtime 准入检查专用；未启用预算时恒为 none。 */
  executionBudgetLevel(): ExecutionBudgetLevel {
    if (!this.executionBudgetPolicy) return 'none';
    const state = normalizeExecutionBudgetState(this.state.executionBudget);
    if (state.exhausted.length > 0) return 'exhausted';
    if (Object.values(state.converged).some(Boolean)) return 'converge';
    if (Object.values(state.warned).some(Boolean)) return 'warn';
    return 'none';
  }

  executionBudgetProjection(elapsedMs: number): boolean {
    if (!this.executionBudgetPolicy) return false;
    return executionBudgetWouldExceed(
      normalizeExecutionBudgetState(this.state.executionBudget),
      this.executionBudgetPolicy,
      elapsedMs,
    );
  }

  executionBudgetWrapUpLimits(): { maxOutputTokens?: number; maxActiveMs?: number } | undefined {
    if (!this.executionBudgetPolicy) return undefined;
    return {
      maxOutputTokens: this.executionBudgetPolicy.wrapUpMaxOutputTokens,
      maxActiveMs: this.executionBudgetPolicy.wrapUpMaxActiveMs,
    };
  }

  /**
   * 待投递提醒的注入文本（prepareTurn → [Context] 末尾）。
   * 桶名缺失时按当前实际用量重算，保证渲染的一定是真实比例。
   */
  pendingReminderTexts(): string[] {
    const pending = this.state.pending as ContextHarnessPendingReminders | undefined;
    if (!pending) return [];
    const texts: string[] = [];
    if (pending.repeatCall) texts.push(renderRepeatCallReminder(pending.repeatCall));
    if (pending.budget && this.executionBudgetPolicy) {
      const budgetState: ExecutionBudgetState = normalizeExecutionBudgetState(
        this.state.executionBudget,
      );
      const buckets: ExecutionBudgetBucket[] =
        pending.budget.buckets.length > 0
          ? pending.budget.buckets
          : executionBudgetBucketsFor(
              budgetState,
              this.executionBudgetPolicy,
              pending.budget.level,
            );
      texts.push(
        renderExecutionBudgetReminder(
          budgetState,
          this.executionBudgetPolicy,
          pending.budget.level,
          buckets,
        ),
      );
    }
    if (pending.goalReview) {
      // 用户目标和工具结果已有独立上下文；常规回顾只保留本周期观察。
      texts.push(
        renderGoalReviewReminder({
          toolTurns: pending.goalReview.toolTurns,
          activeMs: pending.goalReview.activeMs,
        }),
      );
    }
    if (pending.progressWatch) {
      texts.push(
        renderProgressWatchReminder(
          {
            state: normalizeProgressWatchState(this.state.progressWatch),
            remind: pending.progressWatch.level,
            reason: pending.progressWatch.reason,
          },
          pending.progressWatch.evidenceIds,
        ),
      );
    }
    return texts;
  }

  /** prepareTurn 期间的预算累计（压缩摘要）：决策暂存，随 prepareTurn 返回。 */
  private advanceBudgetForPrepare(usage: ExecutionBudgetUsage): void {
    this.advanceBudget(usage, true);
  }

  /** 合并待投递提醒（不丢另一类；同类型直接覆盖为最新一次）。 */
  private withPending(patch: ContextHarnessPendingReminders): ContextHarnessPendingReminders {
    const current = this.state.pending as ContextHarnessPendingReminders | undefined;
    return { ...current, ...patch };
  }

  // v2.2 Plan：计划状态与语义都在 Harness（见 plan.ts）。这里只做"改状态 + 回文本"，
  // 不发事件、不落盘——那是 Runtime 的职责（changed → plan_update → checkpoint）。
  planPort(): PlanPort {
    return {
      apply: (items) => {
        const applied = applyPlan(this.state.plan, items);
        if (applied.changed) this.state.plan = applied.plan;
        return applied;
      },
    };
  }

  planReport(): PlanReport {
    return buildPlanReport(this.state.plan);
  }

  planFinalizePolicy(): PlanFinalizePolicy | undefined {
    // 计划状态已在模型视图中提示；不因待办/进行中项打回模型选择的最终答复。
    return undefined;
  }

  /**
   * 计划注入 system 的有界投影（空计划返回空串，保证视图与旧行为逐字节一致）。
   * 预算：窗口的 0.5%，夹在 128–300 token；再加 truncateToTokens 兜底。
   */
  private planViewText(): string {
    const bounded = renderBoundedPlanView(this.state.plan);
    if (!bounded.text) return '';
    const maxPlanTokens = Math.max(
      128,
      Math.min(300, Math.floor(this.modelContext.maxInputTokens * 0.005)),
    );
    return `\n\n${this.truncateToTokens(bounded.text, maxPlanTokens)}`;
  }

  // 动态段每轮刷新：网络模式、工具链能力、环境信息在下一轮 system 消息
  // 中保持准确。scratchpad 和 summary 通过 buildModelView 追加到 system 末尾。
  private systemPromptText(): string {
    // Refresh dynamic segment contents before composing.
    this.composer.updateContent('platform.toolchain', toolchainSystemPrompt(this.toolchain));
    this.composer.updateContent('platform.network', networkSystemPrompt(getNetworkMode()));
    this.composer.updateContent('env.context', envContextPrompt());
    // Budget target: 15% of maxInputTokens for system prompt overhead.
    const systemBudget = Math.max(512, Math.floor(this.modelContext.maxInputTokens * 0.15));
    const composed = this.composer.compose(systemBudget);
    const constraints = composed.diagnostics.find((d) => d.id === 'task.constraints');
    if (constraints?.truncated || constraints?.dropped)
      throw new Error('任务约束超出模型上下文预算，请缩短项目或文件列表');
    return composed.content;
  }

  snapshotState(): ContextHarnessState {
    return structuredClone(this.state);
  }

  private truncateToTokens(text: string, maxTokens: number): string {
    if (estimateTextTokens(text) <= maxTokens) return text;
    const marker = '\n…[truncated]';
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (estimateTextTokens(text.slice(0, mid) + marker) <= maxTokens) low = mid;
      else high = mid - 1;
    }
    return `${text.slice(0, low)}${marker}`;
  }

  private buildModelView(transcript: ChatMessage[]): ChatMessage[] {
    const modelView = transcript.map((message) => ({ ...message }));
    const systemIndex = modelView.findIndex((message) => message.role === 'system');
    // v2.5 稳定前缀：系统提示只保留内核指令（字节级稳定，作为前缀缓存第一段）。
    // 每轮会变的 计划/scratchpad/摘要/提醒 移到视图末尾的 [Context] 消息，
    // 不再改写 system 头部——否则 provider 前缀缓存从 system 处断裂，整段历史
    // 每轮全量 re-prefill（长上下文首字节超 30s 的根因）。
    const systemMessage: ChatMessage = {
      role: 'system',
      content: this.systemPromptText(),
    };
    if (systemIndex >= 0) {
      const maxSummarizable = Math.max(
        0,
        modelView.map((message) => message.role).lastIndexOf('user') - systemIndex - 1,
      );
      this.state.summarizedMessageCount = Math.min(
        this.state.summarizedMessageCount,
        maxSummarizable,
      );
      modelView.splice(systemIndex, 1 + this.state.summarizedMessageCount, systemMessage);
    } else {
      this.state.summarizedMessageCount = 0;
      modelView.unshift(systemMessage);
    }
    const visiblePaths = new Set(
      modelView.flatMap((message) => message.textAttachments ?? []).map((file) => file.path),
    );
    const archived = transcript
      .flatMap((message) => message.textAttachments ?? [])
      .filter((file) => !visiblePaths.has(file.path));
    if (archived.length) {
      const latestUser = modelView.map((message) => message.role).lastIndexOf('user');
      if (latestUser >= 0)
        modelView[latestUser].content +=
          attachmentManifest(archived.slice(-16)) +
          (archived.length > 16 ? '\n更早附件可用 ls 查看 input/attachments/。' : '');
    }
    return modelView;
  }

  /**
   * 动态上下文块：计划（目标层）→ scratchpad（执行层）→ 旧轮摘要 → 进度提醒。
   * 由 prepareTurn 在裁剪/压缩完成之后、发请求之前追加到视图末尾（角色 user）：
   * - 让 [内核 system + 历史] 构成稳定前缀，供应 provider 前缀缓存命中断；
   * - 不进 ContextManager 裁剪路径，避免抢占「最后一条 user=当前任务」边界、
   *   也避免 compaction 的 view/canonical 消息计数错位（v2.5 稳定前缀）。
   */
  /** 事实只从 Runtime 的只读视图投影，不能靠历史摘要重新推断通过状态。 */
  private evidenceViewText(view: EvidenceView | undefined, maxTokens: number): string {
    if (!view?.checks.length && !view?.reads?.length) return '';
    let text =
      '[Execution evidence]\nResults apply to recorded inputs. Unknown or stale versions do not verify current code.\n';
    for (const check of view.checks.slice(0, 8)) {
      if (!/^[\w-]{1,80}$/.test(check.checkId)) continue;
      const refs = Object.values(check.logRefs ?? {}).filter(isWorkspaceRelativePath);
      const row = `${JSON.stringify({
        id: check.checkId,
        profile: check.profile,
        result: check.conclusion ?? 'unknown',
        validity: check.validity ?? 'version-unknown',
        reusable: check.reusable,
        ...(refs.length ? { logs: refs } : {}),
      })}\n`;
      if (utf8ByteLength(text + row) > 2_048 || estimateTextTokens(text + row) > maxTokens) break;
      text += row;
    }
    if (view.reads?.length) {
      const header =
        '\n[Read coverage · recorded versions]\nThese ranges were returned earlier; the body may have been compacted. Reuse visible content, or retrieve the relevant range if it is no longer present. Revalidate changed versions.\n';
      if (estimateTextTokens(text + header) <= maxTokens && utf8ByteLength(text + header) <= 2048)
        text += header;
      for (const read of [...view.reads].reverse().slice(0, 8)) {
        if (!isWorkspaceRelativePath(read.path)) continue;
        const row = `${JSON.stringify({
          path: read.path,
          version: read.version.slice(0, 12),
          lines: read.returnedRanges.slice(0, 8).map((r) => [r.startLine, r.endLine]),
        })}\n`;
        if (estimateTextTokens(text + row) > maxTokens || utf8ByteLength(text + row) > 2048) break;
        text += row;
      }
    }
    return estimateTextTokens(text) <= maxTokens ? text.trim() : '';
  }

  private dynamicContextMessage(
    planText: string,
    scratchpadText: string,
    evidenceText = '',
  ): ChatMessage | null {
    const summaryText = this.state.conversationSummary
      ? `[Conversation Summary]\n${this.state.conversationSummary}`
      : '';
    const reminderText = this.progressReminderPolicy
      ? renderProgressReminder(this.state.progressReminder)
      : '';
    // v2.6 执行不收敛治理：重复调用提醒与预算预警/收敛审查。Harness 只在这里
    // 生成文本素材；Runtime 负责发事件、在模型成功响应后消费（acknowledgeConvergence
    // Reminders）。提醒一律只投影模型视图，不改 canonical transcript、不阻断工具。
    const convergenceTexts = this.pendingReminderTexts();
    const parts = [
      planText,
      scratchpadText,
      evidenceText,
      summaryText,
      reminderText,
      ...convergenceTexts,
    ]
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) return null;
    return { role: 'user', content: `[Context]\n${parts.join('\n\n')}` };
  }

  /** 只在达到既有压缩压力线后节省工具历史；条数变多本身不是丢正文的理由。 */
  private projectToolResults(messages: ChatMessage[], tools: ToolSchema[]) {
    const unprojectedInputTokens =
      this.contextManager.estimateTokens(messages) + (tools.length ? estimateJsonTokens(tools) : 0);
    const { trigger } = resolveCompactionThresholds(
      this.compactionPolicy,
      this.modelContext.maxInputTokens,
    );
    const result =
      unprojectedInputTokens > trigger
        ? projectStaleToolOutputs(messages, this.projectionPolicy)
        : { messages, projectedCount: 0, savedBytes: 0 };
    return { ...result, unprojectedInputTokens };
  }

  async prepareTurn(
    transcript: ChatMessage[],
    scratchpad: ScratchpadView,
    tools: ToolSchema[],
    signal?: AbortSignal,
    evidenceView?: EvidenceView,
  ): Promise<PreparedModelTurn> {
    if (this.state.taskFocus && evidenceView?.reads?.length) {
      this.state.taskFocus.reads = evidenceView.reads.slice(-16);
    }
    // 收集本次 prepareTurn 期间（压缩摘要）产生的预算决策，随结果交回 Runtime。
    this.prepareBudgetDecisions = [];
    // v1.10：scratchpad 视图只承载"进度/防重复"信号（不含工具结果——那些在
    // transcript 里，压缩时由摘要承载）。预算从 10%/8K 收紧到 3%/2K 作为兜底。
    const maxScratchpadTokens = Math.max(
      256,
      Math.min(2_000, Math.floor(this.modelContext.maxInputTokens * 0.03)),
    );
    const boundedScratchpad = renderBoundedScratchpadView(scratchpad, {
      includeTask: !this.state.taskFocus,
    });
    const inheritedReads = this.state.taskFocus?.reads;
    const taskText = this.state.taskFocus
      ? this.truncateToTokens(
          renderTaskFocus(this.state.taskFocus),
          Math.floor(maxScratchpadTokens / 2),
        )
      : '';
    const evidenceText = [
      taskText,
      this.evidenceViewText(
        {
          checks: evidenceView?.checks ?? [],
          reads: evidenceView?.reads?.length ? evidenceView.reads : inheritedReads,
        },
        Math.max(0, maxScratchpadTokens - estimateTextTokens(taskText)),
      ),
    ]
      .filter(Boolean)
      .join('\n');
    // 在已有执行上下文预算中分配证据视图，不放宽 compaction 的校准边界。
    const scratchpadText = this.truncateToTokens(
      boundedScratchpad.text,
      Math.max(0, maxScratchpadTokens - estimateTextTokens(evidenceText)),
    );
    // 计划投影与本轮视图共用同一份文本：预算计量必须和实际注入的是同一个字符串。
    const planText = this.planViewText();
    let modelView = this.buildModelView(transcript);
    // 压力不足时保留正文；达到现有压缩线后才先做免费投影，再判断是否需要摘要。
    // 压力使用投影前视图估算，避免一次投影降压后下一轮又把正文恢复而抖动前缀。
    let projection = this.projectToolResults(modelView, tools);
    modelView = projection.messages;
    let processed = this.contextManager.process(modelView, tools);
    let compaction: ContextCompactionResult | undefined;

    const thresholds = resolveCompactionThresholds(
      this.compactionPolicy,
      this.modelContext.maxInputTokens,
    );
    const triggerTokens = thresholds.trigger;
    const targetTokens = thresholds.retain;
    // 触发判断必须用修剪前的原始估值：修剪本身会把估值压到阈值附近，
    // system 消息变大一点点就会让修剪后估值恰好落到触发线下，摘要永不发生。
    const preTrimEstimated = processed.usage.beforeMessageTokens + processed.usage.toolSchemaTokens;
    if (preTrimEstimated > triggerTokens) {
      const compacted = await this.compactConversation(transcript, tools, targetTokens, signal);
      if (compacted) {
        compaction = {
          summarizedMessages: compacted.summarizedMessages,
          totalSummarizedMessages: compacted.totalSummarizedMessages,
          summaryTokens: compacted.summaryTokens,
          sourceTokens: compacted.sourceTokens,
          cacheAligned: compacted.cacheAligned,
        };
        // 压缩后重建视图：必须与 compactConversation 用同一套投影策略，否则
        // 这里的估值会和"摘要依据的那份视图"不一致。
        projection = this.projectToolResults(this.buildModelView(transcript), tools);
        modelView = projection.messages;
        processed = this.contextManager.process(modelView, tools);
      }
      // 摘要失败或无可压缩历史 → 保留确定性轮边界裁剪结果（fail-soft）；
      // 强制上下文仍通过 overBudget fail-closed。

      // v1.6 紧急兜底：轮边界压缩处理不了"单任务长执行"——全部工具交互都在
      // 当前任务轮内，历史轮裁剪触不到。仍超预算时进入紧急确定性裁剪：
      // system + summary + 当前轮内保留最近交互（从最旧逐条丢弃），视图必然
      // 有界。canonical transcript 不受影响；resume 走同一条确定性路径。
      // 仅在极端情况（最近 2 条消息本身就超预算）才保留 overBudget 交给
      // 调用方 fail-closed。
      if (processed.usage.overBudget) {
        const emergencyTarget = Math.floor(this.modelContext.maxInputTokens * 0.85);
        processed = this.contextManager.process(processed.messages, tools, emergencyTarget, {
          trimCurrentTurn: true,
        });
      }
    }
    // v2.5 稳定前缀：动态上下文（计划/scratchpad/摘要/提醒）在裁剪与压缩全部
    // 完成后追加到视图末尾，不进裁剪路径（见 dynamicContextMessage）。
    // 其 tokens 仍计入真实预算估算，保证 overBudget / usageRatio 不失真。
    const contextMessage = this.dynamicContextMessage(planText, scratchpadText, evidenceText);
    if (contextMessage) {
      const tail = processed.messages.at(-1);
      // 工具续传时，观察提示跟随工具结果，不伪造一次新的用户提问。
      // 只改临时模型视图；canonical 工具结果和 tool_call_id 保持原样。
      const continuation = tail?.role === 'tool';
      const merged = continuation
        ? { ...tail, content: `${tail.content}\n\n${contextMessage.content}` }
        : contextMessage;
      const contextTokens =
        this.contextManager.estimateMessageTokens(merged) -
        (continuation ? this.contextManager.estimateMessageTokens(tail) : 0);
      const estimated = processed.usage.estimatedInputTokens + contextTokens;
      if (continuation) processed.messages[processed.messages.length - 1] = merged;
      else processed.messages.push(contextMessage);
      processed.usage = {
        ...processed.usage,
        afterMessages: processed.usage.afterMessages + (continuation ? 0 : 1),
        messageTokens: processed.usage.messageTokens + contextTokens,
        estimatedInputTokens: estimated,
        usageRatio: Number((estimated / this.modelContext.maxInputTokens).toFixed(4)),
        overBudget: estimated > this.modelContext.maxInputTokens,
      };
    }

    return {
      messages: processed.messages,
      usage: processed.usage,
      scratchpadTokens: estimateTextTokens(scratchpadText),
      scratchpadTruncated: boundedScratchpad.truncated || scratchpadText !== boundedScratchpad.text,
      planTokens: estimateTextTokens(planText),
      compaction,
      toolProjection: {
        projectedCount: projection.projectedCount,
        savedBytes: projection.savedBytes,
        unprojectedInputTokens: projection.unprojectedInputTokens,
      },
      ...(this.prepareBudgetDecisions.length > 0
        ? { budgetDecisions: this.prepareBudgetDecisions }
        : {}),
    };
  }

  /**
   * 对 transcript 立即执行一次轮边界压缩（/compact 命令的同步路径，与
   * prepareTurn 的阈值路径共用同一套逻辑）：把最旧的完整历史轮摘要进
   * conversationSummary 并推进 summarizedMessageCount。canonical transcript
   * 不改写——视图裁剪发生在 buildModelView，摘要即"逻辑删除"。
   * @returns 压缩明细；无可压缩历史或摘要失败返回 null（状态不被改写）。
   */
  async compactConversation(
    transcript: ChatMessage[],
    tools: ToolSchema[],
    targetTokens?: number,
    signal?: AbortSignal,
  ): Promise<{
    summarizedMessages: number;
    totalSummarizedMessages: number;
    summaryTokens: number;
    compactedTokens: number;
    /** 被压掉的原文 token 量（与 summaryTokens 一起给出压缩比，可审计）。 */
    sourceTokens: number;
    /** 摘要请求是否复用了上一请求的真前缀走 KV 缓存快路径。 */
    cacheAligned: boolean;
  } | null> {
    // P2-D：未显式指定目标时用策略算出的保留量（不再写死 0.65，那等于没压）。
    const effectiveTarget =
      targetTokens ??
      resolveCompactionThresholds(this.compactionPolicy, this.modelContext.maxInputTokens).retain;
    // P2-C 一致性：裁剪必须发生在**和主请求同一份**视图上（投影之后）。否则这里
    // 按未投影的体积裁，会多裁掉一批本可保留的消息——摘要是有损的，多裁即多丢。
    const modelView = this.projectToolResults(this.buildModelView(transcript), tools).messages;
    const compacted = this.contextManager.process(modelView, tools, effectiveTarget);
    const removedCount = compacted.usage.trimmedMessages;
    if (removedCount <= 0) return null;
    // 被裁掉的正是 modelView 里 system 之后最前面的 removedCount 条，与 canonical
    // transcript 的同一区间一一对应；取**投影后**的版本喂摘要器：既与主请求前缀
    // 逐字节一致（E2 复用 KV 缓存），也不会把刚投影掉的内容又塞回摘要请求。
    const viewSystemIndex = modelView.findIndex((message) => message.role === 'system');
    const viewStart = viewSystemIndex >= 0 ? viewSystemIndex + 1 : 0;
    const removedMessages = modelView.slice(viewStart, viewStart + removedCount);
    const sourceTokens = this.contextManager.estimateTokens(removedMessages);
    const maxSummaryTokens = Math.max(
      128,
      Math.min(4_096, Math.floor(this.modelContext.maxInputTokens * 0.08)),
    );
    // 摘要请求的尝试次数：成功走返回值，失败走 onModelCall 回调——
    // 两条路都要入账，否则 summarize 抛错时这次模型调用从预算里消失。
    let summaryAttempts = 0;
    try {
      const cacheAligned = removedMessages[0]?.role !== 'tool' && removedMessages.length > 0;
      const summary = await this.summarizer.summarize({
        previousSummary: this.state.conversationSummary,
        messages: removedMessages,
        maxSummaryTokens,
        signal,
        // P2-E：复现上一请求的真前缀（system + tools + 被压缩区域）。
        prefix: cacheAligned ? { system: this.systemPromptText(), tools } : undefined,
        onModelCall: () => {
          summaryAttempts += 1;
        },
      });
      // 全部模型请求统一计量：摘要调用计入执行预算（含内部重试与真实输出 token）。
      this.advanceBudgetForPrepare({
        modelCalls: Math.max(summaryAttempts, summary.modelCalls),
        outputTokens: summary.outputTokens,
        activeMs: 0,
      });
      const nextSummary = summary.summary;
      if (!nextSummary.trim()) return null;
      const summaryText = this.truncateToTokens(nextSummary.trim(), maxSummaryTokens);
      const summaryTokens = estimateTextTokens(summaryText);
      // P2-E 校验（fail-soft）：摘要必须**比原文短**，否则压了等于没压、甚至更糟。
      // 不动任何状态，返回 null——调用方保持现状（宁可这次不压，也不写一份更贵的摘要）。
      //
      // 可达性说明（别误以为是死代码）：当前策略不变式下它**不可达**——
      // 被压掉的原文 ≥ 带宽 ≥ trigger/2，而 maxSummaryTokens ≤ maxInputTokens×0.08
      // （上限 4096），恒有 trigger/2 > maxSummaryTokens。留作不变量断言：一旦将来
      // 有人调大摘要预算或引入"小步压缩"，它会立刻变成真正的防线。
      if (summaryTokens >= sourceTokens) return null;
      this.state.conversationSummary = summaryText;
      this.state.summarizedMessageCount += removedCount;
      return {
        summarizedMessages: removedCount,
        totalSummarizedMessages: this.state.summarizedMessageCount,
        summaryTokens,
        compactedTokens: sourceTokens,
        sourceTokens,
        cacheAligned,
      };
    } catch {
      // Summary is an optimization：摘要失败不改写状态，调用方保持现状。
      // 但请求已经发生：至少一次尝试必须计入预算（失败路径不漏账）。
      this.advanceBudgetForPrepare({
        modelCalls: Math.max(1, summaryAttempts),
        outputTokens: 0,
        activeMs: 0,
      });
      return null;
    }
  }

  /** 估算当前 transcript 的模型视图输入占用（/compact 完成后即时刷新占用率用）。 */
  estimateViewUsage(transcript: ChatMessage[], _tools: ToolSchema[]) {
    return this.contextManager.process(this.buildModelView(transcript)).usage;
  }

  sanitizeAssistantMessage(message: ChatMessage): ChatMessage {
    const { reasoning_content: _reasoning, providerContinuation, ...historyMessage } = message;
    return {
      ...historyMessage,
      content: stripThink(historyMessage.content),
      ...(message.tool_calls?.length && providerContinuation ? { providerContinuation } : {}),
    };
  }

  sanitizeFinalAnswer(text: string): string {
    return stripThink(text);
  }

  // v1.8：空回合恢复策略。默认提示明确要求"要么调工具、要么给出完整回答"，
  // 并给出有限次数（2 次）——超过次数由 Runtime 落 failed，而不是静默完成。
  emptyTurnPolicy(observation?: EmptyTurnObservation): EmptyTurnPolicy {
    const facts = observation
      ? ` The call took ${Math.round(observation.durationMs / 1000)} seconds` +
        (observation.outputTokens === undefined
          ? ''
          : ` and used ${observation.outputTokens} output tokens`) +
        '.'
      : '';
    const cause =
      observation?.stopReason === 'length'
        ? ' The provider reported the output limit was reached before a visible action or answer.'
        : '';
    return {
      nudge:
        'Your previous turn produced no visible content: no tool call and an empty answer.' +
        facts +
        cause +
        ' Earlier tool results remain available. Reuse established evidence instead of restarting research; ' +
        'consider a small actionable tool call rather than solving the whole task in one generation. ' +
        'If the requested work is already complete or blocked, give a concise user-facing answer.',
      maxRecoveries: 2,
    };
  }

  incompleteTurnPolicy(_answer: string): IncompleteTurnPolicy | undefined {
    // 回复措辞不是完成度证据；工作流建议只在提示词中提供，不做关键词收尾拦截。
    return undefined;
  }
}
