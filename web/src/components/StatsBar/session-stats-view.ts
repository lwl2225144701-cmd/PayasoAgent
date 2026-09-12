// 会话统计 → 底部状态条读数（纯函数，无 React/DOM/CSS 依赖，供组件与测试复用）。
// v2.3 起统计条从顶栏挪到 composer 正下方；读数口径与顶栏时代完全一致，
// 只是拆成"执行规模 / 用量耗时"两组，交给 StatsBar 渲染成两枚图标 pill。

import { formatDurationMs } from '../../format';
import { translator } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
import type { SessionStats } from '../../types';
import { formatContextTokens } from '../Timeline/context-gauge';

/**
 * 把会话统计折叠成底部状态条的两个分组。
 * 返回 [执行规模, 用量耗时]，零值/无数据片段自动省略，首 token 取平均
 * （汇总 ÷ 有记录的回合数）。语言是入参（不是模块级状态）：默认中文。
 */
export function sessionStatsGroups(
  stats: SessionStats,
  language: LanguageMode = 'zh-CN',
): [string[], string[]] {
  const t = translator(language);
  const activity: string[] = [];
  if (stats.turns > 0) activity.push(t('shell.stats.turns', { count: stats.turns }));
  if (stats.steps > 0) activity.push(t('shell.stats.steps', { count: stats.steps }));
  if (stats.llmCalls > 0) activity.push(`${stats.llmCalls} LLM`);
  if (stats.toolCalls > 0) activity.push(t('shell.stats.toolCalls', { count: stats.toolCalls }));

  const usage: string[] = [];
  if (stats.tokens > 0) usage.push(`${formatContextTokens(stats.tokens)} tok`);
  if (stats.ttftCount > 0) {
    usage.push(
      t('shell.stats.ttft', {
        duration: formatDurationMs(Math.round(stats.ttftMs / stats.ttftCount), language),
      }),
    );
  }
  if (stats.durationMs > 0) {
    usage.push(t('shell.stats.active', { duration: formatDurationMs(stats.durationMs, language) }));
  }

  return [activity, usage];
}
