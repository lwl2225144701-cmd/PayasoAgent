import type { ChatMessage, MessageImage, ModelConfig, ToolSchema } from '../llm/llm.js';
import { getNetworkMode } from '../network-mode.js';
import type { PermissionMode } from '../permission-mode.js';
import type { RuntimeToolchainCapabilities } from '../sandbox/toolchain-manager.js';
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
import { renderBoundedScratchpadView, type ScratchpadView } from './scratchpad-view.js';

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

export interface PreparedModelTurn {
  messages: ChatMessage[];
  usage: ContextUsage;
  scratchpadTokens: number;
  scratchpadTruncated: boolean;
  compaction?: ContextCompactionResult;
}

export interface AgentContextHarness {
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
}

function stripThink(text: string): string {
  let output = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  if (output.includes('<think>')) output = output.split('<think>')[0];
  return output.trim();
}

export class DefaultContextHarness implements AgentContextHarness {
  readonly modelContext: ModelContextConfig;
  private readonly contextManager: ContextManager;
  private readonly composer: InstructionComposer;
  private toolchain: RuntimeToolchainCapabilities | undefined;
  private readonly summarizer: ConversationSummarizer;
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
  }) {
    const resolvedContext =
      options.modelContext ??
      resolveModelContextConfig({
        model: options.modelConfig?.model ?? options.model,
        // 模型设置按模型配置的能力覆盖优先于内置注册表
        contextWindowTokens: options.modelConfig?.contextWindow,
        maxOutputTokens: options.modelConfig?.maxOutputTokens,
      });
    this.modelContext = resolvedContext;
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
        content: task,
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

  // 动态段每轮刷新：网络模式、工具链能力、环境信息在下一轮 system 消息
  // 中保持准确。scratchpad 和 summary 通过 buildModelView 追加到 system 末尾。
  private systemPromptText(): string {
    // Refresh dynamic segment contents before composing.
    this.composer.updateContent('platform.toolchain', toolchainSystemPrompt(this.toolchain));
    this.composer.updateContent('platform.network', networkSystemPrompt(getNetworkMode()));
    this.composer.updateContent('env.context', envContextPrompt());
    // Budget target: 15% of maxInputTokens for system prompt overhead.
    const systemBudget = Math.max(512, Math.floor(this.modelContext.maxInputTokens * 0.15));
    return this.composer.compose(systemBudget).content;
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

  private buildModelView(transcript: ChatMessage[], scratchpadText: string): ChatMessage[] {
    const modelView = transcript.map((message) => ({ ...message }));
    const systemIndex = modelView.findIndex((message) => message.role === 'system');
    const summaryText = this.state.conversationSummary
      ? `\n\n[Conversation Summary]\n${this.state.conversationSummary}`
      : '';
    const systemMessage: ChatMessage = {
      role: 'system',
      content: `${this.systemPromptText()}\n\n${scratchpadText}${summaryText}`,
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
    return modelView;
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
    let modelView = this.buildModelView(transcript, scratchpadText);
    let processed = this.contextManager.process(modelView, tools);
    let compaction: ContextCompactionResult | undefined;

    const triggerTokens = Math.floor(this.modelContext.maxInputTokens * 0.8);
    const targetTokens = Math.floor(this.modelContext.maxInputTokens * 0.65);
    // 触发判断必须用修剪前的原始估值：修剪本身会把估值压到阈值附近，
    // system 消息变大一点点就会让修剪后估值恰好落到触发线下，摘要永不发生。
    const preTrimEstimated = processed.usage.beforeMessageTokens + processed.usage.toolSchemaTokens;
    if (preTrimEstimated > triggerTokens) {
      const compacted = await this.compactConversation(
        transcript,
        tools,
        targetTokens,
        signal,
        scratchpadText,
      );
      if (compacted) {
        compaction = {
          summarizedMessages: compacted.summarizedMessages,
          totalSummarizedMessages: compacted.totalSummarizedMessages,
          summaryTokens: compacted.summaryTokens,
        };
        modelView = this.buildModelView(transcript, scratchpadText);
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
    return {
      messages: processed.messages,
      usage: processed.usage,
      scratchpadTokens: estimateTextTokens(scratchpadText),
      scratchpadTruncated: boundedScratchpad.truncated || scratchpadText !== boundedScratchpad.text,
      compaction,
    };
  }

  /**
   * 对 transcript 立即执行一次轮边界压缩（/compact 命令的同步路径，与
   * prepareTurn 的阈值路径共用同一套逻辑）：把最旧的完整历史轮摘要进
   * conversationSummary 并推进 summarizedMessageCount。canonical transcript
   * 不改写——视图裁剪发生在 buildModelView，摘要即"逻辑删除"。
   * @param scratchpadText - 模型视图的 Scratchpad 文本；独立压缩传空串（仅影响 sizing）。
   * @returns 压缩明细；无可压缩历史或摘要失败返回 null（状态不被改写）。
   */
  async compactConversation(
    transcript: ChatMessage[],
    tools: ToolSchema[],
    targetTokens?: number,
    signal?: AbortSignal,
    scratchpadText = '',
  ): Promise<{
    summarizedMessages: number;
    totalSummarizedMessages: number;
    summaryTokens: number;
    compactedTokens: number;
  } | null> {
    const effectiveTarget = targetTokens ?? Math.floor(this.modelContext.maxInputTokens * 0.65);
    const modelView = this.buildModelView(transcript, scratchpadText);
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
  estimateViewUsage(transcript: ChatMessage[], tools: ToolSchema[]) {
    return this.contextManager.process(this.buildModelView(transcript, '')).usage;
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
}
