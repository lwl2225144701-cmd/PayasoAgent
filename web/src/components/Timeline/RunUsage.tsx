import { formatDurationMs, formatTime } from '../../format';
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
  if (run.status === 'running' || run.status === 'stopping') return null;
  const usage = summarizeRunUsage(events);
  const metrics = deriveRunStreamMetrics(events);
  const breakdown = formatTokenBreakdown(usage);
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
            ? `本轮各模型请求的精确用量：${breakdown}（模型上报，非上下文估算）`
            : '本轮已返回用量的模型请求累计输入与输出 Token；不是上下文占用'
        }
      >
        <DatabaseIcon size={15} />
        用量{' '}
        {usage.available
          ? `${formatContextTokens(usage.tokens)} tok${usage.partial ? '（部分）' : ''}`
          : '未记录'}
      </span>
      {metrics.ttftMs !== undefined && (
        <span title="首 token 延迟（run 开始 → 首个内容到达）">
          首 token {formatDurationMs(metrics.ttftMs)}
        </span>
      )}
      {metrics.tokensPerSecond !== undefined && (
        <span title={`解码速度 = 真实输出 token ÷ 首末增量耗时（${metrics.decodeMs}ms）`}>
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
        用时 {Number.isFinite(duration) ? formatDurationMs(duration) : '未知'}
      </span>
      <time dateTime={end}>{formatTime(end)}</time>
    </div>
  );
}
