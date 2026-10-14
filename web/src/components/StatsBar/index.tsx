// 会话统计条（v2.3 起从顶栏挪到底部）：挂在输入框正下方、与 composer 同宽居中。
// 布局对齐 DSH 底部状态条：两枚图标 pill（活动 / 用量）+ 一枚上下文占用环。
//   pill 1：回合 · 步 · 吞吐(tok/s) · 模型用时 · 工具用时
//   pill 2：总量 tok · 缓存命中率
//   ring  ：上下文占用（含可见百分比）
//
// 点击 pill 展开面板，把条上放不下的读数分两张卡铺开（对齐 DSH 的「会话统计」与
// 「Token 用量」）：会话统计卡 + Token 用量卡。悬停仍有 title 兜底（键盘/读屏用）。
// 分组口径见 session-stats-view.ts（纯函数）；零值片段自动省略，无统计不渲染。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n';
import { portalRoot } from '../../portal-root';
import type { ContextUsageEvent, SessionStats } from '../../types';
import { ChartIcon, DatabaseIcon } from '../icons';
import { ContextUsageRing } from '../Timeline/ContextUsageRing';
import styles from './StatsBar.module.css';
import {
  sessionStatRows,
  sessionStatsDetails,
  sessionStatsGroups,
  tokenStatRows,
} from './session-stats-view';

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
  onActivate,
}: {
  kind: 'activity' | 'usage';
  segments: string[];
  title?: string;
  /** 点击展开面板；传了才可点。 */
  onActivate?: () => void;
}) {
  if (segments.length === 0) return null;
  const Icon = kind === 'activity' ? ChartIcon : DatabaseIcon;
  return (
    <button
      type="button"
      className={styles.pill}
      data-stats-group={kind}
      title={title}
      onClick={onActivate}
      aria-haspopup="dialog"
    >
      <Icon size={14} className={styles.icon} />
      {segments.map((segment) => (
        <span key={segment} className={styles.item}>
          {segment}
        </span>
      ))}
    </button>
  );
}

/** 展开面板：两张读数卡（会话统计 / Token 用量）。 */
function StatsPanel({
  stats,
  language,
  onClose,
  anchorRef,
}: {
  stats: SessionStats;
  language: 'zh-CN' | 'en-US';
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 定位：锚点上方 + 居中，视口内钳制。useLayoutEffect 首帧前算完，不闪在左上角。
  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const w = 320;
    setPos({
      top: Math.max(8, rect.top - 8),
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8)),
    });
  }, [anchorRef]);

  // 点面板外 / Esc 关闭（与 open-in-app 菜单同因）
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

  const sessionRows = sessionStatRows(stats, language);
  const tokenRows = tokenStatRows(stats, language);

  return createPortal(
    <div
      ref={panelRef}
      className={styles.panel}
      role="dialog"
      aria-label={t('shell.stats.title')}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
    >
      <div className={styles.panelCard}>
        <div className={styles.panelCardTitle}>{t('shell.stats.panelSession')}</div>
        {sessionRows.map((row) => (
          <div key={row.label} className={styles.panelRow}>
            <span className={styles.panelLabel}>{row.label}</span>
            <span className={styles.panelValue}>
              {row.value}
              {row.hint && <span className={styles.panelHint}>{row.hint}</span>}
            </span>
          </div>
        ))}
      </div>
      <div className={styles.panelCard}>
        <div className={styles.panelCardTitle}>{t('shell.stats.panelTokens')}</div>
        {tokenRows.map((row) => (
          <div key={row.label} className={styles.panelRow}>
            <span className={styles.panelLabel}>{row.label}</span>
            <span className={styles.panelValue}>
              {row.value}
              {row.hint && <span className={styles.panelHint}>{row.hint}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>,
    portalRoot(),
  );
}

export function StatsBar({ stats, contextUsage }: StatsBarProps) {
  const { t, language } = useI18n();
  const barRef = useRef<HTMLDivElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  if (!stats) return null;
  const [activity, usage] = sessionStatsGroups(stats, language);
  // 鼠标悬停补全条上放不下的读数（调用数 / 首 token / 活跃时长）。
  const details = sessionStatsDetails(stats, language);
  const detailTitle = details.length > 0 ? details.join(' · ') : t('shell.stats.title');
  if (activity.length === 0 && usage.length === 0 && !contextUsage) return null;
  return (
    <div className={styles.bar} data-session-stats-bar ref={barRef}>
      <StatsGroup
        kind="activity"
        segments={activity}
        title={detailTitle}
        onActivate={() => setPanelOpen((v) => !v)}
      />
      <StatsGroup
        kind="usage"
        segments={usage}
        title={detailTitle}
        onActivate={() => setPanelOpen((v) => !v)}
      />
      {contextUsage && <ContextUsageRing usage={contextUsage} showPercent />}
      {panelOpen && (
        <StatsPanel
          stats={stats}
          language={language}
          onClose={() => setPanelOpen(false)}
          anchorRef={barRef}
        />
      )}
    </div>
  );
}
