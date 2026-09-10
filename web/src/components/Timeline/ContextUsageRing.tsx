// 上下文预算环形指示器：环的填充比例 = 当前上下文占用（usageRatio），
// 颜色随占用率分级（正常 / 警告 / 危险），悬停查看明细。
// 数据来自最近一条 context_usage 事件（终态 Run 亦回放可见）。

import { useId } from 'react';
import { useI18n } from '../../i18n';
import type { ContextUsageEvent } from '../../types';
import {
  contextGaugeTitle,
  formatBudgetDerivation,
  formatContextTokens,
  gaugeLevel,
} from './context-gauge';
import styles from './Timeline.module.css';

const SIZE = 18;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextUsageRing({ usage }: { usage: ContextUsageEvent }) {
  const tooltipId = useId();
  const { t, language } = useI18n();
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
            label: t('widgets.contextRing.messagesWithSystem'),
            tokens: usage.messageTokens,
            swatch: styles.swatchMessages,
          },
          {
            label: t('widgets.contextRing.tools'),
            tokens: usage.toolSchemaTokens,
            swatch: styles.swatchTools,
          },
        ]
      : [
          {
            label: t('widgets.contextRing.systemPrompt'),
            tokens: usage.systemTokens,
            swatch: styles.swatchSystem,
          },
          {
            label: t('widgets.contextRing.tools'),
            tokens: usage.toolSchemaTokens,
            swatch: styles.swatchTools,
          },
          {
            label: t('widgets.contextRing.messages'),
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
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 需键盘聚焦才显示 tooltip（.gaugeWrap:focus-visible）
      tabIndex={0}
      aria-label={contextGaugeTitle(usage, language)}
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
            {t('widgets.contextRing.used')} <strong>{percent}%</strong>
          </span>
          <span>
            ~{formatContextTokens(displayTokens)} / {formatContextTokens(usage.inputBudgetTokens)}
          </span>
        </span>
        {anchored && (
          <span className={styles.gaugeTooltipDetail} role="note">
            {t('widgets.contextRing.anchoredDetail', {
              pressure: formatContextTokens(pressure),
              estimate: formatContextTokens(usage.estimatedInputTokens),
            })}
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
        {usage.contextWindowTokens > 0 && (
          <span className={styles.gaugeTooltipDetail} role="note">
            {formatBudgetDerivation(usage, language)}
          </span>
        )}
        {usage.configSource === 'fallback' && (
          <span className={styles.gaugeTooltipNotice}>
            {t('widgets.contextRing.fallbackNotice')}
          </span>
        )}
        {usage.emergencyTrim && (
          <span className={styles.gaugeTooltipDanger}>
            {t('widgets.contextRing.emergencyTrim')}
          </span>
        )}
      </span>
    </span>
  );
}
