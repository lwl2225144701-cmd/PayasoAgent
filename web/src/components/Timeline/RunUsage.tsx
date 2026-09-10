import { formatDurationMs, formatTime } from '../../format';
import { useI18n } from '../../i18n';
import type { HostEvent, HostRun } from '../../types';
import { DatabaseIcon } from '../icons';
import {
  deriveRunStreamMetrics,
  formatContextTokens,
  formatTokenBreakdown,
  summarizeRunUsage,
} from './context-gauge';
import styles from './Timeline.module.css';

export function RunUsage({ run, events }: { run: HostRun; events: HostEvent[] }) {
  const { t, language } = useI18n();
  if (run.status === 'running' || run.status === 'stopping') return null;
  const usage = summarizeRunUsage(events);
  const metrics = deriveRunStreamMetrics(events);
  const breakdown = formatTokenBreakdown(usage, language);
  const terminal = [...events]
    .reverse()
    .find((event) =>
      ['run_completed', 'run_failed', 'run_stopped', 'run_interrupted'].includes(event.type),
    );
  const end = terminal?.timestamp ?? run.updatedAt;
  const duration = Math.max(0, Date.parse(end) - Date.parse(run.createdAt));
  return (
    <div className={styles.runUsage}>
      <span
        title={
          breakdown
            ? t('widgets.runUsage.tooltipExact', { breakdown })
            : t('widgets.runUsage.tooltipCumulative')
        }
      >
        <DatabaseIcon size={15} />
        {t('widgets.runUsage.label')}{' '}
        {usage.available
          ? `${formatContextTokens(usage.tokens)} tok${usage.partial ? t('widgets.runUsage.partial') : ''}`
          : t('widgets.runUsage.unrecorded')}
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
    </div>
  );
}
