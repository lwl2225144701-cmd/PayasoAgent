import type { ChatMessage, ToolSchema } from "../llm/llm.js";
import type { PermissionMode } from "../permission-mode.js";
import { ContextManager, type ContextUsage } from "./context-manager.js";
import { BASE_SYSTEM_PROMPT, permissionSystemPrompt } from "./instructions.js";
import {
  estimateTextTokens,
  resolveModelContextConfig,
  type ModelContextConfig,
} from "./model-context.js";
import { renderScratchpadView, type ScratchpadView } from "./scratchpad-view.js";

export interface PreparedModelTurn {
  messages: ChatMessage[];
  usage: ContextUsage;
  scratchpadTokens: number;
}

export interface AgentContextHarness {
  readonly modelContext: ModelContextConfig;
  createTranscript(task: string, history?: ChatMessage[]): ChatMessage[];
  prepareTurn(transcript: ChatMessage[], scratchpad: ScratchpadView, tools: ToolSchema[]): PreparedModelTurn;
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

  constructor(options: { permissionMode: PermissionMode; model?: string }) {
    this.modelContext = resolveModelContextConfig({ model: options.model });
    this.contextManager = new ContextManager(this.modelContext.maxInputTokens);
    this.systemInstructions = `${BASE_SYSTEM_PROMPT}\n${permissionSystemPrompt(options.permissionMode)}`;
  }

  createTranscript(task: string, history: ChatMessage[] = []): ChatMessage[] {
    const conversation = history
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content } as ChatMessage));
    return [
      { role: "system", content: this.systemInstructions },
      ...conversation,
      { role: "user", content: task },
    ];
  }

  prepareTurn(transcript: ChatMessage[], scratchpad: ScratchpadView, tools: ToolSchema[]): PreparedModelTurn {
    const scratchpadText = renderScratchpadView(scratchpad);
    const modelView = transcript.map((message) => ({ ...message }));
    const systemIndex = modelView.findIndex((message) => message.role === "system");
    const systemMessage: ChatMessage = {
      role: "system",
      content: `${this.systemInstructions}\n\n${scratchpadText}`,
    };
    if (systemIndex >= 0) modelView[systemIndex] = systemMessage;
    else modelView.unshift(systemMessage);
    const processed = this.contextManager.process(modelView, tools);
    return {
      messages: processed.messages,
      usage: processed.usage,
      scratchpadTokens: estimateTextTokens(scratchpadText),
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
