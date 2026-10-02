import type { ChatMessage, MessageImage, ModelConfig, ToolSchema } from '../llm/llm.js';
import { getNetworkMode } from '../network-mode.js';
import type { PermissionMode } from '../permission-mode.js';
import type { RuntimeToolchainCapabilities } from '../sandbox/toolchain-manager.js';
import type { TaskConstraints } from '../task-constraints.js';
import {
  type CompactionPolicy,
  resolveCompactionPolicy,
  resolveCompactionThresholds,
} from './compaction-policy.js';
import { ContextManager, type ContextUsage } from './context-manager.js';
import {
  type ContextHarnessState,
  createContextHarnessState,
  normalizeContextHarnessState,
} from './context-state.js';
import {
  type ConversationSummarizer,
  LlmConversationSummarizer,
} from './conversation-summarizer.js';
import { type FinalReviewInput, reviewFinalAnswer } from './final-review.js';
import { InstructionComposer } from './instruction-composer.js';
import {
  buildBaseSegments,
  envContextPrompt,
  networkSystemPrompt,
  projectInstructionsPrompt,
  toolchainSystemPrompt,
} from './instructions.js';
import {
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
import { renderBoundedScratchpadView, type ScratchpadView } from './scratchpad-view.js';
import {
  type ProjectionPolicy,
  projectStaleToolOutputs,
  resolveProjectionPolicy,
} from './tool-output-projection.js';

export interface ContextCompactionResult {
  summarizedMessages: number;
  totalSummarizedMessages: number;
  summaryTokens: number;
}

/**
 * Model-facing policy for a turn that produced neither a tool call nor any
 * visible content. The Runtime owns the *invariant* (a run must never end
 * silently with an empty answer); the Harness owns the *words* and the budget.
 */
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
}

export interface AgentContextHarness {
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
  ): Promise<PreparedModelTurn>;
  restoreState(state: ContextHarnessState | undefined): void;
  snapshotState(): ContextHarnessState;
  // 只观察已结束的工具回合；触发后返回审计数据，由 Runtime 发事件并保存。
  observeToolTurn?(turn: ToolTurnProgress): ProgressReminder | undefined;
  // 模型成功响应后才消费待发送提醒；请求失败/取消时保留，供恢复后继续投影。
  acknowledgeProgressReminder?(): boolean;
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
  emptyTurnPolicy?(): EmptyTurnPolicy;
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
  private state = createContextHarnessState();

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
  }) {
    this.projectionPolicy = options.projection ?? resolveProjectionPolicy();
    this.compactionPolicy = options.compaction ?? resolveCompactionPolicy();
    this.progressReminderPolicy =
      options.progressReminder === false || process.env.PAYASO_PROGRESS_REMINDER === 'off'
        ? undefined
        : { ...DEFAULT_PROGRESS_REMINDER_POLICY, ...options.progressReminder };
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

  observeToolTurn(turn: ToolTurnProgress): ProgressReminder | undefined {
    if (!this.progressReminderPolicy) return undefined;
    const previous = normalizeProgressReminderState(this.state.progressReminder);
    const next = advanceProgressReminder(previous, turn, this.progressReminderPolicy);
    this.state.progressReminder = next;
    if (previous.reminder !== 'pending' && next.reminder === 'pending') {
      return { readOnlyTurns: next.readOnlyTurns, readOnlyMs: next.readOnlyMs };
    }
    return undefined;
  }

  acknowledgeProgressReminder(): boolean {
    if (!this.progressReminderPolicy || this.state.progressReminder?.reminder !== 'pending')
      return false;
    this.state.progressReminder.reminder = 'delivered';
    return true;
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
    const report = buildPlanReport(this.state.plan);
    if (report.unfinished.length === 0) return undefined;
    // 只在有 in_progress 项时提醒：那是"输出完了却显示进行中"的真实矛盾。
    // 只剩 pending（模型从没开始／有意跳过）不打扰——面板会如实显示"待办"，
    // 不值得为它多花一次 LLM 往返。
    const active = report.unfinished.filter((item) => item.status === 'in_progress');
    if (active.length === 0) return undefined;
    const lines = report.unfinished
      .map((item) => `  - ${item.title}（${item.status === 'in_progress' ? '进行中' : '待办'}）`)
      .join('\n');
    return {
      unfinished: report.unfinished.length,
      nudge:
        `你的任务计划里还有 ${report.unfinished.length} 项未完成，其中 ${active.length} 项标着"进行中"：\n${lines}\n` +
        '在给出最终答复前，先判断它们是否真的完成了：\n' +
        '- 若已完成：调用 updatePlan 把它们标为 completed，再收尾；\n' +
        '- 若确实没做完（放弃/改方案/受阻塞）：调用 updatePlan 如实收敛计划，' +
        '并在最终答复里说明原因。\n' +
        '不要留下进行中的项就结束。',
    };
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
  private dynamicContextMessage(planText: string, scratchpadText: string): ChatMessage | null {
    const summaryText = this.state.conversationSummary
      ? `[Conversation Summary]\n${this.state.conversationSummary}`
      : '';
    const reminderText = this.progressReminderPolicy
      ? renderProgressReminder(this.state.progressReminder)
      : '';
    const parts = [planText, scratchpadText, summaryText, reminderText]
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) return null;
    return { role: 'user', content: `[Context]\n${parts.join('\n\n')}` };
  }

  async prepareTurn(
    transcript: ChatMessage[],
    scratchpad: ScratchpadView,
    tools: ToolSchema[],
    signal?: AbortSignal,
  ): Promise<PreparedModelTurn> {
    // v1.10：scratchpad 视图只承载"进度/防重复"信号（不含工具结果——那些在
    // transcript 里，压缩时由摘要承载）。预算从 10%/8K 收紧到 3%/2K 作为兜底。
    const maxScratchpadTokens = Math.max(
      256,
      Math.min(2_000, Math.floor(this.modelContext.maxInputTokens * 0.03)),
    );
    const boundedScratchpad = renderBoundedScratchpadView(scratchpad);
    const scratchpadText = this.truncateToTokens(boundedScratchpad.text, maxScratchpadTokens);
    // 计划投影与本轮视图共用同一份文本：预算计量必须和实际注入的是同一个字符串。
    const planText = this.planViewText();
    let modelView = this.buildModelView(transcript);
    // P2-C 投影：在算预算之前，先把"已经变老"的工具结果做确定性降级（免费、
    // 零 LLM 调用）。放在这里有两个原因：
    //   1) 下面 process() 的估值与触发判断看到的都是投影**之后**的体积——
    //      投影省得够多时，昂贵的摘要根本不会发生（成本阶梯：免费的先上）；
    //   2) 它只改模型视图，canonical transcript 不动。
    const projection = projectStaleToolOutputs(modelView, this.projectionPolicy);
    if (projection.projectedCount > 0) modelView = projection.messages;
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
        };
        modelView = this.buildModelView(transcript);
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
    const contextMessage = this.dynamicContextMessage(planText, scratchpadText);
    if (contextMessage) {
      const contextTokens = this.contextManager.estimateMessageTokens(contextMessage);
      const estimated = processed.usage.estimatedInputTokens + contextTokens;
      processed.messages.push(contextMessage);
      processed.usage = {
        ...processed.usage,
        afterMessages: processed.usage.afterMessages + 1,
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
  } | null> {
    // P2-D：未显式指定目标时用策略算出的保留量（不再写死 0.65，那等于没压）。
    const effectiveTarget =
      targetTokens ??
      resolveCompactionThresholds(this.compactionPolicy, this.modelContext.maxInputTokens).retain;
    const modelView = this.buildModelView(transcript);
    const compacted = this.contextManager.process(modelView, tools, effectiveTarget);
    const removedCount = compacted.usage.trimmedMessages;
    if (removedCount <= 0) return null;
    const systemIndex = transcript.findIndex((message) => message.role === 'system');
    const start = (systemIndex >= 0 ? systemIndex + 1 : 0) + this.state.summarizedMessageCount;
    const removedMessages = transcript.slice(start, start + removedCount);
    const maxSummaryTokens = Math.max(
      128,
      Math.min(4_096, Math.floor(this.modelContext.maxInputTokens * 0.08)),
    );
    try {
      const nextSummary = await this.summarizer.summarize({
        previousSummary: this.state.conversationSummary,
        messages: removedMessages,
        maxSummaryTokens,
        signal,
      });
      if (!nextSummary.trim()) return null;
      this.state.conversationSummary = this.truncateToTokens(nextSummary.trim(), maxSummaryTokens);
      this.state.summarizedMessageCount += removedCount;
      return {
        summarizedMessages: removedCount,
        totalSummarizedMessages: this.state.summarizedMessageCount,
        summaryTokens: estimateTextTokens(this.state.conversationSummary),
        compactedTokens: this.contextManager.estimateTokens(removedMessages),
      };
    } catch {
      // Summary is an optimization：摘要失败不改写状态，调用方保持现状。
      return null;
    }
  }

  /** 估算当前 transcript 的模型视图输入占用（/compact 完成后即时刷新占用率用）。 */
  estimateViewUsage(transcript: ChatMessage[], _tools: ToolSchema[]) {
    return this.contextManager.process(this.buildModelView(transcript)).usage;
  }

  sanitizeAssistantMessage(message: ChatMessage): ChatMessage {
    const { reasoning_content: _reasoning, ...historyMessage } = message;
    return { ...historyMessage, content: stripThink(historyMessage.content) };
  }

  sanitizeFinalAnswer(text: string): string {
    return stripThink(text);
  }

  // v1.8：空回合恢复策略。默认提示明确要求"要么调工具、要么给出完整回答"，
  // 并给出有限次数（2 次）——超过次数由 Runtime 落 failed，而不是静默完成。
  emptyTurnPolicy(): EmptyTurnPolicy {
    return {
      nudge:
        'Your previous turn produced no visible content: no tool call and an empty answer. ' +
        'Continue the task now — either call a tool to make progress, or write the complete ' +
        'user-facing answer. Never end a turn with an empty message.',
      maxRecoveries: 2,
    };
  }

  incompleteTurnPolicy(answer: string): IncompleteTurnPolicy | undefined {
    // 仅匹配末尾独立的行动句。前文关键词、引用和代码示例不能作为重试依据。
    // 这是有界恢复启发式，不是任务完成度证明。
    const ending =
      answer
        .trim()
        .split(/\n|[。！？.!?]/u)
        .at(-1)
        ?.trim() ?? '';
    if (
      !/^(?:为了[^，,：:]{1,16}[，,]\s*)?(?:接下来|下一步|再确认|让我(?:再)?|我(?:将|会)|(?:I will|I'll|I’ll|Let me|Next)\b)/iu.test(
        ending,
      ) ||
      !/(?:检查|执行|验证|运行|抓取|对照|读取|确认|查看|扫描|比较|\b(?:check|verify|compare|run|read|inspect|fetch)\b)/iu.test(
        ending,
      ) ||
      !/[:：]$/u.test(ending)
    )
      return undefined;

    return {
      reason: 'assistant ended with an unfinished action statement',
      nudge:
        'Your previous turn described another action but did not call a tool. ' +
        'Continue only if that action is authorized and feasible. Otherwise provide the final ' +
        'answer with the result or blocker. Do not end with an unfinished promise.',
      maxRecoveries: 1,
    };
  }
}
