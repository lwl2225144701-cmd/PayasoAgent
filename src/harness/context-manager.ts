import type { ChatMessage, ToolSchema } from "../llm/llm.js";
import { estimateJsonTokens } from "./model-context.js";

const DEFAULT_MAX_INPUT_TOKENS = 24_000;

export interface ContextUsage {
  beforeMessages: number;
  afterMessages: number;
  beforeMessageTokens: number;
  messageTokens: number;
  toolSchemaTokens: number;
  estimatedInputTokens: number;
  inputBudgetTokens: number;
  usageRatio: number;
  trimmedMessages: number;
  overBudget: boolean;
}

// Historical messages are removed as complete conversation turns. A user
// message and everything until the next user message remain atomic.
function groupConversationTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

export class ContextManager {
  constructor(private readonly maxInputTokens: number = DEFAULT_MAX_INPUT_TOKENS) {}

  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, message) => sum + estimateJsonTokens(message) + 4, 0);
  }

  // Preserve the system message and the entire current turn. Only complete
  // historical turns before the latest user task may be trimmed.
  trimMessages(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
    if (this.estimateTokens(messages) <= maxTokens) return messages;

    const system = messages.find((message) => message.role === "system");
    let lastUserIndex = -1;
    for (let index = 0; index < messages.length; index++) {
      if (messages[index].role === "user") lastUserIndex = index;
    }

    const historyStart = system ? messages.indexOf(system) + 1 : 0;
    const historyEnd = lastUserIndex >= 0 ? lastUserIndex : messages.length;
    const historicalTurns = groupConversationTurns(messages.slice(historyStart, historyEnd));
    const currentTurn = lastUserIndex >= 0 ? messages.slice(lastUserIndex) : [];

    let keepFrom = 0;
    const rebuild = (): ChatMessage[] => [
      ...(system ? [system] : []),
      ...historicalTurns.slice(keepFrom).flat(),
      ...currentTurn,
    ];
    while (this.estimateTokens(rebuild()) > maxTokens && keepFrom < historicalTurns.length) {
      keepFrom++;
    }
    return rebuild();
  }

  process(messages: ChatMessage[], tools: ToolSchema[] = []): {
    messages: ChatMessage[];
    usage: ContextUsage;
  } {
    const beforeMessages = messages.length;
    const beforeMessageTokens = this.estimateTokens(messages);
    const toolSchemaTokens = estimateJsonTokens(tools);
    const messageBudget = Math.max(0, this.maxInputTokens - toolSchemaTokens);
    const trimmed = this.trimMessages(messages, messageBudget);
    const messageTokens = this.estimateTokens(trimmed);
    const estimatedInputTokens = messageTokens + toolSchemaTokens;
    return {
      messages: trimmed,
      usage: {
        beforeMessages,
        afterMessages: trimmed.length,
        beforeMessageTokens,
        messageTokens,
        toolSchemaTokens,
        estimatedInputTokens,
        inputBudgetTokens: this.maxInputTokens,
        usageRatio: Number((estimatedInputTokens / this.maxInputTokens).toFixed(4)),
        trimmedMessages: beforeMessages - trimmed.length,
        overBudget: estimatedInputTokens > this.maxInputTokens,
      },
    };
  }
}
