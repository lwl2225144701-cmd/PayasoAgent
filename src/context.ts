// Context 模块 — 最小上下文管理（仅控制发送给 LLM 的消息规模，无 Memory / 无数据库）

import type { ChatMessage } from "./llm.js";

// 默认上下文上限（粗略字符数估计，非真实 token 数）
const DEFAULT_MAX_LENGTH = 4000;

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
  private maxLength: number;

  constructor(maxLength: number = DEFAULT_MAX_LENGTH) {
    this.maxLength = maxLength;
  }

  // 粗略统计上下文大小（字符数）
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
  }

  // 裁剪消息：保留 system + 最后一条 user(task) + 最近若干轮，删除最早轮
  trimMessages(messages: ChatMessage[], maxLength: number): ChatMessage[] {
    if (this.estimateTokens(messages) <= maxLength) return messages;

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
      this.estimateTokens(rebuild()) > maxLength &&
      keepFrom < blocks.length
    ) {
      keepFrom++;
    }
    return rebuild();
  }

  // 处理消息：返回裁剪后的消息及前后条数（用于 Trace）
  process(messages: ChatMessage[]): {
    messages: ChatMessage[];
    before: number;
    after: number;
  } {
    const before = messages.length;
    const trimmed = this.trimMessages(messages, this.maxLength);
    return { messages: trimmed, before, after: trimmed.length };
  }
}
