// 会话统计条（v2.3 起从顶栏挪到底部）：挂在输入框正下方、与 composer 同宽居中，
// 承接原顶栏 stats strip 的全部片段——执行规模（回合/步/LLM/工具）与用量耗时
// （tok / 首 token / 活跃时长）分成两枚图标 pill，读数风格对齐 DSH 底部状态条。
// 分组口径见 session-stats-view.ts（纯函数）；零值片段自动省略，无统计不渲染。

import { useI18n } from '../../i18n';
import type { SessionStats } from '../../types';
import { ChartIcon, DatabaseIcon } from '../icons';
import styles from './StatsBar.module.css';
import { sessionStatsGroups } from './session-stats-view';

interface StatsBarProps {
  /** 会话级统计投影；无则整条不渲染。 */
  stats?: SessionStats | null;
}

function StatsGroup({ kind, segments }: { kind: 'activity' | 'usage'; segments: string[] }) {
  if (segments.length === 0) return null;
  const Icon = kind === 'activity' ? ChartIcon : DatabaseIcon;
  return (
    <span className={styles.pill} data-stats-group={kind}>
      <Icon size={14} className={styles.icon} />
      {segments.map((segment) => (
        <span key={segment} className={styles.item}>
          {segment}
        </span>
      ))}
    </span>
  );
}

export function StatsBar({ stats }: StatsBarProps) {
  const { t, language } = useI18n();
  if (!stats) return null;
  const [activity, usage] = sessionStatsGroups(stats, language);
  if (activity.length === 0 && usage.length === 0) return null;
  return (
    <div
      className={styles.bar}
      data-session-stats-bar
      // 只给 tooltip：读数是纯文本，屏幕阅读器直接读内容即可，不需要额外 live region
      title={t('shell.stats.title')}
    >
      <StatsGroup kind="activity" segments={activity} />
      <StatsGroup kind="usage" segments={usage} />
    </div>
  );
}
