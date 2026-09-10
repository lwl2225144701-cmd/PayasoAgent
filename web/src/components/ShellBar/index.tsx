import { useEffect, useRef, useState } from 'react';
import { formatDurationMs } from '../../format';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/messages';
import { translator } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
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

// 状态 → 消息 key；null = 不常驻 pill。
// Non-running states don't need a persistent pill — the result speaks for itself.
const RUN_STATUS_KEY: Record<HostRun['status'], MessageKey | null> = {
  running: 'shell.runStatus.running',
  stopping: 'shell.runStatus.stopping',
  completed: null,
  failed: null,
  stopped: null,
  interrupted: 'shell.runStatus.interrupted',
};

/**
 * 把会话统计折叠成顶栏展示片段（纯函数，供组件渲染与测试复用）。
 * 零值/无数据片段自动省略，首 token 取平均（汇总 ÷ 有记录的回合数）。
 * 语言是入参（不是模块级状态）：默认中文，既有调用点与测试不传也照旧。
 */
export function sessionStatsSegments(
  stats: SessionStats,
  language: LanguageMode = 'zh-CN',
): string[] {
  const t = translator(language);
  const segments: string[] = [];
  if (stats.turns > 0) segments.push(t('shell.stats.turns', { count: stats.turns }));
  if (stats.steps > 0) segments.push(t('shell.stats.steps', { count: stats.steps }));
  if (stats.llmCalls > 0) segments.push(`${stats.llmCalls} LLM`);
  if (stats.toolCalls > 0) segments.push(t('shell.stats.toolCalls', { count: stats.toolCalls }));
  if (stats.tokens > 0) segments.push(`${formatContextTokens(stats.tokens)} tok`);
  if (stats.ttftCount > 0) {
    segments.push(
      t('shell.stats.ttft', {
        duration: formatDurationMs(Math.round(stats.ttftMs / stats.ttftCount), language),
      }),
    );
  }
  if (stats.durationMs > 0) {
    segments.push(
      t('shell.stats.active', { duration: formatDurationMs(stats.durationMs, language) }),
    );
  }
  return segments;
}

export function ShellBar({ run, title, onResume, resuming, stats, planMode }: ShellBarProps) {
  const { t, language } = useI18n();
  const statusKey = run ? RUN_STATUS_KEY[run.status] : null;
  const label = statusKey ? t(statusKey) : null;
  const displayTitle = title ?? run?.task ?? null;
  const segments = stats ? sessionStatsSegments(stats, language) : [];
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
          <span className={styles.planTag} title={t('shell.planMode.title')}>
            Plan
          </span>
        )}
        {segments.length > 0 && (
          <span className={styles.statsStrip} title={t('shell.stats.title')}>
            {segments.map((segment) => (
              <span key={segment} className={styles.statsItem}>
                {segment}
              </span>
            ))}
          </span>
        )}
        {label && (
          <span className={styles.statusTag} title={t('shell.runStatus.title')}>
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
            {resuming ? t('shell.resume.resuming') : t('shell.resume.action')}
          </button>
        )}
      </div>
    </div>
  );
}
