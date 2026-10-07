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
