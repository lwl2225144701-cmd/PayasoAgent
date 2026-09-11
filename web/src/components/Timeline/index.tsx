import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelToolchainPreparation,
  openFileInDefaultBrowser,
  resolveApproval,
  resolveToolchainPreparation,
  workspaceFileUrl,
} from '../../api';
import {
  formatBytes,
  formatDurationMs,
  formatTime,
  isDuplicateOfFinal,
  stripThinkTags,
} from '../../format';
import { useEventStream } from '../../hooks/useEventStream';
import { useI18n } from '../../i18n';
import { translate } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
import type {
  ApprovalRequestedEvent,
  ContextUsageEvent,
  FileEntry,
  HostEvent,
  HostRun,
  HostRunStatus,
  LlmCallEvent,
  StreamingEvent,
  ToolCallEvent,
  ToolchainPreparationPhase,
  ToolchainPreparationRequestedEvent,
  ToolErrorEvent,
  ToolResultEvent,
  TraceImage,
} from '../../types';
import { CollapsibleText } from '../CollapsibleText';
import { CopyButton } from '../CopyButton';
import { FileModal } from '../FileModal';
import { AlertIcon, CheckIcon, ChevronRightIcon, ScissorsIcon, ThinkIcon } from '../icons';
import { MarkdownText } from '../MarkdownText';
import { deriveModelWaitState, findLatestContextUsage, type ModelWaitState } from './context-gauge';
import { derivePlan, derivePlanNotes, type PlanNote, type PlanView } from './plan-state';
import { composeToolchainRetryMessage, findLastFailedShellCommand } from './preparation-retry';
import { RunUsage } from './RunUsage';
import { ThinkBlock } from './ThinkBlock';
import styles from './Timeline.module.css';
import { ToolActionRow } from './ToolActionRow';

interface TimelineProps {
  run: HostRun | null;
  modelFallback: string | null;
  embedded?: boolean;
  /** POST 创建成功前的本地回合，只负责即时反馈，不连接不存在的临时 runId。 */
  optimistic?: boolean;
  onRunTerminal?: () => void;
  // v1.6 工具链闭环②：准备成功后用户显式重试 —— 以新会话轮次发起
  // （新轮次拥有全新 side-effect 身份空间；Runtime 不自动重放）
  onRetryCommand?: (message: string) => void;
  // 上下文预算指示：最新 context_usage 上抛给宿主（输入栏环形指示器数据源）
  onContextUsage?: (usage: ContextUsageEvent | null) => void;
  // 计划清单上抛给宿主（输入栏上方"当前计划"数据源）。宿主只把它接到最新一轮
  // Run 上：计划是会话级临时状态，下一轮开始即不再展示。
  onPlan?: (plan: PlanView | null) => void;
}

function preparationPhaseLabel(phase: ToolchainPreparationPhase, language: LanguageMode): string {
  switch (phase) {
    case 'checking':
      return translate(language, 'timeline.preparation.checking');
    case 'installing':
      return translate(language, 'timeline.preparation.installing');
    case 'verifying':
      return translate(language, 'timeline.preparation.verifying');
  }
}

export interface ToolCallData {
  operationKey?: string;
  tool: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  durationMs?: number;
  result?: unknown;
  error?: unknown;
  /** 工具产出的图片（工作区相对路径，需配合 runId 拼访问地址） */
  images?: TraceImage[];
}

function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let current = element;
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return current;
    current = current.parentElement;
  }
  return element;
}

interface ReasoningBlock {
  step: number;
  timestamp: string;
  thinkingDetail: string | null;
  visible: string;
}

function ExecutionPanel({
  groups,
  thinking,
  running,
  modelWait,
  startedAt,
  status,
  finishedAt,
  runId,
}: {
  groups: ToolStepGroup[];
  thinking: string;
  running: boolean;
  /** 非 null = 正在等待模型首 token（llm_call_started 之后无任何后续事件） */
  modelWait: ModelWaitState | null;
  startedAt: string | undefined;
  status: HostRunStatus;
  finishedAt: string;
  runId: string;
}) {
  // 执行详情默认收起，避免每次发送消息都把页面撑开；用户仍可手动展开。
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  // 时钟下沉：运行中每秒强制 ExecutionPanel 自身重渲一次，刷新执行时长 /
  // 阶段化文案 / 首 token 等待秒数。不再依赖父级 Timeline 的全局 tick——
  // 否则每 1.2s 会拖整棵 Timeline（含 finalAnswer/CollapsibleText 子树）重渲。
  const [, setClockTick] = useState(0);
  const wasRunning = useRef(running);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setClockTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const tools = groups.flatMap((group) => group.tools);
  const failedCount = tools.filter((tool) => tool.status === 'failed').length;
  const elapsed = running && startedAt ? elapsedSeconds(startedAt) : 0;
  const startMs = startedAt ? new Date(startedAt).getTime() : NaN;
  const endMs = running ? Date.now() : new Date(finishedAt).getTime();
  const durationMs =
    Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
  const durationLabel =
    durationMs >= 1000
      ? formatDurationMs(durationMs, language)
      : t('timeline.duration.underOneSecond');
  // 阶段化文案：随等待时间演进，避免静态文字的呆滞感
  const thinkingPhase =
    elapsed < 6
      ? t('timeline.wait.thinking')
      : elapsed < 20
        ? t('timeline.wait.analyzing')
        : t('timeline.wait.complexTask');
  // 等待模型首 token 的实时秒数（父组件 running 期间每 1.2s tick 一次，随渲染刷新）
  // 已发出 Provider 请求（llm_request_sent）后从 requestSentAt 起算；否则从 llm_call_started 起算。
  const modelWaitSeconds = modelWait
    ? Math.max(
        0,
        Math.round(
          (Date.now() - Date.parse(modelWait.requestSentAt ?? modelWait.startedAt)) / 1000,
        ),
      )
    : 0;
  // 大上下文时提示 prefill 慢的根因与出路（≥100K 才提示，避免噪音）
  const modelWaitTitle =
    modelWait?.estimatedInputTokens !== undefined && modelWait.estimatedInputTokens >= 100_000
      ? t('timeline.wait.largeContextHint', {
          k: Math.round(modelWait.estimatedInputTokens / 1000),
        })
      : undefined;
  const bodyEmpty =
    !thinking &&
    tools.length === 0 &&
    !groups.some((g) => g.reasoning?.visible || g.compactionNote || g.planNote);
  const hasDetails =
    Boolean(thinking) ||
    tools.length > 0 ||
    groups.some((group) => group.reasoning?.visible) ||
    groups.some((group) => group.compactionNote) ||
    groups.some((group) => group.planNote);
  const statusTitle = running
    ? t('timeline.execution.statusRunning')
    : status === 'failed'
      ? t('timeline.execution.statusFailed')
      : status === 'stopping'
        ? t('timeline.execution.statusStopping')
        : status === 'stopped'
          ? t('timeline.execution.statusStopped')
          : status === 'interrupted'
            ? t('timeline.execution.statusInterrupted')
            : t('timeline.execution.statusDone');

  useEffect(() => {
    if (!running && wasRunning.current) setOpen(false);
    wasRunning.current = running;
  }, [running]);

  if (!hasDetails && !running && status !== 'failed' && status !== 'interrupted') return null;

  return (
    <section className={`${styles.executionPanel} ${open ? styles.executionPanelOpen : ''}`}>
      <button
        type="button"
        className={styles.executionSummary}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span
          className={`${styles.executionStateIcon} ${running ? styles.executionStateRunning : ''} ${failedCount > 0 || status === 'failed' ? styles.executionStateFailed : ''}`}
        >
          {running ? (
            <ThinkIcon size={16} />
          ) : failedCount > 0 || status === 'failed' ? (
            <AlertIcon size={16} />
          ) : (
            <CheckIcon size={16} />
          )}
        </span>
        <span className={styles.executionTitle}>{statusTitle}</span>
        <span className={styles.executionMeta}>
          {tools.length > 0 && (
            <span>{t('timeline.execution.toolCount', { count: tools.length })}</span>
          )}
          {running && (modelWait || tools.length === 0) && (
            <span className={styles.thinkingText} title={modelWaitTitle}>
              {modelWait
                ? modelWait.requestSentAt
                  ? `${t('timeline.wait.firstPacket', { iteration: modelWait.iteration, seconds: modelWaitSeconds })}${
                      modelWait.attempt && modelWait.attempt > 1
                        ? t('timeline.wait.attemptSuffix', { attempt: modelWait.attempt })
                        : ''
                    }`
                  : t('timeline.wait.preparing', {
                      iteration: modelWait.iteration,
                      seconds: modelWaitSeconds,
                    })
                : thinkingPhase}
              <span className={styles.thinkDots} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </span>
          )}
          <span className={styles.executionDuration}>
            {' · '}
            {t('timeline.execution.duration', { duration: durationLabel })}
          </span>
          {failedCount > 0 && (
            <span className={styles.executionFailed}>
              {' · '}
              {t('timeline.execution.failedCount', { count: failedCount })}
            </span>
          )}
        </span>
        <ChevronRightIcon
          size={15}
          className={`${styles.executionChevron} ${open ? styles.executionChevronOpen : ''}`}
        />
      </button>

      {open && (
        <div className={styles.executionBody}>
          {bodyEmpty && running && (
            <div className={styles.skeletonLines} aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          )}
          {thinking && <ThinkBlock text={thinking} />}
          {groups.map((group) => (
            <div key={`process-${group.step}`} className={styles.processStep}>
              {group.compactionNote && (
                <div className={styles.compactionNote}>
                  <ScissorsIcon size={12} />
                  <span>{group.compactionNote}</span>
                </div>
              )}
              {group.planNote && (
                <div
                  className={`${styles.planNote} ${styles[`planNote_${group.planNote.kind}`] ?? ''}`}
                >
                  <span>{group.planNote.text}</span>
                </div>
              )}
              {group.tools.length > 0 && (
                <ul className={styles.toolList} aria-label={t('timeline.tools.ariaLabel')}>
                  {group.tools.map((tool) => (
                    <ToolActionRow
                      key={tool.operationKey ?? `${tool.tool}-${tool.startedAt}`}
                      data={tool}
                      runId={runId}
                    />
                  ))}
                </ul>
              )}
              {group.reasoning?.visible && (
                <div className={styles.processNote}>
                  <CollapsibleText text={group.reasoning.visible} maxChars={520} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export const Timeline = memo(function Timeline({
  run,
  embedded = false,
  optimistic = false,
  onRunTerminal,
  onRetryCommand,
  onContextUsage,
  onPlan,
}: TimelineProps) {
  const { t, language } = useI18n();
  // 传输方式按 Run 状态分流：
  // - live（running/stopping）：常驻 SSE，边流边推。
  // - snapshot（已终态）：一次性取回。已完成 Run 的事件不可变，用 SSE 会让每个历史回合
  //   各占一条长连接——浏览器同源只有 6 条并发额度，长会话打开时历史连接会把正在流式的
  //   Run 挤出队列。且 `?live=0` 的回放结束会让 EventSource 自动重连（无限刷请求），
  //   所以这里换的是传输方式，不是给 SSE 传 live=false。
  const isLive = run?.status === 'running' || run?.status === 'stopping';
  const { events, streamedText } = useEventStream(
    optimistic ? null : (run?.runId ?? null),
    isLive ? 'live' : 'snapshot',
    !optimistic && run?.status === 'running' ? onRunTerminal : undefined,
  );
  const [openFile, setOpenFile] = useState<FileEntry | null>(null);
  // 产出文件默认收起，只在用户需要时展开，避免长文件列表遮挡对话内容。
  const [filesOpen, setFilesOpen] = useState(false);
  const [openedInBrowser, setOpenedInBrowser] = useState<string | null>(null);
  const [fileActionError, setFileActionError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const getScrollContainer = useCallback(() => findScrollContainer(scrollRef.current), []);

  useEffect(() => {
    setFilesOpen(false);
  }, [run?.runId]);

  const onScroll = useCallback(() => {
    const el = getScrollContainer();
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    autoScrollRef.current = atBottom;
  }, [getScrollContainer]);

  // Embedded turns share App's session scroller and its follow state.
  // Only standalone Timelines manage their own scroll position here.
  useEffect(() => {
    if (embedded) return;
    const el = getScrollContainer();
    if (!el) return;
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [embedded, getScrollContainer, onScroll]);

  // Scroll once per rendered batch, immediately. Repeated smooth scrolling
  // queues animations and makes a fast stream visibly lag behind the text.
  useEffect(() => {
    if (embedded) return;
    if (!autoScrollRef.current) return;
    const el = getScrollContainer();
    if (!el) return;
    const frame = window.requestAnimationFrame(() => {
      if (autoScrollRef.current) el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [embedded, events, getScrollContainer]);

  const openInBrowser = async (file: FileEntry) => {
    if (!run) return;
    setFileActionError(null);
    try {
      await openFileInDefaultBrowser(run.runId, file.name);
      setOpenedInBrowser(file.name);
    } catch {
      setFileActionError(t('timeline.files.openError'));
    }
  };

  // ---- 答案派生：引用稳定时跳过全串正则（stripThinkTags 是剩余最大单点成本）----
  // rawFinalAnswer：优先级与 buildStructure 原逻辑一致（final_answer > run_completed.result
  // > run.result > 流式增量全文）。流式中其引用 = streamedText 引用，仅在 delta 帧变化。
  const rawFinalAnswer = useMemo(
    () => (run ? deriveRawFinalAnswer(run, events, streamedText) : null),
    [run, events, streamedText],
  );
  // stripThinkTags 三趟全串正则只随 rawFinalAnswer 引用变化重算：
  // context_usage/tool 等非 delta 帧不触碰 streamedText → 这里跳过，避免每帧 O(全文) 正则。
  const finalParsed = useMemo(
    () => (rawFinalAnswer ? stripThinkTags(rawFinalAnswer) : null),
    [rawFinalAnswer],
  );

  const structure = useMemo<BuildOut | null>(() => {
    if (!run) return null;
    return buildStructure(run, events, rawFinalAnswer, finalParsed, language);
  }, [run, events, rawFinalAnswer, finalParsed, language]);

  // 计划清单：从事件派生（取 revision 最大的一条），无计划事件 → null。
  // 面板不再画在对话流里：这里只把派生结果上抛给宿主（输入栏上方的"当前计划"），
  // 且只有最新一轮 Run 会拿到 onPlan —— 下一轮开始后旧计划自然不再展示。
  const plan = useMemo(() => derivePlan(events), [events]);
  useEffect(() => {
    onPlan?.(plan);
  }, [onPlan, plan]);

  // ---- v2.0.1 JIT Approval：收集未裁决的批准请求，用户点击后回传 Host ----
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const resolvedIdsRef = useRef<Set<string>>(new Set());
  const pendingApprovals = useMemo(() => {
    if (!events.length) return [];
    // 已裁决的（approval_resolved）不显示
    const resolved = new Set(
      events
        .filter(
          (e): e is Extract<HostEvent, { type: 'approval_resolved' }> =>
            e.type === 'approval_resolved',
        )
        .map((e) => e.requestId),
    );
    return events.filter(
      (e): e is ApprovalRequestedEvent =>
        e.type === 'approval_requested' && !resolved.has(e.requestId),
    );
  }, [events]);

  const handleApproval = async (ev: ApprovalRequestedEvent, approved: boolean) => {
    if (!run) return;
    setResolvingIds((prev) => new Set(prev).add(ev.requestId));
    try {
      await resolveApproval(run.runId, ev.requestId, approved);
      resolvedIdsRef.current.add(ev.requestId);
    } catch {
      // 网络失败：保留卡片让用户重试
      setResolvingIds((prev) => {
        const next = new Set(prev);
        next.delete(ev.requestId);
        return next;
      });
    }
  };

  const [resolvingPreparationIds, setResolvingPreparationIds] = useState<Set<string>>(new Set());
  const pendingPreparations = useMemo(() => {
    if (!events.length) return [];
    const resolved = new Set(
      events
        .filter(
          (e): e is Extract<HostEvent, { type: 'toolchain_preparation_resolved' }> =>
            e.type === 'toolchain_preparation_resolved',
        )
        .map((e) => e.requestId),
    );
    return events.filter(
      (e): e is ToolchainPreparationRequestedEvent =>
        e.type === 'toolchain_preparation_requested' && !resolved.has(e.requestId),
    );
  }, [events]);

  const preparationPhases = useMemo(() => {
    const phases = new Map<string, ToolchainPreparationPhase>();
    for (const event of events) {
      if (event.type === 'toolchain_preparation_started') {
        phases.set(event.requestId, event.phase);
      } else if (event.type === 'toolchain_preparation_progress') {
        phases.set(event.requestId, event.phase);
      }
    }
    return phases;
  }, [events]);

  // v1.6 工具链闭环②：prepared 的准备请求 → 展示"重新执行刚才的命令"入口。
  // 点击以新会话轮次发起（全新 side-effect 身份空间），由用户显式触发。
  const preparedResolutions = useMemo(() => {
    if (!events.length) return [];
    return events.filter(
      (e): e is Extract<HostEvent, { type: 'toolchain_preparation_resolved' }> =>
        e.type === 'toolchain_preparation_resolved' && e.approved === true && e.prepared === true,
    );
  }, [events]);
  const retryCommand = useMemo(() => findLastFailedShellCommand(events), [events]);
  const runActive = run?.status === 'running' || run?.status === 'stopping';

  const handleToolchainPreparation = async (
    ev: ToolchainPreparationRequestedEvent,
    action: 'approve' | 'deny' | 'cancel',
  ) => {
    if (!run) return;
    setResolvingPreparationIds((prev) => new Set(prev).add(ev.requestId));
    try {
      if (action === 'cancel') {
        await cancelToolchainPreparation(run.runId, ev.requestId);
      } else {
        await resolveToolchainPreparation(run.runId, ev.requestId, action === 'approve');
      }
    } catch {
      // Keep the card visible so the user can retry when the Host is reachable.
    } finally {
      setResolvingPreparationIds((prev) => {
        const next = new Set(prev);
        next.delete(ev.requestId);
        return next;
      });
    }
  };

  if (!run || !structure) {
    return (
      <div ref={scrollRef} className={styles.timelineWrap}>
        <div className={styles.empty}>{t('timeline.empty')}</div>
      </div>
    );
  }

  const {
    runStarted,
    finalAnswer,
    finalTimestamp,
    finalError,
    producedFiles: files,
    lastStepRunning,
    toolSteps,
    globalThinking,
  } = structure;

  // 上下文预算环形指示器：取最新一条 context_usage（压缩/紧急裁剪状态随之可见）
  const latestContextUsage = findLatestContextUsage(events);
  // 首个 token 等待期：运行中且最后一条事件是 llm_call_started（任何后续事件都意味着等待结束）。
  // 父组件 running 期间每 1.2s tick，秒数随之实时刷新。
  const modelWait = run.status === 'running' ? deriveModelWaitState(events, Date.now()) : null;
  // 上抛给宿主（输入栏底部环形指示器的数据源）；随 events 变化自动更新
  useEffect(() => {
    onContextUsage?.(latestContextUsage);
  }, [onContextUsage, latestContextUsage]);

  // Has any work actually been performed? (tools + visible reasoning + final answer).
  // running 时强制渲染：首条事件（reasoning/tool）到达前的空窗期也要立刻给出
  // 「正在执行 · 正在分析」反馈，否则发消息后有几秒完全无响应的观感。
  const hasAnyWork =
    toolSteps.some(
      (g) =>
        g.tools.length > 0 || (g.reasoning && (g.reasoning.visible || g.reasoning.thinkingDetail)),
    ) ||
    !!finalAnswer ||
    !!globalThinking ||
    !!finalError ||
    run.status !== 'stopping';

  return (
    <div
      id={run ? `run-${run.runId}` : undefined}
      ref={scrollRef}
      className={`${styles.timelineWrap} ${embedded ? styles.embedded : ''}`}
    >
      <div className={styles.timeline}>
        <article className={styles.userBlock}>
          {/* 用户消息与助手正文共用 MarkdownText：手打的 **加粗**、# 标题、列表、代码块
              都按 Markdown 渲染。这里不做模型输出那套畸形 fence 修复 —— 不改写用户原文。 */}
          <div className={styles.userText}>
            <MarkdownText text={run.task} />
          </div>
          {runStarted?.type === 'run_started' &&
            runStarted.attachments &&
            runStarted.attachments.length > 0 && (
              <div className={styles.userAttachments}>
                {runStarted.attachments.map((att) => (
                  <a
                    key={att.path}
                    className={styles.userAttachmentLink}
                    href={workspaceFileUrl(run.runId, att.path)}
                    target="_blank"
                    rel="noreferrer"
                    title={att.name}
                  >
                    <img
                      className={styles.userAttachmentImg}
                      src={workspaceFileUrl(run.runId, att.path)}
                      alt={att.name}
                      loading="lazy"
                    />
                  </a>
                ))}
              </div>
            )}
          <div className={styles.userMeta}>
            <time className={styles.time}>
              {formatTime(runStarted?.timestamp ?? run.createdAt, language)}
            </time>
            {/* 复制用户自己发出的原文：与时间戳同一页脚行、低调的纯图标按钮 */}
            <CopyButton text={run.task} iconOnly />
          </div>
        </article>

        {hasAnyWork ? (
          <section className={styles.agentBlock}>
            {pendingApprovals.length > 0 && (
              <div className={styles.approvalList}>
                {pendingApprovals.map((ev) => (
                  <div key={ev.requestId} className={styles.approvalCard}>
                    <div className={styles.approvalTitle}>
                      {t('timeline.approval.networkTitle')}
                    </div>
                    <div className={styles.approvalBody}>
                      <code>{ev.toolName}</code> {t('timeline.approval.networkBody')}
                      <span className={styles.approvalArgs}>
                        {JSON.stringify(ev.args ?? {}).slice(0, 120)}
                      </span>
                    </div>
                    <div className={styles.approvalActions}>
                      <button
                        type="button"
                        className={styles.approvalAllow}
                        disabled={resolvingIds.has(ev.requestId)}
                        onClick={() => void handleApproval(ev, true)}
                      >
                        {resolvingIds.has(ev.requestId)
                          ? t('timeline.approval.submitting')
                          : t('timeline.approval.allow')}
                      </button>
                      <button
                        type="button"
                        className={styles.approvalDeny}
                        disabled={resolvingIds.has(ev.requestId)}
                        onClick={() => void handleApproval(ev, false)}
                      >
                        {t('timeline.approval.deny')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {pendingPreparations.length > 0 && (
              <div className={styles.approvalList}>
                {pendingPreparations.map((ev) => (
                  <div key={ev.requestId} className={styles.approvalCard}>
                    <div className={styles.approvalTitle}>{t('timeline.preparation.title')}</div>
                    <div className={styles.approvalBody}>
                      {t('timeline.preparation.missingPrefix')} <code>{ev.toolName}</code>
                      {t('timeline.preparation.missingSuffix')}
                      <span className={styles.approvalArgs}>
                        {t('timeline.preparation.detail', {
                          source: ev.source,
                          packageName: ev.packageName,
                        })}
                      </span>
                      {preparationPhases.has(ev.requestId) && (
                        <span className={styles.approvalProgress}>
                          {preparationPhaseLabel(preparationPhases.get(ev.requestId)!, language)}
                        </span>
                      )}
                    </div>
                    <div className={styles.approvalActions}>
                      {preparationPhases.has(ev.requestId) ? (
                        <button
                          type="button"
                          className={styles.approvalDeny}
                          disabled={resolvingPreparationIds.has(ev.requestId)}
                          onClick={() => void handleToolchainPreparation(ev, 'cancel')}
                        >
                          {resolvingPreparationIds.has(ev.requestId)
                            ? t('timeline.preparation.cancelling')
                            : t('timeline.preparation.cancel')}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={styles.approvalAllow}
                            disabled={resolvingPreparationIds.has(ev.requestId)}
                            onClick={() => void handleToolchainPreparation(ev, 'approve')}
                          >
                            {resolvingPreparationIds.has(ev.requestId)
                              ? t('timeline.approval.submitting')
                              : t('timeline.preparation.approve')}
                          </button>
                          <button
                            type="button"
                            className={styles.approvalDeny}
                            disabled={resolvingPreparationIds.has(ev.requestId)}
                            onClick={() => void handleToolchainPreparation(ev, 'deny')}
                          >
                            {t('timeline.approval.deny')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {preparedResolutions.length > 0 && (
              <div className={styles.approvalList}>
                {preparedResolutions.map((ev) => (
                  <div key={`prepared-${ev.requestId}`} className={styles.approvalCard}>
                    <div className={styles.approvalTitle}>{t('timeline.prepared.title')}</div>
                    <div className={styles.approvalBody}>
                      {t('timeline.prepared.body')}
                      {!retryCommand && (
                        <span className={styles.approvalArgs}>
                          {t('timeline.prepared.noFailedCommand')}
                        </span>
                      )}
                    </div>
                    <div className={styles.approvalActions}>
                      <button
                        type="button"
                        className={styles.approvalAllow}
                        disabled={runActive || !retryCommand || !onRetryCommand}
                        title={
                          runActive
                            ? t('timeline.prepared.retryBlockedRunning')
                            : !retryCommand
                              ? t('timeline.prepared.retryBlockedNoCommand')
                              : undefined
                        }
                        onClick={() => {
                          if (retryCommand && onRetryCommand) {
                            onRetryCommand(composeToolchainRetryMessage(retryCommand, language));
                          }
                        }}
                      >
                        {t('timeline.prepared.retry')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <ExecutionPanel
              groups={toolSteps}
              thinking={globalThinking}
              running={lastStepRunning}
              modelWait={modelWait}
              startedAt={runStarted?.timestamp ?? run.createdAt}
              status={run.status}
              finishedAt={finalTimestamp}
              runId={run.runId}
            />

            {/* Final result — exactly once, no card, no success badge. */}
            {finalAnswer && (
              <div className={styles.finalBlock}>
                <CollapsibleText text={finalAnswer} streaming={lastStepRunning} />
                {finalError && <div className={styles.finalError}>{finalError}</div>}
                {files.length > 0 && (
                  <div className={styles.artifacts}>
                    <button
                      type="button"
                      className={styles.artifactsSummary}
                      onClick={() => setFilesOpen((value) => !value)}
                      aria-expanded={filesOpen}
                    >
                      <span className={styles.artifactsSummaryIcon}>
                        <FileIcon />
                      </span>
                      <span>{t('timeline.files.changedCount', { count: files.length })}</span>
                      <span className={styles.artifactsSummaryPreview}>
                        {files.length === 1
                          ? files[0].name
                          : t('timeline.files.andMore', { name: files[0].name })}
                      </span>
                      <ChevronRightIcon
                        size={14}
                        className={`${styles.artifactsChevron} ${filesOpen ? styles.artifactsChevronOpen : ''}`}
                      />
                    </button>
                    {filesOpen && (
                      <ul className={styles.attachList}>
                        {files.map((f) => (
                          <li key={f.name}>
                            <div className={styles.attachCard}>
                              <span className={styles.attachIcon}>
                                <FileIcon />
                              </span>
                              <span className={styles.attachInfo}>
                                <span className={styles.attachName}>{f.name}</span>
                                {typeof f.size === 'number' && (
                                  <span className={styles.attachSize}>{formatBytes(f.size)}</span>
                                )}
                              </span>
                              <span className={styles.attachActions}>
                                <button
                                  type="button"
                                  className={styles.attachAction}
                                  onClick={() => setOpenFile(f)}
                                >
                                  {t('timeline.files.view')}
                                </button>
                                <button
                                  type="button"
                                  className={styles.attachBrowserAction}
                                  onClick={() => void openInBrowser(f)}
                                >
                                  {openedInBrowser === f.name
                                    ? t('timeline.files.opened')
                                    : t('timeline.files.open')}
                                </button>
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {fileActionError && (
                      <div className={styles.fileActionError}>{fileActionError}</div>
                    )}
                  </div>
                )}
              </div>
            )}
            {!finalAnswer && finalError && <div className={styles.finalError}>{finalError}</div>}
            <RunUsage run={run} events={events} />
          </section>
        ) : (
          // Empty agent section: reserved vertical rhythm so input isn't jumpy.
          <section className={styles.agentBlock} aria-hidden="true" />
        )}
      </div>

      {openFile && run && (
        <FileModal runId={run.runId} file={openFile} onClose={() => setOpenFile(null)} />
      )}
    </div>
  );
});

function FileIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

// --- Data aggregation -----------------------------------------------------

interface BuildOut {
  runStarted: HostEvent | undefined;
  finalAnswer: string | null;
  finalTimestamp: string;
  finalError: string | null;
  /** 本次 run 实际写入/编辑过的文件（来自成功的 write/edit 工具调用），不是整个工作区。 */
  producedFiles: FileEntry[];
  toolSteps: ToolStepGroup[];
  lastStepRunning: boolean;
  /** Global reasoning bucket for disclosure (currently unused by default UI). */
  globalThinking: string;
}

interface ToolStepGroup {
  step: number;
  reasoning: ReasoningBlock | null;
  tools: ToolCallData[];
  /** 上下文压缩（compaction）发生在该 step 时的弱化说明，内务事件不成卡片。 */
  compactionNote?: string | null;
  /** 计划在该 step 发生变化时的弱化说明（与工具步骤的视觉呼应，不做猜测式连线）。 */
  planNote?: PlanNote | null;
}

/**
 * 答案原始文本（尚未 stripThinkTags）：final_answer > run_completed.result >
 * run.result > 流式增量全文。流式路径复用 useEventStream 增量累计的 streamedText
 * （引用稳定，见 useEventStream.flushPending），不再每帧 filter+map+join delta 事件。
 */
function deriveRawFinalAnswer(
  run: HostRun,
  events: HostEvent[],
  streamedText: string,
): string | null {
  const finalEv = events.find((e) => e.type === 'final_answer');
  const completedEv = events.find((e) => e.type === 'run_completed');
  let finalAnswer: string | null = null;
  if (finalEv && 'content' in finalEv) finalAnswer = finalEv.content?.trim() || null;
  if (!finalAnswer && completedEv && 'result' in completedEv) {
    finalAnswer = (completedEv.result as unknown as string | undefined)?.trim() || null;
  }
  if (!finalAnswer && run.result) finalAnswer = String(run.result).trim() || null;
  if (!finalAnswer) finalAnswer = streamedText || null;
  return finalAnswer;
}

type ParsedThink = ReturnType<typeof stripThinkTags>;

// llm_call 事件一旦写入事件流就不可变（对象引用也不再替换），其 think 标签解析结果
// 可以安全地按事件对象缓存。buildStructure 在流式期间每帧执行，不缓存就会对本回合
// **全部历史 llm_call** 反复跑全串正则（stripThinkTags 是 3~4 趟 O(文本) 正则）。
// WeakMap 以事件对象为键：事件被回收时缓存条目自动消失，不存在泄漏。
const llmCallParseCache = new WeakMap<
  HostEvent,
  { response: ParsedThink; reasoning: ParsedThink }
>();

function parseLlmCallText(llm: LlmCallEvent): { response: ParsedThink; reasoning: ParsedThink } {
  const cached = llmCallParseCache.get(llm);
  if (cached) return cached;
  const parsed = {
    response: stripThinkTags(llm.response ?? ''),
    reasoning: stripThinkTags(llm.reasoning ?? ''),
  };
  llmCallParseCache.set(llm, parsed);
  return parsed;
}

function buildStructure(
  run: HostRun,
  events: HostEvent[],
  rawFinalAnswer: string | null,
  finalParsed: { visible: string; thinking: string | null } | null,
  language: LanguageMode,
): BuildOut {
  const runStarted = events.find((e) => e.type === 'run_started');
  const completedEv = events.find((e) => e.type === 'run_completed');
  const failedEv = events.find((e) => e.type === 'run_failed');
  const interruptedEv = events.find((e) => e.type === 'run_interrupted');
  const errorEv = [...events].reverse().find((e) => e.type === 'error');
  const finalEv = events.find((e) => e.type === 'final_answer');

  const finalAnswer: string | null = rawFinalAnswer ? finalParsed?.visible || null : null;
  const finalThinking: string | null = rawFinalAnswer ? (finalParsed?.thinking ?? null) : null;

  const finalError: string | null =
    (failedEv && 'error' in failedEv && typeof failedEv.error === 'string'
      ? failedEv.error.trim()
      : null) ||
    (interruptedEv && 'error' in interruptedEv && typeof interruptedEv.error === 'string'
      ? interruptedEv.error.trim()
      : null) ||
    (errorEv && 'message' in errorEv && typeof errorEv.message === 'string'
      ? errorEv.message.trim()
      : null) ||
    run.error?.trim() ||
    null;

  // Group events by step.
  const byStep = new Map<number, HostEvent[]>();
  for (const ev of events) {
    if (!('step' in ev) || typeof ev.step !== 'number') continue;
    const arr = byStep.get(ev.step) ?? [];
    arr.push(ev);
    byStep.set(ev.step, arr);
  }
  const stepNumbers = [...byStep.keys()].sort((a, b) => a - b);

  const flatCards = buildFlatToolCards(events);

  const cardsByStep = new Map<number, ToolCallData[]>();
  for (const card of flatCards) {
    const step = (card as ToolCallData & { __step?: number }).__step ?? 0;
    delete (card as { __step?: number }).__step;
    const arr = cardsByStep.get(step) ?? [];
    arr.push(card);
    cardsByStep.set(step, arr);
  }

  // Terminal-run safety: force any lingering "running" cards to completed.
  if (run.status !== 'running') {
    for (const list of cardsByStep.values()) {
      for (const c of list) {
        if (c.status === 'running') c.status = 'completed';
      }
    }
  }

  // 计划变更说明：按 revision 顺序 diff 出「这一步之后计划变成了什么」，挂到对应 step。
  const planNotes = derivePlanNotes(events, language);

  const toolSteps: ToolStepGroup[] = [];
  const processedToolsEv: HostEvent[] = [];
  let globalThinkingAcc = events
    .filter((event): event is StreamingEvent => event.type === 'reasoning_delta')
    .map((event) => event.delta)
    .join('');
  if (finalThinking) {
    globalThinkingAcc += `${globalThinkingAcc ? '\n\n' : ''}${finalThinking}`;
  }

  for (const step of stepNumbers) {
    const stepEvents = byStep.get(step) ?? [];
    let reasoning: ReasoningBlock | null = null;
    {
      const llmCalls = stepEvents.filter((e): e is LlmCallEvent => e.type === 'llm_call');
      const llm = llmCalls[llmCalls.length - 1];
      if (llm) {
        const { response: parsedResponse, reasoning: parsedReasoning } = parseLlmCallText(llm);
        const thinkingParts = [
          parsedResponse.thinking,
          parsedReasoning.thinking ?? parsedReasoning.visible,
        ].filter((part): part is string => Boolean(part?.trim()));
        const thinking = thinkingParts.join('\n\n') || null;
        const visible = isDuplicateOfFinal(parsedResponse.visible, finalAnswer)
          ? ''
          : parsedResponse.visible;
        if (thinking) globalThinkingAcc += `${globalThinkingAcc ? '\n\n' : ''}${thinking}`;
        // status line is computed once globally, not per step (no multi-line states).
        reasoning = {
          step,
          timestamp: llm.timestamp,
          thinkingDetail: thinking,
          visible,
        };
      }
    }

    const tools = cardsByStep.get(step) ?? [];

    // 上下文压缩是内务事件：每个 step 至多一个，渲染为工具步骤间的弱化注释行。
    const compactionEv = stepEvents.find((e) => e.type === 'context_compaction');
    const compactionNote =
      compactionEv && compactionEv.type === 'context_compaction'
        ? translate(language, 'timeline.compaction.note', {
            count: compactionEv.totalSummarizedMessages,
          })
        : null;
    const planNote = planNotes.get(step) ?? null;

    for (const ev of stepEvents) {
      if (ev.type === 'tool_call' || ev.type === 'tool_result' || ev.type === 'tool_error') {
        processedToolsEv.push(ev);
      }
    }

    // Don't emit a step group that has neither reasoning nor tools nor a compaction note.
    if (tools.length === 0 && !reasoning && !compactionNote && !planNote) continue;
    // Don't emit a step group where reasoning contains only a pure duplicate of final answer with no tools.
    if (
      tools.length === 0 &&
      !compactionNote &&
      !planNote &&
      reasoning &&
      (!reasoning.visible || isDuplicateOfFinal(reasoning.visible, finalAnswer)) &&
      !reasoning.thinkingDetail
    )
      continue;

    toolSteps.push({ step, reasoning, tools, compactionNote, planNote });
  }

  if (toolSteps.length === 0 && run.status === 'running') {
    toolSteps.push({
      step: 0,
      reasoning: {
        step: 0,
        timestamp: runStarted?.timestamp ?? run.createdAt,
        thinkingDetail: null,
        visible: '',
      },
      tools: [],
    });
  }

  const lastStepRunning = run.status === 'running';

  // 「生成的文件」= 本次 run 通过 write/edit 实际落盘的文件（成功调用，去重）。
  // 不再列整个工作区：读过的文件（如熟悉项目时）不代表产物。
  const producedFiles: FileEntry[] = [];
  const seenWritten = new Set<string>();
  for (const card of flatCards) {
    if ((card.tool === 'write' || card.tool === 'edit') && card.status === 'completed') {
      const p = (card.args as { path?: unknown } | null)?.path;
      if (typeof p === 'string' && p.trim() && !seenWritten.has(p.trim())) {
        seenWritten.add(p.trim());
        producedFiles.push({ name: p.trim() });
      }
    }
  }

  return {
    runStarted,
    finalAnswer,
    finalTimestamp:
      (finalEv && 'timestamp' in finalEv ? finalEv.timestamp : undefined) ??
      (completedEv && 'timestamp' in completedEv ? completedEv.timestamp : undefined) ??
      run.updatedAt,
    finalError,
    producedFiles,
    toolSteps,
    lastStepRunning,
    globalThinking: globalThinkingAcc,
  };
}

function buildFlatToolCards(events: HostEvent[]): Array<ToolCallData & { __step: number }> {
  type R = ToolCallData & { __step: number };
  const cards: R[] = [];
  for (const ev of events) {
    if (ev.type === 'tool_call') {
      const call = ev as ToolCallEvent;
      const card: R = {
        operationKey: `call-${call.step}-${cards.length}`,
        tool: call.tool,
        args: call.args,
        status: 'running',
        startedAt: call.timestamp,
        __step: call.step,
      };
      cards.push(card);
      continue;
    }
    if (ev.type === 'tool_result') {
      const res = ev as ToolResultEvent;
      const target =
        [...cards].reverse().find((c) => c.status === 'running' && c.tool === res.tool) ??
        [...cards].reverse().find((c) => c.status === 'running');
      if (target) {
        target.status = 'completed';
        target.result = res.result;
        if (res.images && res.images.length > 0) target.images = res.images;
        target.durationMs =
          res.durationMs != null
            ? res.durationMs
            : computeDurationMs(target.startedAt, res.timestamp);
      }
      continue;
    }
    if (ev.type === 'tool_error') {
      const err = ev as ToolErrorEvent;
      const target =
        [...cards].reverse().find((c) => c.status === 'running' && c.tool === err.tool) ??
        [...cards].reverse().find((c) => c.status === 'running');
      if (target) {
        target.status = 'failed';
        target.error = err.error;
        target.durationMs = computeDurationMs(target.startedAt, err.timestamp);
      }
    }
  }
  return cards;
}

function computeDurationMs(startedAt: string, endedAt: string): number {
  const s = new Date(startedAt).getTime();
  const e = new Date(endedAt).getTime();
  return Math.max(0, e - s);
}

function elapsedSeconds(startedAt: string): number {
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}
