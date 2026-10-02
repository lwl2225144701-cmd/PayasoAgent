// 上下文占用环形指示器：环的填充比例 = 当前占用 ÷ 真实上下文窗口（不是 Runtime
// 的输入预算），颜色随占用率分级（正常 / 警告 / 危险），悬停查看分项明细。
// 占用优先取 provider 真实上报值，否则用内部估算；口径统一见 contextGaugeView。
// 数据来自最近一条 context_usage 事件（终态 Run 亦回放可见）。

import { useId } from 'react';
import { useI18n } from '../../i18n';
import type { ContextUsageEvent } from '../../types';
import {
  contextGaugeTitle,
  contextGaugeView,
  formatContextTokens,
  gaugeLevel,
} from './context-gauge';
import styles from './Timeline.module.css';

const SIZE = 18;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextUsageRing({
  usage,
  showPercent = false,
}: {
  usage: ContextUsageEvent;
  /**
   * 在环右侧显示可见百分比（如 `40%`）。底部统计条用它对齐 DSH 状态条；
   * 输入区那颗环保持纯图标（那里空间紧，且百分比已在悬停提示里）。
   */
  showPercent?: boolean;
}) {
  const tooltipId = useId();
  const { t, language } = useI18n();
  // 单一展示口径：分母=真实上下文窗口，占用优先 provider 上报（见 contextGaugeView）。
  // 内部输入预算（窗口 − 输出预留 − 安全）只进 trace，不呈现给用户。
  const view = contextGaugeView(usage);
  const displayTokens = view.displayTokens;
  const percent = view.percent;
  const anchored = view.anchored;
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
  const level = gaugeLevel(view.ratio);
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
          strokeDashoffset={CIRCUMFERENCE * (1 - view.ratio)}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      {showPercent && <span className={styles.gaugePercent}>{percent}%</span>}
      <span id={tooltipId} role="tooltip" className={styles.gaugeTooltip}>
        <span className={styles.contextHeading}>
          <span>
            {t('widgets.contextRing.used')} <strong>{percent}%</strong>
          </span>
          <span>
            ~{formatContextTokens(displayTokens)} / {formatContextTokens(view.capacityTokens)}
          </span>
        </span>
        {anchored && (
          <span className={styles.gaugeTooltipDetail} role="note">
            {t('widgets.contextRing.anchoredDetail', {
              pressure: formatContextTokens(usage.pressureTokens as number),
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
                width: `${(part.tokens / Math.max(view.capacityTokens, view.displayTokens, 1)) * 100}%`,
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
