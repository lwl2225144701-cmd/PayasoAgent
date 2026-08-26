import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FileEntry,
  HostEvent,
  HostRun,
  LlmCallEvent,
  ToolCallEvent,
  ToolErrorEvent,
  ToolResultEvent,
} from '../../types';
import { formatBytes, formatTime, isDuplicateOfFinal, stripThinkTags } from '../../format';
import { useEventStream } from '../../hooks/useEventStream';
import { listFiles } from '../../api';
import { CollapsibleText } from '../CollapsibleText';
import { FileModal } from '../FileModal';
import { ThinkBlock } from './ThinkBlock';
import { ToolActionRow } from './ToolActionRow';
import styles from './Timeline.module.css';

interface TimelineProps {
  run: HostRun | null;
  modelFallback: string | null;
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

export function Timeline({ run }: TimelineProps) {
  const { events } = useEventStream(run?.runId ?? null);
  const [openFile, setOpenFile] = useState<FileEntry | null>(null);
  const [producedFiles, setProducedFiles] = useState<Record<string, FileEntry[]> | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const [, setForceTick] = useState(0);

  // Light tick while running so status line / duration updates.
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const id = setInterval(() => setForceTick(t => t + 1), 1200);
    return () => clearInterval(id);
  }, [run?.runId, run?.status]);

  useEffect(() => {
    if (!run) {
      setProducedFiles(undefined);
      return;
    }
    let cancelled = false;
    setProducedFiles(undefined);
    listFiles(run.runId)
      .then(resp => {
        if (cancelled || !resp?.files) return;
        setProducedFiles({ __global: resp.files });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [run?.runId]);

  const scrollEndRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!autoScrollRef.current) return;
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length, run?.status, producedFiles]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    autoScrollRef.current = atBottom;
  };

  const structure = useMemo<BuildOut | null>(() => {
    if (!run) return null;
    return buildStructure(run, events, producedFiles ?? {});
  }, [run, events, producedFiles]);

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
    finalError,
    producedFiles: files,
    lastStepRunning,
    toolSteps,
    globalThinking,
  } = structure;

  // Do we have any tool that's currently in progress? If so, the tool itself
  // carries the visual status and we don't need an extra "正在处理…" banner.
  const anyToolRunning = toolSteps.some(g => g.tools.some(t => t.status === 'running'));
  const showGlobalRunningBanner = lastStepRunning && !anyToolRunning;

  // Has any work actually been performed? (tools + visible reasoning + final answer).
  const hasAnyWork =
    toolSteps.some(g => g.tools.length > 0 || (g.reasoning && (g.reasoning.visible || g.reasoning.thinkingDetail)))
    || !!finalAnswer;

  return (
    <div ref={scrollRef} onScroll={onScroll} className={styles.timelineWrap}>
      <div className={styles.timeline}>
        <article className={styles.userBlock}>
          <p className={styles.userText}>{run.task}</p>
          <time className={styles.time}>{formatTime(runStarted?.timestamp ?? run.createdAt)}</time>
        </article>

        {hasAnyWork ? (
          <section className={styles.agentBlock}>
            {/* Extremely light temporary global status. Only shown if no running tool exists yet. */}
            {showGlobalRunningBanner && (
              <div className={styles.globalRunning}>
                <span className={styles.runDot} aria-hidden="true" />
                <span className={styles.runText}>正在处理…</span>
              </div>
            )}

            {globalThinking && <ThinkBlock text={globalThinking} />}

            {toolSteps.map((grp, grpIdx) => {
              const reasoning = grp.reasoning;
              const showVisible = reasoning
                && reasoning.visible
                && !isDuplicateOfFinal(reasoning.visible, finalAnswer);

              return (
                <div key={`step-${grp.step}-${grpIdx}`} className={styles.stepBlock}>
                  {/* Tool rows. */}
                  {grp.tools.length > 0 && (
                    <ul className={styles.toolList} aria-label="工具">
                      {grp.tools.map(t => (
                        <ToolActionRow
                          key={t.operationKey ?? `${t.tool}-${t.startedAt}`}
                          data={t}
                        />
                      ))}
                    </ul>
                  )}

                  {/* Step-wise visible assistant text. */}
                  {showVisible && (
                    <div className={styles.assistantTextBlock}>
                      <CollapsibleText text={reasoning!.visible} />
                      <time className={styles.time}>{formatTime(reasoning!.timestamp)}</time>
                    </div>
                  )}
                </div>
              );
            })}

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
                  <ul className={styles.attachList}>
                    {files.map(f => (
                      <li key={f.name}>
                        <button
                          type="button"
                          className={styles.attachBtn}
                          onClick={() => setOpenFile(f)}
                        >
                          <FileIcon />
                          <span className={styles.attachName}>{f.name}</span>
                          <span className={styles.attachSize}>{formatBytes(f.size)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
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
  finalError: string | null;
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
}

function buildStructure(
  run: HostRun,
  events: HostEvent[],
  producedMap: Record<string, FileEntry[]>,
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
  let globalThinkingAcc = '';

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
        const visible = parsedResponse.visible;
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

    for (const ev of stepEvents) {
      if (ev.type === 'tool_call' || ev.type === 'tool_result' || ev.type === 'tool_error') {
        processedToolsEv.push(ev);
      }
    }

    // Don't emit a step group that has neither reasoning nor tools.
    if (tools.length === 0 && !reasoning) continue;
    // Don't emit a step group where reasoning contains only a pure duplicate of final answer with no tools.
    if (
      tools.length === 0
      && reasoning
      && (!reasoning.visible || isDuplicateOfFinal(reasoning.visible, finalAnswer))
      && !reasoning.thinkingDetail
    ) continue;

    toolSteps.push({ step, reasoning, tools });
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
  const producedFiles = producedMap['__global'] ?? [];

  return {
    runStarted,
    finalAnswer,
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
