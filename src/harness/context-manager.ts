import type { ChatMessage, ToolSchema } from '../llm/llm.js';
import { estimateJsonTokens } from './model-context.js';

const DEFAULT_MAX_INPUT_TOKENS = 24_000;

// 单张图片的预算 token 数。主流多模态 API 按 tile 计费（低分辨率约 85，
// 高分辨率单图可达 ~1500）；取 1000 作为保守固定预算，保证图片轮不超支。
const IMAGE_BUDGET_TOKENS = 1000;

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
  // v1.6 紧急兜底标记：本轮视图触发了"当前任务轮内逐条丢弃"的紧急裁剪
  emergencyTrim?: boolean;
}

// Historical messages are removed as complete conversation turns. A user
// message and everything until the next user message remain atomic.
function groupConversationTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user' && current.length > 0) {
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
    return messages.reduce((sum, message) => {
      const imageCount = message.images?.length ?? 0;
      // 估算时剔除 base64 data（物化后的模型视图万一进入估算也不会被超大字符串
      // 撑爆）；图片按固定预算计费，路径引用本身的 JSON 开销可忽略。
      const estimateTarget =
        imageCount > 0
          ? { ...message, images: message.images!.map(() => ({ mimeType: 'image', path: '' })) }
          : message;
      return sum + estimateJsonTokens(estimateTarget) + 4 + imageCount * IMAGE_BUDGET_TOKENS;
    }, 0);
  }

  // Preserve the system message and the entire current turn. Only complete
  // historical turns before the latest user task may be trimmed.
  //
  // v1.6 紧急兜底（options.trimCurrentTurn）：单任务长执行的全部工具交互都在
  // "当前任务轮"内，轮边界裁剪对它无能为力。开启后允许在当前轮内从最旧开始
  // 逐条丢弃、保留最后 2 条（最近一次交互）——任务背景已由 system 内的
  // conversation summary 承载，视图必然有界。canonical transcript 不受影响。
  trimMessages(
    messages: ChatMessage[],
    maxTokens: number,
    options: { trimCurrentTurn?: boolean } = {},
  ): ChatMessage[] {
    if (this.estimateTokens(messages) <= maxTokens) return messages;

    const system = messages.find((message) => message.role === 'system');
    let lastUserIndex = -1;
    for (let index = 0; index < messages.length; index++) {
      if (messages[index].role === 'user') lastUserIndex = index;
    }

    const historyStart = system ? messages.indexOf(system) + 1 : 0;
    const historyEnd = lastUserIndex >= 0 ? lastUserIndex : messages.length;
    const historicalTurns = groupConversationTurns(messages.slice(historyStart, historyEnd));
    const currentTurn = lastUserIndex >= 0 ? messages.slice(lastUserIndex) : [];

    const assemble = (keepFrom: number, currentTurnFrom: number): ChatMessage[] => [
      ...(system ? [system] : []),
      ...historicalTurns.slice(keepFrom).flat(),
      ...currentTurn.slice(currentTurnFrom),
    ];

    let keepFrom = 0;
    while (this.estimateTokens(assemble(keepFrom, 0)) > maxTokens && keepFrom < historicalTurns.length) {
      keepFrom++;
    }
    let currentTurnFrom = 0;
    if (
      options.trimCurrentTurn
      && this.estimateTokens(assemble(keepFrom, 0)) > maxTokens
      && currentTurn.length > 0
    ) {
      // 分级兜底：先保留最近 2 条交互；仍超 → 保留最近 1 条 → 仍超则仅保留
      // system + summary（保证视图必然有界；任务背景由 summary 承载）。
      for (const keepLast of [2, 1, 0]) {
        currentTurnFrom = 0;
        const maxFrom = currentTurn.length - keepLast;
        while (
          this.estimateTokens(assemble(keepFrom, currentTurnFrom)) > maxTokens
          && currentTurnFrom < maxFrom
        ) {
          currentTurnFrom++;
        }
        if (this.estimateTokens(assemble(keepFrom, currentTurnFrom)) <= maxTokens) break;
      }
    }
    return assemble(keepFrom, currentTurnFrom);
  }

  process(
    messages: ChatMessage[],
    tools: ToolSchema[] = [],
    targetInputTokens = this.maxInputTokens,
    options: { trimCurrentTurn?: boolean } = {},
  ): {
    messages: ChatMessage[];
    usage: ContextUsage;
  } {
    const beforeMessages = messages.length;
    const beforeMessageTokens = this.estimateTokens(messages);
    const toolSchemaTokens = estimateJsonTokens(tools);
    const effectiveTarget = Math.min(this.maxInputTokens, Math.max(0, targetInputTokens));
    const messageBudget = Math.max(0, effectiveTarget - toolSchemaTokens);
    const trimmed = this.trimMessages(messages, messageBudget, options);
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
        emergencyTrim: options.trimCurrentTurn === true && beforeMessages !== trimmed.length,
      },
    };
  }
}
