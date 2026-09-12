import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/messages';
import type { HostRun } from '../../types';
import styles from './ShellBar.module.css';

interface ShellBarProps {
  run: HostRun | null;
  /** Session title is the canonical label; run.task is only the turn prompt. */
  title?: string;
  onResume?: () => void;
  resuming?: boolean;
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
 * 顶栏只保留会话身份与运行态（标题 / Plan 标记 / 状态 pill / 恢复按钮）。
 * 会话统计已挪到底部 StatsBar（composer 正下方），避免与标题争夺同一行。
 */
export function ShellBar({ run, title, onResume, resuming, planMode }: ShellBarProps) {
  const { t } = useI18n();
  const statusKey = run ? RUN_STATUS_KEY[run.status] : null;
  const label = statusKey ? t(statusKey) : null;
  const displayTitle = title ?? run?.task ?? null;
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
