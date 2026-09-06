// 上下文预算环形指示器：环的填充比例 = 当前上下文占用（usageRatio），
// 颜色随占用率分级（正常 / 警告 / 危险），悬停查看明细。
// 数据来自最近一条 context_usage 事件（终态 Run 亦回放可见）。

import { useId } from 'react';
import type { ContextUsageEvent } from '../../types';
import { contextGaugeTitle, formatContextTokens, gaugeLevel } from './context-gauge';
import styles from './Timeline.module.css';

const SIZE = 18;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextUsageRing({ usage }: { usage: ContextUsageEvent }) {
  const tooltipId = useId();
  const level = gaugeLevel(usage.usageRatio);
  const ratio = Math.max(0, Math.min(1, usage.usageRatio));
  const percent = Math.round(usage.usageRatio * 100);
  const levelClass =
    level === 'danger'
      ? styles.gaugeDanger
      : level === 'warning'
        ? styles.gaugeWarning
        : styles.gaugeNormal;

  return (
    <span
      className={styles.gaugeWrap}
      role="img"
      tabIndex={0}
      aria-label={contextGaugeTitle(usage)}
      aria-describedby={tooltipId}
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
      <span id={tooltipId} role="tooltip" className={styles.gaugeTooltip}>
        <span className={styles.gaugeTooltipLabel}>上下文窗口</span>
        <strong className={styles.gaugeTooltipPercent}>{percent}% 已用</strong>
        <span className={styles.gaugeTooltipDetail}>
          已用 {formatContextTokens(usage.estimatedInputTokens)} Token，共{' '}
          {formatContextTokens(usage.inputBudgetTokens)}
        </span>
        <span className={styles.gaugeTooltipModel}>{usage.model}</span>
        {usage.configSource === 'fallback' && (
          <span className={styles.gaugeTooltipNotice}>模型能力未知，当前使用保守预算</span>
        )}
        {usage.emergencyTrim && (
          <span className={styles.gaugeTooltipDanger}>已进入紧急上下文压缩区间</span>
        )}
      </span>
    </span>
  );
}
