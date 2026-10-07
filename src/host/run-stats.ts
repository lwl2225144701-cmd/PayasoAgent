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
  /** 未命中缓存的输入 token 合计（新分桶记录才有；旧记录为 0）。 */
  inputTokens: number;
  /** 模型输出 token 合计（吞吐率分子）。 */
  outputTokens: number;
  /** 命中前缀缓存的输入 token 合计。 */
  cacheReadTokens: number;
  /** 写入缓存的输入 token 合计。 */
  cacheWriteTokens: number;
  /**
   * **上报了缓存分桶**的 LLM 调用数。
   *
   * 缓存命中率的分母只能由这些调用构成：提供方没上报该桶时，"未命中"与"没数据"
   * 无从区分，把它当 0 会把命中率算成一个凭空的低值。0 表示压根没有可用数据，
   * 界面应当**不出数**（口径同 DSH：数据不自洽就整轮不出数）。
   */
  cacheUsageCalls: number;
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
  /** 未命中缓存的输入 token 合计。 */
  inputTokens: number;
  /** 模型输出 token 合计（吞吐率分子）。 */
  outputTokens: number;
  /** 命中前缀缓存的输入 token 合计。 */
  cacheReadTokens: number;
  /** 写入缓存的输入 token 合计。 */
  cacheWriteTokens: number;
  /** 上报了缓存分桶的 LLM 调用数（命中率分母的构成范围，同 RunStats）。 */
  cacheUsageCalls: number;
  /** 各 Run 运行时长之和（活跃时长口径）。 */
  durationMs: number;
}

const TERMINAL_TYPES = new Set(['run_completed', 'run_failed', 'run_stopped', 'run_interrupted']);

/**
 * 提取一次 llm_call 的可用用量并按桶拆开（与前端 deriveRunTokenUsage 的
 * contribution 同构）：新分桶记录过完整校验；旧记录（仅 totalTokens）只做
 * 非负整数校验，且**拆不出新增/缓存**——此时只计总量，分桶留 0（宁缺勿错，
 * 不能让历史数据把"缓存命中率"算成假的）。
 */
interface UsageSplit {
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 提供方是否**真的上报了**缓存分桶（缺失 ≠ 未命中）。 */
  cacheReported: boolean;
}

const ZERO_SPLIT = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheReported: false,
};

function splitEventUsage(usage: TokenUsage | undefined): UsageSplit | undefined {
  if (usage === null || typeof usage !== 'object') return undefined;
  if (!('inputTokens' in usage)) {
    const total = (usage as { totalTokens?: number }).totalTokens;
    return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0
      ? { total, ...ZERO_SPLIT }
      : undefined;
  }
  if (!isValidTokenUsage(usage)) return undefined;
  const { inputTokens, outputTokens } = usage;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  return {
    total: usage.totalTokens ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheReported: usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined,
  };
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
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheUsageCalls = 0;
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
          const split = splitEventUsage(event.usage);
          if (split !== undefined) {
            tokens += split.total;
            outputTokens += split.outputTokens;
            // 只有提供方上报了缓存分桶的调用才进入命中率口径：把"没上报"当成 0
            // 计进分母，会把命中率算成一个凭空的低值（实测见过 27% vs 实际 45%）。
            if (split.cacheReported) {
              cacheUsageCalls++;
              inputTokens += split.inputTokens;
              cacheReadTokens += split.cacheReadTokens;
              cacheWriteTokens += split.cacheWriteTokens;
            }
          }
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

  return {
    steps: steps.size,
    llmCalls,
    toolCalls,
    toolMs,
    ttftMs,
    decodeMs,
    tokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheUsageCalls,
    durationMs,
  };
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
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheUsageCalls: 0,
    durationMs: 0,
  };
  for (const stat of stats) {
    total.steps += stat.steps;
    total.llmCalls += stat.llmCalls;
    total.toolCalls += stat.toolCalls;
    total.toolMs += stat.toolMs;
    total.tokens += stat.tokens;
    total.inputTokens += stat.inputTokens;
    total.outputTokens += stat.outputTokens;
    total.cacheReadTokens += stat.cacheReadTokens;
    total.cacheWriteTokens += stat.cacheWriteTokens;
    total.cacheUsageCalls += stat.cacheUsageCalls;
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
