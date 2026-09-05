// 上下文预算环形指示器：环的填充比例 = 当前上下文占用（usageRatio），
// 颜色随占用率分级（正常 / 警告 / 危险），悬停查看明细。
// 数据来自最近一条 context_usage 事件（终态 Run 亦回放可见）。

import type { ContextUsageEvent } from '../../types';
import { contextGaugeTitle, gaugeLevel } from './context-gauge';
import styles from './Timeline.module.css';

const SIZE = 18;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextUsageRing({ usage }: { usage: ContextUsageEvent }) {
  const level = gaugeLevel(usage.usageRatio);
  const ratio = Math.max(0, Math.min(1, usage.usageRatio));
  const levelClass =
    level === 'danger'
      ? styles.gaugeDanger
      : level === 'warning'
        ? styles.gaugeWarning
        : styles.gaugeNormal;

  return (
    <span
      className={styles.gaugeWrap}
      title={contextGaugeTitle(usage)}
      role="img"
      aria-label={`上下文占用 ${Math.round(usage.usageRatio * 100)}%`}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle
          className={styles.gaugeTrack}
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
        />
        <circle
          className={`${styles.gaugeArc} ${levelClass}`}
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
    </span>
  );
}
