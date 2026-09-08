// Run / Session 统计投影（借鉴 DSH session-stats 的纯折叠思路）：
// 把一个 Run 的持久化事件折叠成步数 / 调用数 / 耗时 / 用量，再按会话聚合。
// 纯函数、无副作用，host 端 REST 投影、web 顶栏展示、测试三方复用。
// 用量桶复用 src/llm/token-usage.ts 的校验（宁缺勿错），不重复实现。

import { isValidTokenUsage, type TokenUsage } from '../llm/token-usage.js';
import type { HostEvent } from './run-events.js';

/** 单个 Run 的统计。 */
export interface RunStats {
  /** 出现的不同执行步数（llm_call / tool_call / tool_result 的 step 去重）。 */
  steps: number;
  llmCalls: number;
  toolCalls: number;
  /** 工具执行耗时合计（tool_result.durationMs）。 */
  toolMs: number;
  /** 首 token 延迟（run_started → 首个增量），无增量/无起点时缺省。 */
  ttftMs?: number;
  /** 解码耗时（首增量 → 末增量），不足两个增量时缺省。 */
  decodeMs?: number;
  /** 有效用量 totalTokens 合计（旧记录仅 totalTokens 也计入）。 */
  tokens: number;
  /** 运行时长（run_started → 终态事件；缺事件时由 createdAt/updatedAt 兜底）。 */
  durationMs: number;
}

/** 整个会话的聚合统计。 */
export interface SessionStats {
  turns: number;
  steps: number;
  llmCalls: number;
  toolCalls: number;
  toolMs: number;
  /** 各 Run 首 token 延迟之和；配合 ttftCount 取平均。 */
  ttftMs: number;
  /** 有首 token 记录的 Run 数。 */
  ttftCount: number;
  /** 各 Run 解码耗时之和。 */
  decodeMs: number;
  /** 有解码耗时的 Run 数。 */
  decodeCount: number;
  tokens: number;
  /** 各 Run 运行时长之和（活跃时长口径）。 */
  durationMs: number;
}

const TERMINAL_TYPES = new Set(['run_completed', 'run_failed', 'run_stopped', 'run_interrupted']);

/**
 * 提取一次 llm_call 的可用用量（与前端 deriveRunTokenUsage 的 contribution 同构）：
 * 新分桶记录过完整校验；旧记录（仅 totalTokens）只做非负整数校验。
 */
function eventUsageTokens(usage: TokenUsage | undefined): number | undefined {
  if (usage === null || typeof usage !== 'object') return undefined;
  if (!('inputTokens' in usage)) {
    const total = (usage as { totalTokens?: number }).totalTokens;
    return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0
      ? total
      : undefined;
  }
  if (!isValidTokenUsage(usage)) return undefined;
  return (
    usage.totalTokens ??
    usage.inputTokens +
      usage.outputTokens +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0)
  );
}

/**
 * 折叠一个 Run 的持久化事件为统计（Reducer 折叠）。
 * 步骤以去重 step 计数（生命周期权威：一次执行 = 一个 step），用量只累计
 * 通过校验的 llm_call（宁缺勿错），旧记录（仅 totalTokens）也兼容计入。
 */
export function deriveRunStats(
  events: HostEvent[],
  fallbackStart?: string,
  fallbackEnd?: string,
): RunStats {
  let llmCalls = 0;
  let toolCalls = 0;
  let toolMs = 0;
  let tokens = 0;
  let startMs = Number.NaN;
  let endMs = Number.NaN;
  let firstDeltaMs: number | undefined;
  let lastDeltaMs: number | undefined;
  const steps = new Set<number>();

  for (const event of events) {
    const step = (event as { step?: number }).step;
    switch (event.type) {
      case 'llm_call':
        llmCalls++;
        if (step !== undefined) steps.add(step);
        {
          const callTokens = eventUsageTokens(event.usage);
          if (callTokens !== undefined) tokens += callTokens;
        }
        break;
      case 'tool_call':
        toolCalls++;
        if (step !== undefined) steps.add(step);
        break;
      case 'tool_result':
        if (Number.isFinite(event.durationMs) && event.durationMs > 0) toolMs += event.durationMs;
        if (step !== undefined) steps.add(step);
        break;
      case 'run_started':
        startMs = Date.parse(event.timestamp);
        break;
      case 'assistant_delta':
      case 'reasoning_delta': {
        const t = Date.parse(event.timestamp);
        if (!Number.isFinite(t)) break;
        if (firstDeltaMs === undefined) firstDeltaMs = t;
        lastDeltaMs = t;
        break;
      }
      default:
        if (TERMINAL_TYPES.has(event.type)) endMs = Date.parse(event.timestamp);
    }
  }

  const start = Number.isFinite(startMs) ? startMs : Date.parse(fallbackStart ?? '');
  const end = Number.isFinite(endMs) ? endMs : Date.parse(fallbackEnd ?? '');
  const durationMs =
    Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
  const ttftMs =
    Number.isFinite(start) && firstDeltaMs !== undefined && firstDeltaMs >= start
      ? Math.max(0, firstDeltaMs - start)
      : undefined;
  const decodeMs =
    firstDeltaMs !== undefined && lastDeltaMs !== undefined && lastDeltaMs > firstDeltaMs
      ? lastDeltaMs - firstDeltaMs
      : undefined;

  return { steps: steps.size, llmCalls, toolCalls, toolMs, ttftMs, decodeMs, tokens, durationMs };
}

/** 把一个会话的全部 Run 统计聚合为 SessionStats（turns = 活跃 Run 数）。 */
export function aggregateSessionStats(stats: readonly RunStats[], turns: number): SessionStats {
  const total: SessionStats = {
    turns,
    steps: 0,
    llmCalls: 0,
    toolCalls: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftCount: 0,
    decodeMs: 0,
    decodeCount: 0,
    tokens: 0,
    durationMs: 0,
  };
  for (const stat of stats) {
    total.steps += stat.steps;
    total.llmCalls += stat.llmCalls;
    total.toolCalls += stat.toolCalls;
    total.toolMs += stat.toolMs;
    total.tokens += stat.tokens;
    total.durationMs += stat.durationMs;
    if (stat.ttftMs !== undefined) {
      total.ttftMs += stat.ttftMs;
      total.ttftCount++;
    }
    if (stat.decodeMs !== undefined) {
      total.decodeMs += stat.decodeMs;
      total.decodeCount++;
    }
  }
  return total;
}
