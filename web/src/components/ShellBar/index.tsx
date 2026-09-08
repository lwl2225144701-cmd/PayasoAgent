import { useEffect, useRef, useState } from 'react';
import { formatDurationMs } from '../../format';
import type { HostRun, SessionStats } from '../../types';
import { formatContextTokens } from '../Timeline/context-gauge';
import styles from './ShellBar.module.css';

interface ShellBarProps {
  run: HostRun | null;
  /** Session title is the canonical label; run.task is only the turn prompt. */
  title?: string;
  onResume?: () => void;
  resuming?: boolean;
  /** 会话级统计投影（顶栏 stats strip）；无则整条不渲染。 */
  stats?: SessionStats | null;
  /** /plan 计划模式开启时显示标记（下一轮强制只读 + 仅产出方案）。 */
  planMode?: boolean;
}

const RUN_STATUS_TEXT: Record<HostRun['status'], string | null> = {
  running: '运行中',
  stopping: '停止中…',
  // Non-running states don't need a persistent pill — the result speaks for itself.
  completed: null,
  failed: null,
  stopped: null,
  interrupted: '已中断',
};

/**
 * 把会话统计折叠成顶栏展示片段（纯函数，供组件渲染与测试复用）。
 * 零值/无数据片段自动省略，首 token 取平均（汇总 ÷ 有记录的回合数）。
 */
export function sessionStatsSegments(stats: SessionStats): string[] {
  const segments: string[] = [];
  if (stats.turns > 0) segments.push(`${stats.turns} 回合`);
  if (stats.steps > 0) segments.push(`${stats.steps} 步`);
  if (stats.llmCalls > 0) segments.push(`${stats.llmCalls} LLM`);
  if (stats.toolCalls > 0) segments.push(`${stats.toolCalls} 工具`);
  if (stats.tokens > 0) segments.push(`${formatContextTokens(stats.tokens)} tok`);
  if (stats.ttftCount > 0) {
    segments.push(`首token ${formatDurationMs(Math.round(stats.ttftMs / stats.ttftCount))}`);
  }
  if (stats.durationMs > 0) segments.push(`活跃 ${formatDurationMs(stats.durationMs)}`);
  return segments;
}

export function ShellBar({ run, title, onResume, resuming, stats, planMode }: ShellBarProps) {
  const label = run ? RUN_STATUS_TEXT[run.status] : null;
  const displayTitle = title ?? run?.task ?? null;
  const segments = stats ? sessionStatsSegments(stats) : [];
  const [, tick] = useState(0);
  const autoTickRef = useRef<number | null>(null);

  // Subtle pulse-cycle ticker while running — keeps animation in sync without over-rendering.
  useEffect(() => {
    if (run?.status !== 'running') return;
    const id = window.setInterval(() => tick((t) => (t + 1) % 1_000), 1200);
    autoTickRef.current = id;
    return () => {
      if (autoTickRef.current != null) window.clearInterval(autoTickRef.current);
    };
  }, [run?.status]);

  return (
    <div className={`${styles.bar} ${run ? '' : styles.landingBar}`}>
      <div className={styles.left}>
        {displayTitle && (
          <span className={styles.taskTitle} title={displayTitle}>
            {displayTitle}
          </span>
        )}
      </div>

      <div className={styles.right}>
        {planMode && (
          <span className={styles.planTag} title="计划模式：只读 + 仅产出方案（/plan 退出）">
            Plan
          </span>
        )}
        {segments.length > 0 && (
          <span className={styles.statsStrip} title="会话统计（回合/步/调用/用量/耗时）">
            {segments.map((segment) => (
              <span key={segment} className={styles.statsItem}>
                {segment}
              </span>
            ))}
          </span>
        )}
        {label && (
          <span className={styles.statusTag} title="当前运行状态">
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.statusText}>{label}</span>
          </span>
        )}
        {run?.status === 'interrupted' && (
          <button
            className={styles.resumeButton}
            type="button"
            onClick={onResume}
            disabled={resuming}
          >
            {resuming ? '正在恢复…' : '继续运行'}
          </button>
        )}
      </div>
    </div>
  );
}
