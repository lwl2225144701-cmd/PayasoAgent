// 每轮用量行（Run 终态后显示在答案下方）：悬停才淡入，点「用量」弹明细面板。
//
// 形态对齐 DSH 的「本轮用量」弹窗：标题行右侧是总量，下面依次是
// 提供方/模型、缓存命中率、未缓存输入、缓存读取、输出。
//
// 两个刻意的设计：
// 1. **默认隐藏**（opacity 0，进本轮区块才淡入）—— 真机反馈这行常驻太吵。
//    用 opacity 而不是 display:none：避免悬停瞬间整页内容跳动。
// 2. **无分桶数据时面板照样能开**，只是没有分项行（旧记录只有 totalTokens），
//    不假装有数据。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatDurationMs, formatTime } from '../../format';
import { useI18n } from '../../i18n';
import { portalRoot } from '../../portal-root';
import type { HostEvent, HostRun } from '../../types';
import { DatabaseIcon } from '../icons';
import { deriveRunStreamMetrics, formatContextTokens, summarizeRunUsage } from './context-gauge';
import styles from './Timeline.module.css';

const PANEL_WIDTH = 300;

interface StatRow {
  label: string;
  value: string;
}

/** 「本轮用量」面板：标题行带总量，下面按 DSH 的顺序铺分项。 */
function RunUsagePanel({
  rows,
  total,
  onClose,
  anchorRef,
}: {
  rows: StatRow[];
  total: string;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 定位：锚点上方 + 右缘对齐锚点，视口内钳制（与 StatsBar 的弹窗同套做法）
  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      top: Math.max(8, rect.top - 8),
      left: Math.max(8, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)),
    });
  }, [anchorRef]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const el = panelRef.current;
      if (el && !el.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, anchorRef]);

  return createPortal(
    <div
      ref={panelRef}
      className={styles.usagePanel}
      role="dialog"
      aria-label={t('widgets.runUsage.panelTitle')}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
    >
      <div className={styles.usagePanelTitle}>
        <DatabaseIcon size={13} />
        <span>{t('widgets.runUsage.panelTitle')}</span>
        <span className={styles.usagePanelTotal}>{total}</span>
      </div>
      {rows.map((row) => (
        <div key={row.label} className={styles.usagePanelRow}>
          <span className={styles.usagePanelLabel}>{row.label}</span>
          <span className={styles.usagePanelValue}>{row.value}</span>
        </div>
      ))}
    </div>,
    portalRoot(),
  );
}

export function RunUsage({
  run,
  events,
  modelLabel,
}: {
  run: HostRun;
  events: HostEvent[];
  /** 提供方/模型展示名（Timeline 的 modelFallback）；缺省时不显示该行。 */
  modelLabel?: string | null;
}) {
  const { t, language } = useI18n();
  const usageRef = useRef<HTMLSpanElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  if (run.status === 'running' || run.status === 'stopping') return null;
  const usage = summarizeRunUsage(events);
  const metrics = deriveRunStreamMetrics(events);
  const terminal = [...events]
    .reverse()
    .find((event) =>
      ['run_completed', 'run_failed', 'run_stopped', 'run_interrupted'].includes(event.type),
    );
  const end = terminal?.timestamp ?? run.updatedAt;
  const duration = Math.max(0, Date.parse(end) - Date.parse(run.createdAt));

  // 面板行：提供方/模型 → 缓存命中 → 未缓存输入 → 缓存读取 → 输出（DSH 同序）
  const rows: StatRow[] = [];
  if (modelLabel) {
    rows.push({ label: t('widgets.runUsage.providerModel'), value: modelLabel });
  }
  if (usage.hasBuckets && usage.available) {
    const denom = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    if (denom > 0) {
      rows.push({
        label: t('widgets.runUsage.cacheHit'),
        value: `${Math.round((usage.cacheReadTokens / denom) * 1000) / 10}%`,
      });
    }
    rows.push({
      label: t('widgets.runUsage.uncachedInput'),
      value: formatContextTokens(usage.inputTokens),
    });
    rows.push({
      label: t('widgets.runUsage.cacheRead'),
      value: formatContextTokens(usage.cacheReadTokens),
    });
    rows.push({
      label: t('widgets.runUsage.output'),
      value: formatContextTokens(usage.outputTokens),
    });
    if (usage.cacheWriteTokens > 0) {
      rows.push({
        label: t('widgets.runUsage.cacheWrite'),
        value: formatContextTokens(usage.cacheWriteTokens),
      });
    }
  }
  const total = usage.available
    ? `${formatContextTokens(usage.tokens)} tok${usage.partial ? t('widgets.runUsage.partial') : ''}`
    : t('widgets.runUsage.unrecorded');

  return (
    <div className={styles.runUsage}>
      <span ref={usageRef} className={styles.runUsageTrigger}>
        <button
          type="button"
          className={styles.runUsageButton}
          onClick={() => setPanelOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          title={t('widgets.runUsage.panelTitle')}
        >
          <DatabaseIcon size={15} />
          {t('widgets.runUsage.label')} {total}
        </button>
      </span>
      {metrics.ttftMs !== undefined && (
        <span title={t('widgets.runUsage.ttftTitle')}>
          {t('widgets.runUsage.ttft', { value: formatDurationMs(metrics.ttftMs, language) })}
        </span>
      )}
      {metrics.tokensPerSecond !== undefined && (
        <span title={t('widgets.runUsage.decodeTitle', { ms: metrics.decodeMs ?? 0 })}>
          {metrics.tokensPerSecond}/s
        </span>
      )}
      <span>
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 6v6l4 2" />
        </svg>
        {t('widgets.runUsage.duration', {
          value: Number.isFinite(duration)
            ? formatDurationMs(duration, language)
            : t('widgets.runUsage.unknown'),
        })}
      </span>
      <time dateTime={end}>{formatTime(end, language)}</time>
      {panelOpen && (
        <RunUsagePanel
          rows={rows}
          total={total}
          onClose={() => setPanelOpen(false)}
          anchorRef={usageRef}
        />
      )}
    </div>
  );
}
