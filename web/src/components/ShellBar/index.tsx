import { useEffect, useRef, useState } from 'react';
import type { HostRun } from '../../types';
import styles from './ShellBar.module.css';

interface ShellBarProps {
  run: HostRun | null;
  onResume?: () => void;
  resuming?: boolean;
}

const RUN_STATUS_TEXT: Record<HostRun['status'], string | null> = {
  running: '运行中',
  // Non-running states don't need a persistent pill — the result speaks for itself.
  completed: null,
  failed: null,
  stopped: null,
  interrupted: '已中断',
};

export function ShellBar({ run, onResume, resuming }: ShellBarProps) {
  const label = run ? RUN_STATUS_TEXT[run.status] : null;
  const [, tick] = useState(0);
  const autoTickRef = useRef<number | null>(null);

  // Subtle pulse-cycle ticker while running — keeps animation in sync without over-rendering.
  useEffect(() => {
    if (run?.status !== 'running') return;
    const id = window.setInterval(() => tick(t => (t + 1) % 1_000), 1200);
    autoTickRef.current = id;
    return () => {
      if (autoTickRef.current != null) window.clearInterval(autoTickRef.current);
    };
  }, [run?.status]);

  return (
    <div className={`${styles.bar} ${run ? '' : styles.landingBar}`}>
      <div className={styles.left}>
        {run && (
          <span className={styles.taskTitle} title={run.task}>
            {run.task}
          </span>
        )}
      </div>

      {label && (
        <div className={styles.right}>
          <span className={styles.statusTag} title="当前运行状态">
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.statusText}>{label}</span>
          </span>
          {run?.status === 'interrupted' && (
            <button className={styles.resumeButton} type="button" onClick={onResume} disabled={resuming}>
              {resuming ? '正在恢复…' : '继续运行'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
