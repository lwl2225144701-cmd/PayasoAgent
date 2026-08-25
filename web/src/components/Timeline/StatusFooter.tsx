import type { HostEvent, HostRun } from '../../types';
import { computeRunStats, formatDurationMs, formatTime } from '../../format';
import styles from './Timeline.module.css';

interface StatusFooterProps {
  run: HostRun;
  events: HostEvent[];
}

const FOOTER_LABELS: Record<HostRun['status'], string> = {
  running: 'Run in progress...',
  completed: 'Run completed',
  failed: 'Run failed',
  stopped: 'Run stopped',
};

export function StatusFooter({ run, events }: StatusFooterProps) {
  const stats = computeRunStats(run, events);
  const timeText = formatTime(stats.endedAt) || formatTime(run.updatedAt);

  return (
    <div className={styles.statusFooter}>
      <span className={`${styles.footerStatus} ${styles[`footer${run.status}`]}`}>
        <span className={styles.footerDot} />
        {FOOTER_LABELS[run.status]}
      </span>
      <span className={styles.footerMetric}>{stats.steps} steps</span>
      <span className={styles.footerMetric}>{formatDurationMs(stats.durationMs)}</span>
      <span className={styles.footerMetric}>Tools used: {stats.tools}</span>
      <span className={styles.footerSpacer} />
      <span className={styles.footerTime}>{timeText}</span>
    </div>
  );
}
