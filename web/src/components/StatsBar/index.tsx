// 会话统计条（v2.3 起从顶栏挪到底部）：挂在输入框正下方、与 composer 同宽居中。
// 布局对齐 DSH 底部状态条：两枚图标 pill（活动 / 用量）+ 一枚上下文占用环。
//   pill 1：回合 · 步 · 吞吐(tok/s) · model X · tools Y
//   pill 2：总量 tok · 缓存命中率
//   ring  ：上下文占用（含可见百分比）
//
// 两枚 pill **各自弹各自的窗**（对齐 DSH：会话统计与 Token 用量是两个独立弹窗，
// 不是一块面板并两列）：点活动 pill 出「会话统计」，点用量 pill 出「Token 用量」。
// 每个弹窗都是 图标+标题行 + 分隔线 + 读数行 的卡片；Esc / 点窗外 / 再点本 pill 关闭。
// 悬停仍有 title 兜底（键盘/读屏用）。分组口径见 session-stats-view.ts（纯函数）。

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
  tokenTotalLabel,
} from './session-stats-view';

interface StatsBarProps {
  /** 会话级统计投影；无则整条不渲染。 */
  stats?: SessionStats | null;
  /** 当前活跃 Run 的最近一条 context_usage；无则不渲染上下文环。 */
  contextUsage?: ContextUsageEvent | null;
}

/** 弹窗内容：哪一枚 pill 决定弹哪张卡。 */
type PanelKind = 'activity' | 'usage';

const PANEL_WIDTH = 320;

function StatsGroup({
  kind,
  segments,
  title,
  open,
  onActivate,
  anchorRef,
}: {
  kind: PanelKind;
  segments: string[];
  title?: string;
  /** 本 pill 的弹窗是否展开（用于 aria-expanded）。 */
  open?: boolean;
  onActivate?: () => void;
  /** 弹窗定位到本 pill；由父级持有 ref（HTMLElement 以便兼容 button 的 ref prop）。 */
  anchorRef: React.MutableRefObject<HTMLElement | null>;
}) {
  if (segments.length === 0) return null;
  const Icon = kind === 'activity' ? ChartIcon : DatabaseIcon;
  return (
    <button
      // callback ref 桥接：父级给的是 RefObject<HTMLElement>，直接赋给 button 的
      // ref 会被 React 18 的 LegacyRef 类型卡住（OpenInAppMenu 的锚点是 div 才没这问题）
      ref={(el) => {
        anchorRef.current = el;
      }}
      type="button"
      className={styles.pill}
      data-stats-group={kind}
      title={title}
      onClick={onActivate}
      aria-haspopup="dialog"
      aria-expanded={open}
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

/**
 * 单枚 pill 的弹窗。DSH 的两张卡各自独立，所以这里一个组件只渲染一组读数行；
 * 定位到锚点上方居中，视口内钳制。
 */
function StatsPanel({
  kind,
  rows,
  titleValue,
  onClose,
  anchorRef,
}: {
  kind: PanelKind;
  rows: { label: string; value: string }[];
  /** 标题行右侧的读数（Token 卡的总量；DSH 同款把总数放标题行）。 */
  titleValue?: string;
  onClose: () => void;
  anchorRef: React.MutableRefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 定位：锚点上方 + 居中，视口内钳制。useLayoutEffect 首帧前算完，不闪在左上角。
  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      top: Math.max(8, rect.top - 8),
      left: Math.max(
        8,
        Math.min(rect.left + rect.width / 2 - PANEL_WIDTH / 2, window.innerWidth - PANEL_WIDTH - 8),
      ),
    });
  }, [anchorRef]);

  // 点窗外 / Esc 关闭。点**本 pill** 不算窗外（toggle 收起由 pill 自己的 onClick 负责）。
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

  const Icon = kind === 'activity' ? ChartIcon : DatabaseIcon;
  const title = kind === 'activity' ? t('shell.stats.panelSession') : t('shell.stats.panelTokens');

  return createPortal(
    <div
      ref={panelRef}
      className={styles.panel}
      role="dialog"
      aria-label={title}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
    >
      <div className={styles.panelTitle}>
        <Icon size={14} className={styles.panelTitleIcon} />
        <span className={styles.panelTitleText}>{title}</span>
        {titleValue && <span className={styles.panelTitleValue}>{titleValue}</span>}
      </div>
      {rows.map((row) => (
        <div key={row.label} className={styles.panelRow}>
          <span className={styles.panelLabel}>{row.label}</span>
          <span className={styles.panelValue}>{row.value}</span>
        </div>
      ))}
    </div>,
    portalRoot(),
  );
}

export function StatsBar({ stats, contextUsage }: StatsBarProps) {
  const { t, language } = useI18n();
  // 两枚 pill 各自持自己的展开状态：同一时刻只开一个（点另一枚会顶掉当前这个）。
  const [openPanel, setOpenPanel] = useState<PanelKind | null>(null);
  // | null 才能得到 MutableRefObject（callback ref 要写 .current）
  const activityRef = useRef<HTMLElement | null>(null);
  const usageRef = useRef<HTMLElement | null>(null);
  if (!stats) return null;
  const [activity, usage] = sessionStatsGroups(stats, language);
  // 鼠标悬停补全条上放不下的读数（调用数 / 首 token / 活跃时长）。
  const details = sessionStatsDetails(stats, language);
  const detailTitle = details.length > 0 ? details.join(' · ') : t('shell.stats.title');
  if (activity.length === 0 && usage.length === 0 && !contextUsage) return null;

  const toggle = (kind: PanelKind) => setOpenPanel((cur) => (cur === kind ? null : kind));

  return (
    <div className={styles.bar} data-session-stats-bar>
      <StatsGroup
        kind="activity"
        segments={activity}
        title={detailTitle}
        open={openPanel === 'activity'}
        onActivate={() => toggle('activity')}
        anchorRef={activityRef}
      />
      <StatsGroup
        kind="usage"
        segments={usage}
        title={detailTitle}
        open={openPanel === 'usage'}
        onActivate={() => toggle('usage')}
        anchorRef={usageRef}
      />
      {contextUsage && <ContextUsageRing usage={contextUsage} showPercent />}
      {openPanel === 'activity' && (
        <StatsPanel
          kind="activity"
          rows={sessionStatRows(stats, language)}
          onClose={() => setOpenPanel(null)}
          anchorRef={activityRef}
        />
      )}
      {openPanel === 'usage' && (
        <StatsPanel
          kind="usage"
          rows={tokenStatRows(stats, language)}
          titleValue={tokenTotalLabel(stats, language)}
          onClose={() => setOpenPanel(null)}
          anchorRef={usageRef}
        />
      )}
    </div>
  );
}
