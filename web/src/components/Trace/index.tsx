// 模块: Trace —— 会话执行轨迹页（v2：三泳道时间轴 / 轮次 / 调用三视图 + 搜索）
// 职责边界：
//   - TraceRunData：单条 Run 的事件接入（复用 useEventStream 的 live-SSE /
//     snapshot 双通道）与派生（view + summary），只产数据不渲染 —— 每条 Run
//     恰好一个实例，三视图共享同一份事件流，不重复建 SSE 连接；
//   - TraceTimeline：跨 Run 三泳道时间轴（输入/模型/工具，按时间窗定位）；
//   - TraceRunGroup：调用视图的 Run 分组展示；轮次视图复用 TraceCallRow；
//   - TraceView：工具栏（视图切换 + 搜索）与三视图装配。
//
// 诚实性约定不变：时间轴只画有记录依据的时间戳/耗时；搜索只做包含匹配，
// 无匹配时如实显示空态，不伪造结果。
//
// 会话隔离：App 侧用 currentSessionId 作为本组件的 key —— 切换会话即整体重挂，
// 事件流、搜索词与展开状态都不会跨会话残留。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDurationMs } from '../../format';
import { useEventStream } from '../../hooks/useEventStream';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/messages';
import { runTaskText } from '../../run-task';
import type { HostRun, HostRunStatus } from '../../types';
import { ClockIcon, ColumnsIcon, ListIcon, SearchIcon, UserIcon } from '../icons';
import styles from './Trace.module.css';
import { TraceCallRow } from './TraceCallRow';
import { fetchTraceRunEvents } from './trace-events';
import {
  buildTimelineTicks,
  buildTraceRun,
  buildTraceRunSummary,
  callMatchesSearch,
  type TraceRunSummary,
  type TraceRunView,
  type TraceTimelineTick,
  timelineWindow,
} from './trace-structure';

type TraceViewMode = 'timeline' | 'turns' | 'calls';

const VIEW_MODE_KEY: Record<TraceViewMode, MessageKey> = {
  timeline: 'trace.view.duration',
  turns: 'trace.view.turns',
  calls: 'trace.view.calls',
};

const VIEW_MODE_ICON: Record<TraceViewMode, typeof ClockIcon> = {
  timeline: ClockIcon,
  turns: ColumnsIcon,
  calls: ListIcon,
};

const RUN_STATUS_KEY: Record<HostRunStatus, MessageKey> = {
  running: 'trace.run.status.running',
  stopping: 'trace.run.status.stopping',
  completed: 'trace.run.status.completed',
  failed: 'trace.run.status.failed',
  stopped: 'trace.run.status.stopped',
  interrupted: 'trace.run.status.interrupted',
};

const GROUP_STATUS_CLASS: Partial<Record<HostRunStatus, string>> = {
  running: styles.groupStatusRunning,
  stopping: styles.groupStatusRunning,
  failed: styles.groupStatusFailed,
  interrupted: styles.groupStatusInterrupted,
  stopped: styles.groupStatusStopped,
};

/** 单条 Run 的数据容器：接入事件流并把派生结果上报给 TraceView（不渲染任何内容） */
function TraceRunData({
  run,
  search,
  onReady,
}: {
  run: HostRun;
  search: string;
  onReady: (runId: string, view: TraceRunView, summary: TraceRunSummary) => void;
}) {
  // 传输方式与 Timeline 相同：running/stopping 常驻 SSE（实时更新），终态一次性快照。
  const isLive = run.status === 'running' || run.status === 'stopping';
  // 快照缓存键绑定 updatedAt：Run 被 resume 后旧缓存自动失效。
  const fetchSnapshot = useCallback(
    (runId: string) => fetchTraceRunEvents(runId, run.updatedAt),
    [run.updatedAt],
  );
  const { events } = useEventStream(
    run.runId,
    isLive ? 'live' : 'snapshot',
    undefined,
    fetchSnapshot,
  );
  const view = useMemo(() => buildTraceRun(run, events), [run, events]);
  const summary = useMemo(() => buildTraceRunSummary(run, view, search), [run, view, search]);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    onReadyRef.current(run.runId, view, summary);
  }, [run.runId, view, summary]);

  return null;
}

/** 搜索词下单条 Run 是否可见：任务命中或任一调用命中；摘要未到时先放行 */
function runMatchesSearch(entry: TraceRunEntry | undefined, search: string): boolean {
  const q = search.trim();
  if (!q || !entry) return true;
  return entry.summary.taskMatched || entry.summary.calls.some((call) => call.matched);
}

interface TraceRunEntry {
  view: TraceRunView;
  summary: TraceRunSummary;
}

/* ---- 时间轴：三泳道（输入 / 模型 / 工具） ---- */

const TICK_CLASS: Record<TraceTimelineTick['kind'], string> = {
  input: styles.tickInput,
  model: styles.tickModel,
  tool: styles.tickTool,
};

const LANES: Array<{ kind: TraceTimelineTick['kind']; labelKey: MessageKey }> = [
  { kind: 'input', labelKey: 'trace.timeline.laneInput' },
  { kind: 'model', labelKey: 'trace.timeline.laneModel' },
  { kind: 'tool', labelKey: 'trace.timeline.laneTool' },
];

function TraceTimeline({ ticks }: { ticks: TraceTimelineTick[] }) {
  const { t, language } = useI18n();
  const range = useMemo(() => timelineWindow(ticks), [ticks]);
  if (!range) {
    return <div className={styles.timelineEmpty}>{t('trace.timeline.noTiming')}</div>;
  }
  const span = range.maxTs - range.minTs;
  // 轮次边界竖网格线：每条 Run 的起点（输入泳道刻度）在全局窗口的位置；
  // 去重近邻（<0.25% 视为同一界线），跨三条泳道画通线
  const boundaries: number[] = [];
  for (const tick of ticks) {
    if (tick.kind !== 'input') continue;
    const left = ((tick.ts - range.minTs) / span) * 100;
    if (!boundaries.some((b) => Math.abs(b - left) < 0.25)) boundaries.push(left);
  }
  return (
    <div className={styles.timeline} role="img" aria-label={t('trace.timeline.ariaLabel')}>
      <div className={styles.laneLabels} aria-hidden="true">
        {LANES.map((lane) => (
          <span key={lane.kind} className={styles.laneLabel}>
            {t(lane.labelKey)}
          </span>
        ))}
      </div>
      <div className={styles.laneStack}>
        {boundaries.map((left) => (
          <span
            key={`grid-${left.toFixed(3)}`}
            className={styles.gridline}
            style={{ left: `${left}%` }}
            aria-hidden="true"
          />
        ))}
        {LANES.map((lane) => (
          <div key={lane.kind} className={styles.lane}>
            {ticks
              .filter((tick) => tick.kind === lane.kind)
              .map((tick) => {
                const left = ((tick.ts - range.minTs) / span) * 100;
                const width = tick.durationMs != null ? 3 : 2;
                const title =
                  tick.kind === 'input'
                    ? tick.task
                    : tick.durationMs != null
                      ? `${tick.label} · ${formatDurationMs(tick.durationMs, language)}`
                      : tick.label;
                return (
                  <span
                    key={tick.key}
                    className={`${styles.tick} ${TICK_CLASS[tick.kind]} ${
                      tick.status === 'failed' ? styles.tickFailed : ''
                    } ${tick.matched ? '' : styles.tickDimmed}`}
                    style={{ left: `${left}%`, width: `${width}px` }}
                    title={title}
                  />
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- 调用视图：Run 分组 ---- */

function TraceRunGroup({
  run,
  view,
  search,
}: {
  run: HostRun;
  view: TraceRunView;
  search: string;
}) {
  const { t, language } = useI18n();
  // 搜索命中任一调用时只显示命中的；仅任务命中（无调用命中）时回退展示全部
  const visibleCalls = useMemo(() => {
    if (!search.trim()) return view.calls;
    const filtered = view.calls.filter((call) => callMatchesSearch(call, search));
    return filtered.length > 0 ? filtered : view.calls;
  }, [view, search]);

  return (
    <section className={styles.group} aria-label={runTaskText(run)}>
      <header className={styles.groupHeader}>
        <div className={styles.groupTitleRow}>
          <span className={`${styles.groupStatus} ${GROUP_STATUS_CLASS[run.status] ?? ''}`}>
            {t(RUN_STATUS_KEY[run.status])}
          </span>
          <span className={styles.groupMeta}>
            {t('trace.run.turn', { turn: run.turnIndex + 1 })}
          </span>
        </div>
        <div className={styles.groupTask}>{runTaskText(run)}</div>
        <div className={styles.groupMeta}>
          <span>
            {t('trace.calls.summary', {
              model: view.modelCallCount,
              tool: view.toolCallCount,
            })}
          </span>
          {run.status !== 'running' && run.status !== 'stopping' && (
            <span>
              {t('timeline.execution.duration', {
                duration: formatDurationMs(
                  Math.max(0, (Date.parse(run.updatedAt) || 0) - (Date.parse(run.createdAt) || 0)),
                  language,
                ),
              })}
            </span>
          )}
        </div>
        {view.terminalError && <div className={styles.groupError}>{view.terminalError}</div>}
      </header>
      {visibleCalls.length > 0 ? (
        <ol className={styles.callList}>
          {visibleCalls.map((call) => (
            <TraceCallRow key={call.key} call={call} runId={run.runId} />
          ))}
        </ol>
      ) : (
        <div className={styles.waitingHint}>
          <span>{t('trace.model.waiting')}</span>
        </div>
      )}
    </section>
  );
}

/* ---- 轮次视图：单条轮次行（默认折叠，点击展开完整调用列表） ---- */

function TraceTurnRow({
  run,
  entry,
  expanded,
  onToggle,
}: {
  run: HostRun;
  entry: TraceRunEntry | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className={styles.turnSection} aria-label={runTaskText(run)}>
      <button type="button" className={styles.turnRow} onClick={onToggle} aria-expanded={expanded}>
        <span className={styles.turnLabel}>{t('trace.run.turn', { turn: run.turnIndex + 1 })}</span>
        <span className={styles.turnBadge}>
          <UserIcon size={12} />
          <span>{t('trace.turn.user')}</span>
        </span>
        <span className={styles.turnTask}>{runTaskText(run)}</span>
      </button>
      {entry && (
        <div className={styles.turnMeta}>
          {t('trace.turn.steps', {
            steps: entry.view.calls.length,
            tools: entry.view.toolCallCount,
          })}
        </div>
      )}
      {entry &&
        expanded &&
        (entry.view.calls.length > 0 ? (
          <ol className={styles.callList}>
            {entry.view.calls.map((call) => (
              <TraceCallRow key={call.key} call={call} runId={run.runId} />
            ))}
          </ol>
        ) : (
          <div className={styles.waitingHint}>
            <span>{t('trace.model.waiting')}</span>
          </div>
        ))}
      {entry && expanded && entry.view.terminalError && (
        <div className={styles.groupError}>{entry.view.terminalError}</div>
      )}
    </section>
  );
}

/* ---- TraceView：工具栏 + 三视图装配 ---- */

export const TraceView = memo(function TraceView({ runs }: { runs: HostRun[] }) {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<TraceViewMode>('timeline');
  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState<Map<string, TraceRunEntry>>(new Map());
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const handleReady = useCallback((runId: string, view: TraceRunView, summary: TraceRunSummary) => {
    setEntries((prev) => {
      const existing = prev.get(runId);
      if (existing && existing.view === view && existing.summary === summary) return prev;
      const next = new Map(prev);
      next.set(runId, { view, summary });
      return next;
    });
  }, []);

  const ticks = useMemo(
    () => buildTimelineTicks([...entries.values()].map((e) => e.summary)),
    [entries],
  );

  if (runs.length === 0) {
    return <div className={styles.traceEmpty}>{t('trace.empty')}</div>;
  }

  const searchTrimmed = search.trim();
  const visibleRuns = runs.filter((run) => runMatchesSearch(entries.get(run.runId), searchTrimmed));
  const searchNoMatch = searchTrimmed.length > 0 && visibleRuns.length === 0 && entries.size > 0;

  return (
    <div className={styles.traceView}>
      <div className={styles.toolbar}>
        {/* biome-ignore lint/a11y/useSemanticElements: 视图切换按钮组使用 group 语义，保留现有工具栏布局 */}
        <div className={styles.viewSwitch} role="group" aria-label={t('trace.view.switchLabel')}>
          {(Object.keys(VIEW_MODE_KEY) as TraceViewMode[]).map((mode) => {
            const Icon = VIEW_MODE_ICON[mode];
            return (
              <button
                key={mode}
                type="button"
                className={`${styles.viewBtn} ${viewMode === mode ? styles.viewBtnActive : ''}`}
                onClick={() => setViewMode(mode)}
                aria-pressed={viewMode === mode}
              >
                <Icon size={14} />
                <span>{t(VIEW_MODE_KEY[mode])}</span>
              </button>
            );
          })}
        </div>
        <div className={styles.searchBox}>
          <SearchIcon size={14} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder={t('trace.search.placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('trace.search.placeholder')}
          />
        </div>
      </div>

      {searchNoMatch ? (
        <div className={styles.traceEmpty}>
          {t('trace.search.noMatches', { query: searchTrimmed })}
        </div>
      ) : (
        <>
          {viewMode === 'timeline' &&
            (entries.size === 0 ? (
              <div className={styles.timelineEmpty}>{t('trace.timeline.loading')}</div>
            ) : (
              <TraceTimeline ticks={ticks} />
            ))}
          {viewMode === 'turns' && (
            <div className={styles.turnsList}>
              {visibleRuns.map((run) => (
                <TraceTurnRow
                  key={run.runId}
                  run={run}
                  entry={entries.get(run.runId)}
                  expanded={expandedRunId === run.runId}
                  onToggle={() =>
                    setExpandedRunId((prev) => (prev === run.runId ? null : run.runId))
                  }
                />
              ))}
            </div>
          )}
          {viewMode === 'calls' &&
            visibleRuns.map((run) => {
              const entry = entries.get(run.runId);
              if (!entry) return null;
              return <TraceRunGroup key={run.runId} run={run} view={entry.view} search={search} />;
            })}
        </>
      )}

      {/* 数据容器：三视图共享同一份事件流，始终挂载（不渲染内容） */}
      {runs.map((run) => (
        <TraceRunData key={run.runId} run={run} search={search} onReady={handleReady} />
      ))}
    </div>
  );
});
