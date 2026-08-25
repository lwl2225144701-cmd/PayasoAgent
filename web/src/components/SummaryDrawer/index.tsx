import { useEffect, useRef } from 'react';
import type { HostEvent, HostRun } from '../../types';
import { computeRunStats, formatDurationMs, RUN_STATUS_LABELS, truncateMiddle } from '../../format';
import { CloseIcon, StopIcon, CopyIcon, CheckIcon } from '../icons';
import styles from './SummaryDrawer.module.css';
import { useState } from 'react';

interface SummaryDrawerProps {
  run: HostRun;
  events: HostEvent[];
  open: boolean;
  onClose: () => void;
  onStop: () => void;
}

export function SummaryDrawer({ run, events, open, onClose, onStop }: SummaryDrawerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  const stats = computeRunStats(run, events);
  const startedAt = events.find(e => e.type === 'run_started')?.timestamp ?? run.createdAt;
  const endedAt = stats.endedAt ?? run.updatedAt;
  const durationMs = run.status === 'running'
    ? Math.max(0, Date.now() - new Date(startedAt).getTime())
    : stats.durationMs;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onDoc);
    return () => document.removeEventListener('keydown', onDoc);
  }, [open, onClose]);

  if (!open) return null;

  function copyId() {
    navigator.clipboard?.writeText(run.runId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.drawer}
        ref={ref}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="运行摘要"
      >
        <div className={styles.head}>
          <div>
            <div className={styles.kicker}>运行摘要</div>
            <div className={styles.title}>当前任务</div>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            <CloseIcon size={15} />
          </button>
        </div>

        <div className={styles.body}>
          <section className={styles.section}>
            <div className={styles.tag}>
              <span className={styles.dot} />
              <span>{RUN_STATUS_LABELS[run.status]}</span>
            </div>
            <p className={styles.task}>{run.task || '未命名任务'}</p>
          </section>

          <section className={styles.section}>
            <Row label="运行编号" mono>
              <span>{truncateMiddle(run.runId, 20)}</span>
              <button className={styles.ghostBtn} onClick={copyId} title="复制编号">
                {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
              </button>
            </Row>
            <Row label="开始时间">{new Date(startedAt).toLocaleString('zh-CN')}</Row>
            {run.status !== 'running' && (
              <Row label="结束时间">{new Date(endedAt).toLocaleString('zh-CN')}</Row>
            )}
            <Row label="运行时长">{formatDurationMs(durationMs)}</Row>
            <Row label="模型"><span className={styles.muted}>—</span></Row>
            <Row label="迭代次数">{stats.steps} 次</Row>
            <Row label="工具调用">{stats.tools} 次</Row>
            <Row label="Token 使用"><span className={styles.muted}>—</span></Row>
            <Row label="Checkpoint"><span className={styles.muted}>—</span></Row>
          </section>

          {run.status === 'running' && (
            <section className={styles.actions}>
              <button className={styles.stopBtn} onClick={onStop}>
                <StopIcon size={14} />
                <span>停止当前任务</span>
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={`${styles.rowValue} ${mono ? styles.rowMono : ''}`}>{children}</span>
    </div>
  );
}
