import { useEffect, useRef, useState } from 'react';
import type { HostRun } from '../../types';
import { computeRunStats, formatDurationMs, RUN_STATUS_LABELS, truncateMiddle } from '../../format';
import { useEventStream } from '../../hooks/useEventStream';
import { StopIcon, SummaryIcon, ChevronDownIcon, ShareIcon, MoreIcon, CopyIcon, CheckIcon } from '../icons';
import styles from './RunHeader.module.css';

interface RunHeaderProps {
  run: HostRun | null;
  modelFallback: string | null;
  onStop: () => void;
}

const RUN_STATUS_COLORS: Record<HostRun['status'], 'running' | 'completed' | 'failed' | 'stopped'> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
};

export function RunHeader({ run, modelFallback, onStop }: RunHeaderProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const { events } = useEventStream(run?.runId ?? null);

  const stats = run ? computeRunStats(run, events) : null;

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!run) {
    return (
      <div className={styles.header}>
        <div className={styles.emptyState}>选择或创建一个任务开始</div>
      </div>
    );
  }

  const statusColor = RUN_STATUS_COLORS[run.status];
  const statusLabel = RUN_STATUS_LABELS[run.status];

  const runStartedAt = events.find(e => e.type === 'run_started')?.timestamp;
  const startedAtMs = new Date(runStartedAt ?? run.createdAt).getTime();
  const durationMs = stats?.running
    ? Math.max(0, Date.now() - startedAtMs)
    : stats?.durationMs ?? 0;

  function copyRunId() {
    if (!run) return;
    navigator.clipboard?.writeText(run.runId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div className={styles.header}>
      <div className={styles.headRow}>
        <div className={styles.task}>
          <span className={styles.taskLabel}>{run.task || '未命名任务'}</span>
        </div>

        <div className={styles.actions}>
          <span className={`${styles.statusPill} ${styles[`status${statusColor[0].toUpperCase()}${statusColor.slice(1)}`]}`}>
            {statusLabel}
          </span>

          {run.status === 'running' && (
            <button className={styles.stopBtn} onClick={onStop} title="停止">
              <StopIcon size={14} />
              <span>停止</span>
            </button>
          )}

          <div ref={popRef} className={styles.summaryWrap}>
            <button
              className={`${styles.summaryBtn} ${open ? styles.open : ''}`}
              onClick={() => setOpen(v => !v)}
              aria-expanded={open}
            >
              <SummaryIcon size={14} />
              <span>运行摘要</span>
              <ChevronDownIcon size={13} className={styles.chevron} />
            </button>

            {open && (
              <div className={styles.popover} role="menu">
                <div className={styles.popoverBody}>
                  <MetaRow label="运行编号">
                    <span className={styles.mono} title={run.runId}>{truncateMiddle(run.runId, 16)}</span>
                    <button className={styles.iconMiniBtn} onClick={copyRunId} title="复制编号">
                      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                    </button>
                  </MetaRow>
                  <MetaRow label="启动时间">
                    {new Date(runStartedAt ?? run.createdAt).toLocaleString('zh-CN')}
                  </MetaRow>
                  {stats?.endedAt && (
                    <MetaRow label="结束时间">
                      {new Date(stats.endedAt).toLocaleString('zh-CN')}
                    </MetaRow>
                  )}
                  <MetaRow label="运行时长">{formatDurationMs(durationMs)}</MetaRow>
                  <MetaRow label="模型">{modelFallback ?? '—'}</MetaRow>
                  <MetaRow label="迭代次数">{stats?.steps ?? 0} 次</MetaRow>
                  <MetaRow label="工具调用">{stats?.tools ?? 0} 次</MetaRow>
                </div>
              </div>
            )}
          </div>

          <button className={styles.iconBtn} title="分享">
            <ShareIcon size={15} />
          </button>
          <button className={styles.iconBtn} title="更多">
            <MoreIcon size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.metaRow}>
      <span className={styles.metaLabel}>{label}</span>
      <span className={styles.metaValue}>{children}</span>
    </div>
  );
}
