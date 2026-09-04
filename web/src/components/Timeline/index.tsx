import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FileEntry,
  HostEvent,
  HostRun,
  LlmCallEvent,
  ToolCallEvent,
  ToolErrorEvent,
  ToolResultEvent,
  StreamingEvent,
  ApprovalRequestedEvent,
} from '../../types';
import { formatBytes, formatTime, isDuplicateOfFinal, stripThinkTags } from '../../format';
import { useEventStream } from '../../hooks/useEventStream';
import { openFileInDefaultBrowser, resolveApproval } from '../../api';
import { CollapsibleText } from '../CollapsibleText';
import { FileModal } from '../FileModal';
import { ThinkBlock } from './ThinkBlock';
import { ToolActionRow } from './ToolActionRow';
import { CheckIcon, ChevronRightIcon, ScissorsIcon } from '../icons';
import styles from './Timeline.module.css';

interface TimelineProps {
  run: HostRun | null;
  modelFallback: string | null;
  embedded?: boolean;
  onRunTerminal?: () => void;
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
  startedAt,
}: {
  groups: ToolStepGroup[];
  thinking: string;
  running: boolean;
  startedAt: string | undefined;
}) {
  const [open, setOpen] = useState(running);
  const wasRunning = useRef(running);
  const tools = groups.flatMap(group => group.tools);
  const failedCount = tools.filter(tool => tool.status === 'failed').length;
  const elapsed = running && startedAt ? elapsedSeconds(startedAt) : 0;
  // 阶段化文案：随等待时间演进，避免静态文字的呆滞感
  const thinkingPhase = elapsed < 6 ? '正在思考' : elapsed < 20 ? '正在分析' : '正在处理复杂任务';
  const bodyEmpty =
    !thinking
    && tools.length === 0
    && !groups.some(g => g.reasoning?.visible || g.compactionNote);
  const hasDetails =
    Boolean(thinking)
    || tools.length > 0
    || groups.some(group => group.reasoning?.visible)
    || groups.some(group => group.compactionNote);

  useEffect(() => {
    if (running) setOpen(true);
    else if (wasRunning.current) setOpen(false);
    wasRunning.current = running;
  }, [running]);

  if (!hasDetails && !running) return null;

  return (
    <section className={`${styles.executionPanel} ${open ? styles.executionPanelOpen : ''}`}>
      <button
        type="button"
        className={styles.executionSummary}
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <span className={`${styles.executionStateIcon} ${running ? styles.executionStateRunning : ''}`}>
          {running ? <span className={styles.runDot} /> : <CheckIcon size={14} />}
        </span>
        <span className={styles.executionTitle}>{running ? '正在执行' : '执行完成'}</span>
        <span className={styles.executionMeta}>
          {tools.length > 0 && <span>{`${tools.length} 个操作`}</span>}
          {running && tools.length === 0 && (
            <span className={styles.thinkingText}>
              {thinkingPhase}
              <span className={styles.thinkDots} aria-hidden="true"><i /><i /><i /></span>
              {elapsed >= 8 ? ` · ${elapsed}s` : ''}
            </span>
          )}
          {!running && tools.length === 0 && <span>正在分析</span>}
          {failedCount > 0 && <span className={styles.executionFailed}> · {failedCount} 个失败</span>}
        </span>
        <ChevronRightIcon size={15} className={`${styles.executionChevron} ${open ? styles.executionChevronOpen : ''}`} />
      </button>

      {open && (
        <div className={styles.executionBody}>
          {bodyEmpty && running && (
            <div className={styles.skeletonLines} aria-hidden="true"><i /><i /><i /></div>
          )}
          {thinking && <ThinkBlock text={thinking} />}
          {groups.map((group, index) => (
            <div key={`process-${group.step}-${index}`} className={styles.processStep}>
              {group.compactionNote && (
                <div className={styles.compactionNote}>
                  <ScissorsIcon size={12} />
                  <span>{group.compactionNote}</span>
                </div>
              )}
              {group.tools.length > 0 && (
                <ul className={styles.toolList} aria-label="工具">
                  {group.tools.map(tool => (
                    <ToolActionRow
                      key={tool.operationKey ?? `${tool.tool}-${tool.startedAt}`}
                      data={tool}
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

export function Timeline({ run, embedded = false, onRunTerminal }: TimelineProps) {
  // 注意：这里 live 固定为 true，不能跟随 run.status 变化。
  // 如果 live 依赖 run.status，轮询把 status 从 running→completed 时会触发 useEventStream useEffect 重跑，
  // 此时用 live=?live=0 新建连接，后端回放完直接 sink.end() 会让浏览器 EventSource 每 3 秒自动重连 → 无限刷 SSE 请求。
  // 正确的关闭时机交给 useEventStream 内部：收到 run_completed/run_failed/run_stopped/run_interrupted 后主动 close SSE。
  const { events } = useEventStream(
    run?.runId ?? null,
    true,
    run?.status === 'running' ? onRunTerminal : undefined,
  );
  const [openFile, setOpenFile] = useState<FileEntry | null>(null);
  const [openedInBrowser, setOpenedInBrowser] = useState<string | null>(null);
  const [fileActionError, setFileActionError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const [, setForceTick] = useState(0);

  // Light tick while running so status line / duration updates.
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const id = setInterval(() => setForceTick(t => t + 1), 1200);
    return () => clearInterval(id);
  }, [run?.runId, run?.status]);

  const scrollEndRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!autoScrollRef.current) return;
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length, run?.status]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    autoScrollRef.current = atBottom;
  };

  const openInBrowser = async (file: FileEntry) => {
    if (!run) return;
    setFileActionError(null);
    try {
      await openFileInDefaultBrowser(run.runId, file.name);
      setOpenedInBrowser(file.name);
    } catch {
      setFileActionError('无法使用默认浏览器打开该文件。');
    }
  };

  const structure = useMemo<BuildOut | null>(() => {
    if (!run) return null;
    return buildStructure(run, events);
  }, [run, events]);

  // ---- v2.0.1 JIT Approval：收集未裁决的批准请求，用户点击后回传 Host ----
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const resolvedIdsRef = useRef<Set<string>>(new Set());
  const pendingApprovals = useMemo(() => {
    if (!events.length) return [];
    // 已裁决的（approval_resolved）不显示
    const resolved = new Set(
      events
        .filter((e): e is Extract<HostEvent, { type: 'approval_resolved' }> => e.type === 'approval_resolved')
        .map((e) => e.requestId),
    );
    return events.filter(
      (e): e is ApprovalRequestedEvent => e.type === 'approval_requested' && !resolved.has(e.requestId),
    );
  }, [events]);

  const handleApproval = async (ev: ApprovalRequestedEvent, approved: boolean) => {
    if (!run) return;
    setResolvingIds(prev => new Set(prev).add(ev.requestId));
    try {
      await resolveApproval(run.runId, ev.requestId, approved);
      resolvedIdsRef.current.add(ev.requestId);
    } catch {
      // 网络失败：保留卡片让用户重试
      setResolvingIds(prev => {
        const next = new Set(prev);
        next.delete(ev.requestId);
        return next;
      });
    }
  };

  if (!run || !structure) {
    return (
      <div ref={scrollRef} onScroll={onScroll} className={styles.timelineWrap}>
        <div className={styles.empty}>选择或创建一个任务开始。</div>
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

  // Has any work actually been performed? (tools + visible reasoning + final answer).
  // running 时强制渲染：首条事件（reasoning/tool）到达前的空窗期也要立刻给出
  // 「正在执行 · 正在分析」反馈，否则发消息后有几秒完全无响应的观感。
  const hasAnyWork =
    toolSteps.some(g => g.tools.length > 0 || (g.reasoning && (g.reasoning.visible || g.reasoning.thinkingDetail)))
    || !!finalAnswer
    || !!globalThinking
    || run.status === 'running';

  return (
    <div
      id={run ? `run-${run.runId}` : undefined}
      ref={scrollRef}
      onScroll={onScroll}
      className={`${styles.timelineWrap} ${embedded ? styles.embedded : ''}`}
    >
      <div className={styles.timeline}>
        <article className={styles.userBlock}>
          <p className={styles.userText}>{run.task}</p>
          <time className={styles.time}>{formatTime(runStarted?.timestamp ?? run.createdAt)}</time>
        </article>

        {hasAnyWork ? (
          <section className={styles.agentBlock}>
            {pendingApprovals.length > 0 && (
              <div className={styles.approvalList}>
                {pendingApprovals.map(ev => (
                  <div key={ev.requestId} className={styles.approvalCard}>
                    <div className={styles.approvalTitle}>
                      网络访问批准请求
                    </div>
                    <div className={styles.approvalBody}>
                      <code>{ev.toolName}</code> 请求网络访问
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
                        {resolvingIds.has(ev.requestId) ? '提交中…' : '允许'}
                      </button>
                      <button
                        type="button"
                        className={styles.approvalDeny}
                        disabled={resolvingIds.has(ev.requestId)}
                        onClick={() => void handleApproval(ev, false)}
                      >
                        拒绝
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
              startedAt={runStarted?.timestamp ?? run.createdAt}
            />

            {/* Final result — exactly once, no card, no success badge. */}
            {finalAnswer && (
              <div className={styles.finalBlock}>
                <CollapsibleText text={finalAnswer} />
                {finalError && run.status !== 'running' && (
                  <div className={styles.finalError}>
                    {finalError}
                  </div>
                )}
                {files.length > 0 && (
                  <div className={styles.artifacts}>
                    <div className={styles.artifactsTitle}>生成的文件</div>
                    <ul className={styles.attachList}>
                      {files.map(f => (
                        <li key={f.name}>
                          <div className={styles.attachCard}>
                            <span className={styles.attachIcon}><FileIcon /></span>
                            <span className={styles.attachInfo}>
                              <span className={styles.attachName}>{f.name}</span>
                              {typeof f.size === 'number' && (
                                <span className={styles.attachSize}>{formatBytes(f.size)}</span>
                              )}
                            </span>
                            <span className={styles.attachActions}>
                              <button type="button" className={styles.attachAction} onClick={() => setOpenFile(f)}>
                                查看
                              </button>
                              <button type="button" className={styles.attachBrowserAction} onClick={() => void openInBrowser(f)}>
                                {openedInBrowser === f.name ? '已打开' : '打开'}
                              </button>
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {fileActionError && <div className={styles.fileActionError}>{fileActionError}</div>}
                  </div>
                )}
                <time className={styles.finalTime}>{formatTime(finalTimestamp)}</time>
              </div>
            )}
            {!finalAnswer && finalError && run.status !== 'running' && (
              <div className={styles.finalError}>{finalError}</div>
            )}
          </section>
        ) : (
          // Empty agent section: reserved vertical rhythm so input isn't jumpy.
          <section className={styles.agentBlock} aria-hidden="true" />
        )}

        <span ref={scrollEndRef} />
      </div>

      {openFile && run && (
        <FileModal runId={run.runId} file={openFile} onClose={() => setOpenFile(null)} />
      )}
    </div>
  );
}

function FileIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
}

function buildStructure(
  run: HostRun,
  events: HostEvent[],
): BuildOut {
  const runStarted = events.find(e => e.type === 'run_started');
  const completedEv = events.find(e => e.type === 'run_completed');
  const failedEv = events.find(e => e.type === 'run_failed');
  const finalEv = events.find(e => e.type === 'final_answer');

  let finalAnswer: string | null = null;
  if (finalEv && 'content' in finalEv) finalAnswer = finalEv.content?.trim() || null;
  if (!finalAnswer && completedEv && 'result' in completedEv) {
    finalAnswer = (completedEv.result as unknown as string | undefined)?.trim() || null;
  }
  if (!finalAnswer && run.result) finalAnswer = String(run.result).trim() || null;
  if (!finalAnswer) {
    const streamed = events
      .filter((event): event is StreamingEvent => event.type === 'assistant_delta')
      .map((event) => event.delta)
      .join('');
    finalAnswer = streamed || null;
  }
  let finalThinking: string | null = null;
  if (finalAnswer) {
    const parsedFinal = stripThinkTags(finalAnswer);
    finalAnswer = parsedFinal.visible || null;
    finalThinking = parsedFinal.thinking;
  }

  const finalError: string | null =
    failedEv && 'error' in failedEv
      ? (failedEv.error as unknown as string)?.trim?.() || null
      : run.error?.trim?.() || null;

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
        const parsedResponse = stripThinkTags(llm.response ?? '');
        const parsedReasoning = stripThinkTags(llm.reasoning ?? '');
        const thinkingParts = [parsedResponse.thinking, parsedReasoning.thinking ?? parsedReasoning.visible]
          .filter((part): part is string => Boolean(part?.trim()));
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
    const compactionEv = stepEvents.find(e => e.type === 'context_compaction');
    const compactionNote =
      compactionEv && compactionEv.type === 'context_compaction'
        ? `上下文已压缩 · ${compactionEv.totalSummarizedMessages} 条早期对话已摘要保留要点`
        : null;

    for (const ev of stepEvents) {
      if (ev.type === 'tool_call' || ev.type === 'tool_result' || ev.type === 'tool_error') {
        processedToolsEv.push(ev);
      }
    }

    // Don't emit a step group that has neither reasoning nor tools nor a compaction note.
    if (tools.length === 0 && !reasoning && !compactionNote) continue;
    // Don't emit a step group where reasoning contains only a pure duplicate of final answer with no tools.
    if (
      tools.length === 0
      && !compactionNote
      && reasoning
      && (!reasoning.visible || isDuplicateOfFinal(reasoning.visible, finalAnswer))
      && !reasoning.thinkingDetail
    ) continue;

    toolSteps.push({ step, reasoning, tools, compactionNote });
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
      (finalEv && 'timestamp' in finalEv ? finalEv.timestamp : undefined)
      ?? (completedEv && 'timestamp' in completedEv ? completedEv.timestamp : undefined)
      ?? run.updatedAt,
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
      const target = [...cards].reverse().find(c => c.status === 'running' && c.tool === res.tool)
        ?? [...cards].reverse().find(c => c.status === 'running');
      if (target) {
        target.status = 'completed';
        target.result = res.result;
        target.durationMs =
          res.durationMs != null
            ? res.durationMs
            : computeDurationMs(target.startedAt, res.timestamp);
      }
      continue;
    }
    if (ev.type === 'tool_error') {
      const err = ev as ToolErrorEvent;
      const target = [...cards].reverse().find(c => c.status === 'running' && c.tool === err.tool)
        ?? [...cards].reverse().find(c => c.status === 'running');
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
