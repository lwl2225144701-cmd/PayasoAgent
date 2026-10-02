// 会话统计条（v2.3 起从顶栏挪到底部）：挂在输入框正下方、与 composer 同宽居中。
// 布局对齐 DSH 底部状态条：两枚图标 pill（活动 / 用量）+ 一枚上下文占用环。
//   pill 1：回合 · 步 · 吞吐(tok/s)
//   pill 2：总量 tok · 缓存命中率
//   ring  ：上下文占用（含可见百分比）
// 调用数 / 首 token / 活跃时长放进 pill 的悬停提示（不再挤在条上，避免条随会话变宽）；
// 分组口径见 session-stats-view.ts（纯函数）；零值片段自动省略，无统计不渲染。

import { useI18n } from '../../i18n';
import type { ContextUsageEvent, SessionStats } from '../../types';
import { ChartIcon, DatabaseIcon } from '../icons';
import { ContextUsageRing } from '../Timeline/ContextUsageRing';
import styles from './StatsBar.module.css';
import { sessionStatsDetails, sessionStatsGroups } from './session-stats-view';

interface StatsBarProps {
  /** 会话级统计投影；无则整条不渲染。 */
  stats?: SessionStats | null;
  /** 当前活跃 Run 的最近一条 context_usage；无则不渲染上下文环。 */
  contextUsage?: ContextUsageEvent | null;
}

function StatsGroup({
  kind,
  segments,
  title,
}: {
  kind: 'activity' | 'usage';
  segments: string[];
  title?: string;
}) {
  if (segments.length === 0) return null;
  const Icon = kind === 'activity' ? ChartIcon : DatabaseIcon;
  return (
    <span className={styles.pill} data-stats-group={kind} title={title}>
      <Icon size={14} className={styles.icon} />
      {segments.map((segment) => (
        <span key={segment} className={styles.item}>
          {segment}
        </span>
      ))}
    </span>
  );
}

export function StatsBar({ stats, contextUsage }: StatsBarProps) {
  const { t, language } = useI18n();
  if (!stats) return null;
  const [activity, usage] = sessionStatsGroups(stats, language);
  // 鼠标悬停补全条上放不下的读数（调用数 / 首 token / 活跃时长）。
  const details = sessionStatsDetails(stats, language);
  const detailTitle = details.length > 0 ? details.join(' · ') : t('shell.stats.title');
  if (activity.length === 0 && usage.length === 0 && !contextUsage) return null;
  return (
    <div className={styles.bar} data-session-stats-bar title={detailTitle}>
      <StatsGroup kind="activity" segments={activity} title={detailTitle} />
      <StatsGroup kind="usage" segments={usage} title={detailTitle} />
      {contextUsage && <ContextUsageRing usage={contextUsage} showPercent />}
    </div>
  );
}
