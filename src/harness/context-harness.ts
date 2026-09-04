import type { ChatMessage, ModelConfig, ToolSchema } from "../llm/llm.js";
import type { PermissionMode } from "../permission-mode.js";
import { ContextManager, type ContextUsage } from "./context-manager.js";
import { BASE_SYSTEM_PROMPT, networkSystemPrompt, permissionSystemPrompt } from "./instructions.js";
import { getNetworkMode } from "../network-mode.js";
import {
  estimateTextTokens,
  resolveModelContextConfig,
  type ModelContextConfig,
} from "./model-context.js";
import { renderBoundedScratchpadView, type ScratchpadView } from "./scratchpad-view.js";
import {
  createContextHarnessState,
  normalizeContextHarnessState,
  type ContextHarnessState,
} from "./context-state.js";
import {
  LlmConversationSummarizer,
  type ConversationSummarizer,
} from "./conversation-summarizer.js";

export interface ContextCompactionResult {
  summarizedMessages: number;
  totalSummarizedMessages: number;
  summaryTokens: number;
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
  createTranscript(task: string, history?: ChatMessage[]): ChatMessage[];
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
}

function stripThink(text: string): string {
  let output = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (output.includes("<think>")) output = output.split("<think>")[0];
  return output.trim();
}

export class DefaultContextHarness implements AgentContextHarness {
  readonly modelContext: ModelContextConfig;
  private readonly contextManager: ContextManager;
  private readonly systemInstructions: string;
  private readonly summarizer: ConversationSummarizer;
  private state = createContextHarnessState();

  constructor(options: {
    permissionMode: PermissionMode;
    model?: string;
    modelConfig?: ModelConfig;
    summarizer?: ConversationSummarizer;
    state?: ContextHarnessState;
    modelContext?: ModelContextConfig;
  }) {
    this.modelContext = options.modelContext
      ?? resolveModelContextConfig({ model: options.modelConfig?.model ?? options.model });
    this.contextManager = new ContextManager(this.modelContext.maxInputTokens);
    this.systemInstructions = `${BASE_SYSTEM_PROMPT}\n${permissionSystemPrompt(options.permissionMode)}`;
    this.summarizer = options.summarizer ?? new LlmConversationSummarizer(options.modelConfig);
    this.restoreState(options.state);
  }

  createTranscript(task: string, history: ChatMessage[] = []): ChatMessage[] {
    const conversation = history
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content } as ChatMessage));
    return [
      { role: "system", content: this.systemPromptText() },
      ...conversation,
      { role: "user", content: task },
    ];
  }

  restoreState(state: ContextHarnessState | undefined): void {
    this.state = normalizeContextHarnessState(state);
  }

  // 网络段按当前全局模式动态拼装：运行中切全局开关后，下一轮 system 消息即准确
  private systemPromptText(): string {
    return `${this.systemInstructions}\n${networkSystemPrompt(getNetworkMode())}`;
  }

  snapshotState(): ContextHarnessState {
    return structuredClone(this.state);
  }

  private truncateToTokens(text: string, maxTokens: number): string {
    if (estimateTextTokens(text) <= maxTokens) return text;
    const marker = "\n…[truncated]";
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
    const systemIndex = modelView.findIndex((message) => message.role === "system");
    const summaryText = this.state.conversationSummary
      ? `\n\n[Conversation Summary]\n${this.state.conversationSummary}`
      : "";
    const systemMessage: ChatMessage = {
      role: "system",
      content: `${this.systemPromptText()}\n\n${scratchpadText}${summaryText}`,
    };
    if (systemIndex >= 0) {
      const maxSummarizable = Math.max(0, modelView.map((message) => message.role).lastIndexOf("user") - systemIndex - 1);
      this.state.summarizedMessageCount = Math.min(
        this.state.summarizedMessageCount,
        maxSummarizable,
      );
      modelView.splice(
        systemIndex,
        1 + this.state.summarizedMessageCount,
        systemMessage,
      );
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
    const maxScratchpadTokens = Math.max(256, Math.min(8_000, Math.floor(this.modelContext.maxInputTokens * 0.1)));
    const boundedScratchpad = renderBoundedScratchpadView(scratchpad);
    const scratchpadText = this.truncateToTokens(boundedScratchpad.text, maxScratchpadTokens);
    let modelView = this.buildModelView(transcript, scratchpadText);
    let processed = this.contextManager.process(modelView, tools);
    let compaction: ContextCompactionResult | undefined;

    const triggerTokens = Math.floor(this.modelContext.maxInputTokens * 0.8);
    const targetTokens = Math.floor(this.modelContext.maxInputTokens * 0.65);
    // 触发判断必须用修剪前的原始估值：修剪本身会把估值压到阈值附近，
    // system 消息变大一点点就会让修剪后估值恰好落到触发线下，摘要永不发生。
    const preTrimEstimated =
      processed.usage.beforeMessageTokens + processed.usage.toolSchemaTokens;
    if (preTrimEstimated > triggerTokens) {
      const compacted = this.contextManager.process(modelView, tools, targetTokens);
      const removedCount = compacted.usage.trimmedMessages;
      if (removedCount > 0) {
        const systemIndex = transcript.findIndex((message) => message.role === "system");
        const start = (systemIndex >= 0 ? systemIndex + 1 : 0) + this.state.summarizedMessageCount;
        const removedMessages = transcript.slice(start, start + removedCount);
        const maxSummaryTokens = Math.max(128, Math.min(4_096, Math.floor(this.modelContext.maxInputTokens * 0.08)));
        try {
          const nextSummary = await this.summarizer.summarize({
            previousSummary: this.state.conversationSummary,
            messages: removedMessages,
            maxSummaryTokens,
            signal,
          });
          if (nextSummary.trim()) {
            this.state.conversationSummary = this.truncateToTokens(nextSummary.trim(), maxSummaryTokens);
            this.state.summarizedMessageCount += removedCount;
            modelView = this.buildModelView(transcript, scratchpadText);
            processed = this.contextManager.process(modelView, tools);
            compaction = {
              summarizedMessages: removedCount,
              totalSummarizedMessages: this.state.summarizedMessageCount,
              summaryTokens: estimateTextTokens(this.state.conversationSummary),
            };
          }
        } catch {
          // Summary is an optimization. Fall back to deterministic complete-turn
          // trimming; mandatory context still fails closed through overBudget.
          processed = this.contextManager.process(modelView, tools);
        }
      }
    }
    return {
      messages: processed.messages,
      usage: processed.usage,
      scratchpadTokens: estimateTextTokens(scratchpadText),
      scratchpadTruncated: boundedScratchpad.truncated
        || scratchpadText !== boundedScratchpad.text,
      compaction,
    };
  }

  sanitizeAssistantMessage(message: ChatMessage): ChatMessage {
    const { reasoning_content: _reasoning, ...historyMessage } = message;
    return { ...historyMessage, content: stripThink(historyMessage.content) };
  }

  sanitizeFinalAnswer(text: string): string {
    return stripThink(text);
  }
}
