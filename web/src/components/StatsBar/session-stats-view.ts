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
 * 缓存命中率：命中缓存的输入 ÷ 全部输入（新增 + 命中 + 写入）。
 * 分母为 0（旧记录拆不出分桶）时返回 undefined，不显示 0%（那会被误读成"完全没命中"）。
 */
function cacheHitPercent(stats: SessionStats): number | undefined {
  const read = stats.cacheReadTokens ?? 0;
  const denom = (stats.inputTokens ?? 0) + read + (stats.cacheWriteTokens ?? 0);
  if (denom <= 0) return undefined;
  return Math.round((read / denom) * 100);
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
