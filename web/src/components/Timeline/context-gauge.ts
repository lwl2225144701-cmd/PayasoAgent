// 上下文预算环形指示器 + 轮末用量投影（v1.6/v1.7）：
// 纯函数与组件分离，便于 node 测试。所有折叠都是确定性纯函数，供
// RunUsage / ContextUsageRing / InputBar 环形与测试复用。

import type { ContextUsageEvent, HostEvent, TokenUsage } from '../../types';

// ---- 用量校验（镜像 host src/llm/token-usage.ts 的 isValidTokenUsage）----
// web 是独立 Vite 构建，不跨项目引用 host 源码；校验规则必须与 host 保持一致，
// 修改任一侧时需同步另一侧。

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 新记录（分桶形态）是否可用于展示/累加。 */
export function isValidTokenUsage(usage: TokenUsage | undefined): usage is TokenUsage {
  if (usage === undefined) return false;
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return false;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (!isCount(cacheRead) || !isCount(cacheWrite)) return false;
  const reasoning = usage.reasoningTokens;
  if (reasoning !== undefined && (!isCount(reasoning) || reasoning > usage.outputTokens)) {
    return false;
  }
  if (usage.totalTokens !== undefined) {
    if (!isCount(usage.totalTokens)) return false;
    if (usage.totalTokens < usage.inputTokens + cacheRead + cacheWrite + usage.outputTokens) {
      return false;
    }
  }
  return true;
}

/** 一次模型调用贡献的精确计量（分桶或旧记录 totalTokens 兼容）。 */
export interface RunTokenUsage {
  /** 总 token（totalTokens 口径；旧记录与新记录统一求和）。 */
  tokens: number;
  /** 未缓存输入（仅新分桶记录参与）。 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** 是否有分桶数据（新记录）——无则分项展示不可用。 */
  hasBuckets: boolean;
  /** 至少一条可用记录。 */
  available: boolean;
  /** 存在缺 usage / 无效记录的 llm_call。 */
  partial: boolean;
}

interface Contribution {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  buckets: boolean;
}

function contributionOf(usage: TokenUsage): Contribution | undefined {
  // 旧记录只有 { totalTokens }（无 inputTokens 字段）：仅能贡献总量，无法分桶。
  if (!('inputTokens' in usage)) {
    const totalTokens = (usage as { totalTokens?: number }).totalTokens;
    return isCount(totalTokens)
      ? {
          tokens: totalTokens,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          buckets: false,
        }
      : undefined;
  }
  if (!isValidTokenUsage(usage)) return undefined;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return {
    tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens + cacheRead + cacheWrite,
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead,
    cacheWrite,
    reasoning: usage.reasoningTokens ?? 0,
    buckets: true,
  };
}

/**
 * 把一个 Run 的全部 llm_call 折叠为精确用量（Reducer 折叠 + last-wins 状态）。
 *
 * - 同一 iteration 的重复 usage 采用 last-wins 替换（防流式重放/异常重发重复计数）；
 * - 新分桶记录校验失败视为缺失（宁缺勿错），旧记录（仅 totalTokens）兼容；
 * - 只统计持久化的 llm_call，绝不累计上下文估算或流式增量事件。
 */
export function deriveRunTokenUsage(events: HostEvent[]): RunTokenUsage {
  let calls = 0;
  let validCalls = 0;
  let tokens = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let bucketCalls = 0;
  const contributed = new Map<number, Contribution>();

  for (const event of events) {
    if (event.type !== 'llm_call') continue;
    calls++;
    if (event.usage === undefined) continue;
    const contribution = contributionOf(event.usage);
    if (contribution === undefined) continue;
    validCalls++;
    if (contribution.buckets) bucketCalls++;

    // last-wins：同一迭代的旧贡献先撤掉，再计入新贡献。
    const previous = contributed.get(event.iteration);
    if (previous !== undefined) {
      tokens -= previous.tokens;
      input -= previous.input;
      output -= previous.output;
      cacheRead -= previous.cacheRead;
      cacheWrite -= previous.cacheWrite;
      reasoning -= previous.reasoning;
    }
    tokens += contribution.tokens;
    input += contribution.input;
    output += contribution.output;
    cacheRead += contribution.cacheRead;
    cacheWrite += contribution.cacheWrite;
    reasoning += contribution.reasoning;
    contributed.set(event.iteration, contribution);
  }

  return {
    tokens,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
    hasBuckets: bucketCalls > 0,
    available: validCalls > 0,
    partial: calls > 0 && validCalls < calls,
  };
}

/**
 * 向后兼容 API：deriveRunTokenUsage 的投影面（tokens/available/partial 与旧版
 * 语义一致，另附分桶），供 RunUsage 等既有消费方直接使用。
 */
export function summarizeRunUsage(events: HostEvent[]): RunTokenUsage {
  return deriveRunTokenUsage(events);
}

// ---- 流式性能指标（首 token 延迟 / 解码速度）----

export interface RunStreamMetrics {
  /** 首个内容 token 到达耗时（相对 run 开始，毫秒）。 */
  ttftMs?: number;
  /** 解码速度（真实 output token 数 ÷ 首末 delta 时间差，token/秒）。 */
  tokensPerSecond?: number;
  /** 首末 delta 时间差（毫秒）。 */
  decodeMs?: number;
}

/**
 * 折叠流式增量事件：首 token 延迟 + 解码速度。
 * ttft 用 run_started → 首个 assistant/reasoning delta 的时间差；
 * tps 用真实 output tokens（非字符估算）÷ 首末 delta 差，缺任一锚点即省略。
 */
export function deriveRunStreamMetrics(events: HostEvent[]): RunStreamMetrics {
  const started = events.find((event) => event.type === 'run_started');
  const startMs = started ? Date.parse(started.timestamp) : Number.NaN;
  let firstDeltaMs: number | undefined;
  let lastDeltaMs: number | undefined;
  for (const event of events) {
    if (event.type !== 'assistant_delta' && event.type !== 'reasoning_delta') continue;
    const t = Date.parse(event.timestamp);
    if (!Number.isFinite(t)) continue;
    if (firstDeltaMs === undefined) firstDeltaMs = t;
    lastDeltaMs = t;
  }
  const ttftMs =
    Number.isFinite(startMs) && firstDeltaMs !== undefined
      ? Math.max(0, firstDeltaMs - startMs)
      : undefined;
  let tokensPerSecond: number | undefined;
  let decodeMs: number | undefined;
  if (firstDeltaMs !== undefined && lastDeltaMs !== undefined && lastDeltaMs > firstDeltaMs) {
    decodeMs = lastDeltaMs - firstDeltaMs;
    const outputTokens = deriveRunTokenUsage(events).outputTokens;
    if (outputTokens > 0 && decodeMs > 0) {
      tokensPerSecond = Math.round((outputTokens / (decodeMs / 1000)) * 10) / 10;
    }
  }
  return { ttftMs, tokensPerSecond, decodeMs };
}

/** 取事件流中最新一条 context_usage（无则 null）。 */
export function findLatestContextUsage(events: HostEvent[]): ContextUsageEvent | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === 'context_usage') return event;
  }
  return null;
}

/** 占用率分档：<70% 正常，<90% 警告，≥90% 危险（≥100% 必然已超限）。 */
export function gaugeLevel(ratio: number): 'normal' | 'warning' | 'danger' {
  if (ratio >= 0.9) return 'danger';
  if (ratio >= 0.7) return 'warning';
  return 'normal';
}

/** token 数 → 紧凑展示（8549 → "8.5K"，512000 → "512K"）。 */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`;
  }
  return String(tokens);
}

/** 精确用量的分项展示（未缓存输入 / 输出 / cache / 推理），仅在有分桶时可用。 */
export function formatTokenBreakdown(usage: RunTokenUsage): string {
  if (!usage.hasBuckets) return '';
  const parts = [
    `输入 ${formatContextTokens(usage.inputTokens)}`,
    `输出 ${formatContextTokens(usage.outputTokens)}`,
  ];
  if (usage.cacheReadTokens > 0) parts.push(`缓存读 ${formatContextTokens(usage.cacheReadTokens)}`);
  if (usage.cacheWriteTokens > 0)
    parts.push(`缓存写 ${formatContextTokens(usage.cacheWriteTokens)}`);
  if (usage.reasoningTokens > 0) parts.push(`推理 ${formatContextTokens(usage.reasoningTokens)}`);
  return parts.join(' · ');
}

/** 悬停明细（模型 / 已用 / 预算 / 占比 / 真实压力锚点 / 特殊状态）。 */
export function contextGaugeTitle(usage: ContextUsageEvent): string {
  const parts = [
    `上下文 ${formatContextTokens(usage.estimatedInputTokens)} / ${formatContextTokens(usage.inputBudgetTokens)} tokens（${Math.round(usage.usageRatio * 100)}%）`,
    `模型 ${usage.model}`,
  ];
  if (usage.pressureTokens !== undefined && usage.pressureTokens > 0) {
    parts.push(`上次上报真实 ${formatContextTokens(usage.pressureTokens)}`);
  }
  if (usage.emergencyTrim) parts.push('已触发紧急裁剪');
  if (usage.configSource === 'fallback') parts.push('模型能力未知，按保守预算估计');
  return parts.join(' · ');
}

/** /compact 状态（App 持有；会话流内渲染）。 */
export type CompactStatusState =
  | { phase: 'running' }
  | {
      phase: 'done';
      summarizedMessages: number;
      compactedTokens: number;
      reason?: 'no_checkpoint' | 'nothing_compactable';
    };

/** /compact 状态行文案：进行中 / 量化结果 / 两类零结果原因。 */
export function compactStatusText(status: CompactStatusState): string {
  if (status.phase === 'running') return '正在压缩…';
  if (status.summarizedMessages > 0) {
    return `已压缩 ${status.summarizedMessages} 条历史记录（约 ${formatContextTokens(status.compactedTokens)} tokens）`;
  }
  if (status.reason === 'no_checkpoint') {
    return '该会话没有可用的运行记录（checkpoint），无法压缩';
  }
  return '没有可压缩的历史记录';
}

/**
 * 预算推导说明：窗口 = 输入预算 + 输出预留 + 安全余量。
 * 解释分母为何小于用户配置的上下文窗口（如 1M 窗口显示 976K 预算）。
 */
export function formatBudgetDerivation(usage: ContextUsageEvent): string {
  return (
    `窗口 ${formatContextTokens(usage.contextWindowTokens)} = 预算 ${formatContextTokens(usage.inputBudgetTokens)}` +
    ` + 输出预留 ${formatContextTokens(usage.maxOutputTokens)} + 安全 ${formatContextTokens(usage.safetyTokens)}`
  );
}
