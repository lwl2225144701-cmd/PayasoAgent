// Context 模块 — 最小上下文管理（仅控制发送给 LLM 的消息规模，无 Memory / 无数据库）

import type { ChatMessage } from "../llm/llm.js";
import type { ToolSchema } from "../llm/llm.js";
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

// 将消息序列按"轮"分组：每个 assistant 及其后续 tool 归为一块
function groupByRound(msgs: ChatMessage[]): ChatMessage[][] {
  const blocks: ChatMessage[][] = [];
  let cur: ChatMessage[] | null = null;
  for (const m of msgs) {
    if (m.role === "assistant") {
      cur = [m];
      blocks.push(cur);
    } else if (m.role === "tool" && cur) {
      cur.push(m);
    } else {
      cur = [m];
      blocks.push(cur);
    }
  }
  return blocks;
}

export class ContextManager {
  private maxInputTokens: number;

  constructor(maxInputTokens: number = DEFAULT_MAX_INPUT_TOKENS) {
    this.maxInputTokens = maxInputTokens;
  }

  // Conservative estimate; a provider tokenizer can replace this later.
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, message) => sum + estimateJsonTokens(message) + 4, 0);
  }

  // 裁剪消息：保留 system + 最后一条 user(task) + 最近若干轮，删除最早轮
  trimMessages(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
    if (this.estimateTokens(messages) <= maxTokens) return messages;

    // 必须保留：system（第一条）、最后一条 user
    const sysIdx = messages.findIndex((m) => m.role === "system");
    const system = sysIdx >= 0 ? messages[sysIdx] : null;

    let lastUserIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "user") lastUserIdx = i;
    }
    const lastUser = lastUserIdx >= 0 ? messages[lastUserIdx] : null;

    // 其余消息（system 与 lastUser 之间、以及 lastUser 之后）按轮分组
    const middle: ChatMessage[] = [
      ...messages.slice(sysIdx + 1, lastUserIdx < 0 ? messages.length : lastUserIdx),
      ...(lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : []),
    ];
    const blocks = groupByRound(middle);

    // 从最早块开始丢弃，直到满足上限或块删光
    let keepFrom = 0;
    const rebuild = () =>
      [
        ...(system ? [system] : []),
        ...(lastUser ? [lastUser] : []),
        ...blocks.slice(keepFrom).flat(),
      ] as ChatMessage[];
    while (
      this.estimateTokens(rebuild()) > maxTokens &&
      keepFrom < blocks.length
    ) {
      keepFrom++;
    }
    return rebuild();
  }

  // 处理消息：返回裁剪后的消息及前后条数（用于 Trace）
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
