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
  // 锚点优先：有 provider 实际上报的 prompt 侧压力时用它当占用口径，
  // 否则回落启发式估算（与 DSH token-meter 的 pressure 优先一致）。
  const pressure = usage.pressureTokens;
  const anchored = pressure !== undefined && pressure > 0;
  const displayTokens = anchored ? pressure : usage.estimatedInputTokens;
  const budget = usage.inputBudgetTokens || 1;
  const ratio = Math.max(0, Math.min(1, displayTokens / budget));
  const percent = Math.round(ratio * 100);
  const parts =
    usage.systemTokens == null
      ? [
          {
            label: '消息（含系统提示词）',
            tokens: usage.messageTokens,
            swatch: styles.swatchMessages,
          },
          { label: '工具', tokens: usage.toolSchemaTokens, swatch: styles.swatchTools },
        ]
      : [
          { label: '系统提示词', tokens: usage.systemTokens, swatch: styles.swatchSystem },
          { label: '工具', tokens: usage.toolSchemaTokens, swatch: styles.swatchTools },
          {
            label: '对话消息',
            tokens: Math.max(0, usage.messageTokens - usage.systemTokens),
            swatch: styles.swatchMessages,
          },
        ];
  const level = gaugeLevel(ratio);
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
        <span className={styles.contextHeading}>
          <span>
            上下文已用 <strong>{percent}%</strong>
          </span>
          <span>
            ~{formatContextTokens(displayTokens)} / {formatContextTokens(usage.inputBudgetTokens)}
          </span>
        </span>
        {anchored && (
          <span className={styles.gaugeTooltipDetail} role="note">
            真实上报 {formatContextTokens(pressure)} · 本次请求预估{' '}
            {formatContextTokens(usage.estimatedInputTokens)}
          </span>
        )}
        <span className={styles.contextBar} aria-hidden="true">
          {parts.map((part) => (
            <span
              key={part.label}
              className={part.swatch}
              style={{
                width: `${(part.tokens / Math.max(usage.inputBudgetTokens, usage.estimatedInputTokens, 1)) * 100}%`,
              }}
            />
          ))}
        </span>
        {parts.map((part) => (
          <span className={styles.contextRow} key={part.label}>
            <i className={part.swatch} />
            <span>{part.label}</span>
            <span>~{formatContextTokens(part.tokens)}</span>
          </span>
        ))}
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
