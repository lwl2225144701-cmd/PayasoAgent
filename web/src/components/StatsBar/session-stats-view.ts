// 会话统计 → 底部状态条读数（纯函数，无 React/DOM/CSS 依赖，供组件与测试复用）。
//
// 布局对齐 DSH 底部状态条：两枚 icon pill + 一枚上下文环（环由 StatsBar 单独渲染）。
//   pill 1（活动）：回合 · 步 · 吞吐(tok/s)
//   pill 2（用量）：总量 tok · 缓存命中率
//   ring  ：上下文占用（数据来自 context_usage，不在本模块）
//
// 明细（LLM 调用数、工具调用数、首 token、活跃时长）移到 pill 的 title 提示里：
// 这三项以前直接挤在条上，条会随会话变长而越来越宽；DSH 的做法是条上只留
// "一眼要看的"，其余悬停可见。

import { formatDurationMs } from '../../format';
import { translator } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
import type { SessionStats } from '../../types';
import { formatContextTokens } from '../Timeline/context-gauge';

/**
 * 吞吐率：模型输出 token ÷ 解码耗时（首增量 → 末增量）。
 * 两者缺一就不显示——宁缺勿错，不拿"活跃时长"冒充生成时长。
 */
function tokensPerSecond(stats: SessionStats): number | undefined {
  const output = stats.outputTokens ?? 0;
  if (output <= 0 || stats.decodeMs <= 0) return undefined;
  return Math.round(output / (stats.decodeMs / 1000));
}

/**
 * 缓存命中率：命中缓存的输入 ÷ 全部**计费输入**（未缓存 + 命中 + 写入）。
 * 与 DSH 的会话 pill 同口径（分母含 cacheWrite）。
 *
 * 三条规矩：
 * 1. 没有任何调用上报过缓存分桶 → **不出数**（缺数据与"完全没命中"不是一回事，
 *    显示 0% 会被误读）；分母为 0 同样不出数。
 * 2. 上报了分桶的调用已经由 Host 侧唯一口径累计（`cacheUsageCalls`），
 *    这里只做除法。
 * 3. **部分命中绝不显示成 100%**：取整够到 100 就往小数位要精度
 *    （99.9 → 99.95 → 99.99），只有真的零未命中才给 100。
 *    返回的是**字符串**，因为小数位是动态的。
 */
function cacheHitPercent(stats: SessionStats): string | undefined {
  if ((stats.cacheUsageCalls ?? 0) <= 0) return undefined;
  const read = stats.cacheReadTokens ?? 0;
  const denom = (stats.inputTokens ?? 0) + read + (stats.cacheWriteTokens ?? 0);
  if (denom <= 0) return undefined;
  if (read >= denom) return '100';
  const percent = (read / denom) * 100;
  const rounded = Math.round(percent);
  if (rounded < 100) return String(rounded);
  // 还有未命中，只是太小被取整成 100 了 → 逐级加小数位，直到不再显示 100。
  for (const digits of [1, 2, 3]) {
    const text = percent.toFixed(digits);
    if (Number(text) < 100) return text;
  }
  return '<100';
}

/**
 * 紧凑时长：统计条专用。DSH 的条上是 `2m 8s` / `22.1s` / `414ms` 这种英文紧凑
 * 单位，**不随界面语言翻成中文全称**——中文「494分4秒」会把 pill 撑爆，而条上
 * 只是"一眼扫过"的读数，不需要完整可读性（面板里仍用本地化全称）。
 * 秒以下保留一位小数；整分省略秒（DSH 同款 `5m` 而非 `5m 0s`）。
 */
export function compactDurationMs(ms: number): string {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (value < 1000) return `${Math.round(value)}ms`;
  const sec = value / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rest = Math.round(sec - min * 60);
  if (min < 60) return rest === 0 ? `${min}m` : `${min}m ${rest}s`;
  const hr = Math.floor(min / 60);
  const remMin = min - hr * 60;
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
}

/** 状态条上的两枚 pill：[活动, 用量]。零值片段自动省略。 */
export function sessionStatsGroups(
  stats: SessionStats,
  language: LanguageMode = 'zh-CN',
): [string[], string[]] {
  const t = translator(language);
  const activity: string[] = [];
  if (stats.turns > 0) activity.push(t('shell.stats.turns', { count: stats.turns }));
  if (stats.steps > 0) activity.push(t('shell.stats.steps', { count: stats.steps }));
  const rate = tokensPerSecond(stats);
  if (rate !== undefined) activity.push(t('shell.stats.tokensPerSecond', { value: rate }));
  // 模型/工具用时：DSH 是两个独立片段（model 2m 8s · tools 22.1s），
  // 而不是一条「模型 X · 工具 Y」的长文案 —— 分开后每条都能单独省略，
  // 窄屏换行时也不会把一整块挤成两行。
  const model = modelMs(stats);
  if (model > 0) activity.push(t('shell.stats.modelShort', { value: compactDurationMs(model) }));
  if (stats.toolMs > 0) {
    activity.push(t('shell.stats.toolShort', { value: compactDurationMs(stats.toolMs) }));
  }

  const usage: string[] = [];
  if (stats.tokens > 0) usage.push(`${formatContextTokens(stats.tokens)} tok`);
  const hit = cacheHitPercent(stats);
  if (hit !== undefined) usage.push(t('shell.stats.cacheHit', { percent: hit }));

  return [activity, usage];
}

/** pill 的悬停明细：条上放不下的调用数 / 首 token / 活跃时长。 */
export function sessionStatsDetails(
  stats: SessionStats,
  language: LanguageMode = 'zh-CN',
): string[] {
  const t = translator(language);
  const details: string[] = [];
  if (stats.llmCalls > 0) details.push(t('shell.stats.llmCalls', { count: stats.llmCalls }));
  if (stats.toolCalls > 0) details.push(t('shell.stats.toolCalls', { count: stats.toolCalls }));
  if (stats.ttftCount > 0) {
    details.push(
      t('shell.stats.ttft', {
        duration: formatDurationMs(Math.round(stats.ttftMs / stats.ttftCount), language),
      }),
    );
  }
  if (stats.durationMs > 0) {
    details.push(
      t('shell.stats.active', { duration: formatDurationMs(stats.durationMs, language) }),
    );
  }
  return details;
}

// ---- 展开面板（点击 pill 弹出）：把条上放不下的读数分两张卡铺开 ----

/**
 * 模型用时 = 活跃时长 − 工具执行耗时。
 * 两者都可能为 0 或缺失，宁缺勿错：算不出正数就不显示，不拿活跃时长冒充。
 */
export function modelMs(stats: SessionStats): number {
  const model = stats.durationMs - stats.toolMs;
  return model > 0 ? model : 0;
}

/** Token 用量分桶。缺失分桶显示为 0（总量=各桶之和，缺的那桶就是 0）。 */
export interface TokenBuckets {
  /** 总计费 token。 */
  total: number;
  /** 未命中缓存的输入。 */
  input: number;
  /** 命中缓存的输入。 */
  cacheRead: number;
  /** 写入缓存的输入。 */
  cacheWrite: number;
  /** 模型输出。 */
  output: number;
  /** 缓存命中率；数据不可靠时 undefined（界面应不出数）。 */
  hitPercent?: string;
}

export function tokenBuckets(stats: SessionStats): TokenBuckets {
  return {
    total: stats.tokens,
    input: stats.inputTokens ?? 0,
    cacheRead: stats.cacheReadTokens ?? 0,
    cacheWrite: stats.cacheWriteTokens ?? 0,
    output: stats.outputTokens ?? 0,
    hitPercent: cacheHitPercent(stats),
  };
}

/** 面板里的一行读数：标签 + 值。值为 undefined 表示该行不渲染。 */
export interface StatRow {
  label: string;
  value: string;
  /** 行内补充说明（如样本数、占比），可省。 */
  hint?: string;
}

/**
 * 「会话统计」卡的读数。DSH 的同类卡片是：模型用时 / 工具调用用时 /
 * 首 token 平均 / 输出速度；我们再补两项自己的：LLM 与工具调用数、平均每轮 token。
 */
export function sessionStatRows(stats: SessionStats, language: LanguageMode = 'zh-CN'): StatRow[] {
  const t = translator(language);
  const rows: StatRow[] = [];

  // 只保留 DSH 那四行：模型用时 / 工具调用用时 / 首 token 平均 / 输出速度。
  // LLM 与工具调用数、平均每轮 token 曾经加在这里，真机对照 DSH 后发现它的面板
  // 只有这四项 —— 调用数留在条上悬停的 title 里，每轮 token 直接撤掉。
  const model = modelMs(stats);
  if (model > 0) {
    rows.push({ label: t('shell.stats.modelTime'), value: formatDurationMs(model, language) });
  }
  if (stats.toolMs > 0) {
    rows.push({
      label: t('shell.stats.toolTime'),
      value: formatDurationMs(stats.toolMs, language),
      hint:
        stats.toolCalls > 0 ? t('shell.stats.toolCalls', { count: stats.toolCalls }) : undefined,
    });
  }
  if (stats.ttftCount > 0) {
    // DSH 的 TTFT 是整数秒（13秒 而不是 13.4秒）：平均后直接取整，
    // 小数位对"首 token 大概多快"没有信息量，反而让行宽抖动。
    rows.push({
      label: t('shell.stats.ttftAvg'),
      value: formatDurationMs(Math.round(stats.ttftMs / stats.ttftCount), language, 0),
      hint: t('shell.stats.sampleCount', { count: stats.ttftCount }),
    });
  }
  const rate = tokensPerSecond(stats);
  if (rate !== undefined) {
    rows.push({
      label: t('shell.stats.tps'),
      value: `${rate} tok/s`,
      hint:
        stats.decodeCount > 0
          ? t('shell.stats.sampleCount', { count: stats.decodeCount })
          : undefined,
    });
  }
  return rows;
}

/** 「Token 用量」卡的读数：总量 + 四个分桶 + 命中率。 */
export function tokenStatRows(stats: SessionStats, language: LanguageMode = 'zh-CN'): StatRow[] {
  const t = translator(language);
  const b = tokenBuckets(stats);
  const rows: StatRow[] = [];
  if (b.total > 0) {
    rows.push({ label: t('shell.stats.totalTokens'), value: formatContextTokens(b.total) });
  }
  rows.push({ label: t('shell.stats.cacheRead'), value: formatContextTokens(b.cacheRead) });
  rows.push({ label: t('shell.stats.cacheWrite'), value: formatContextTokens(b.cacheWrite) });
  rows.push({ label: t('shell.stats.uncachedInput'), value: formatContextTokens(b.input) });
  rows.push({ label: t('shell.stats.outputTokens'), value: formatContextTokens(b.output) });
  if (b.hitPercent !== undefined) {
    rows.push({
      label: t('shell.stats.cacheHitLabel'),
      value: `${b.hitPercent}%`,
      hint: t('shell.stats.cacheHitHint'),
    });
  }
  return rows;
}
