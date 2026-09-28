import { useEffect, useRef, useState } from 'react';
import { connectSSE, fetchRunEvents } from '../api';
import type { HostEvent } from '../types';
import { mergeStreamingEvents } from './stream-state';

// 终态事件类型：收到后 Run 已经结束，SSE 不必继续挂着，主动 close 避免浏览器自动重连
type TerminalEventType = 'run_completed' | 'run_failed' | 'run_stopped' | 'run_interrupted';
const TERMINAL_TYPES: TerminalEventType[] = [
  'run_completed',
  'run_failed',
  'run_stopped',
  'run_interrupted',
];
const isTerminal = (ev: HostEvent): boolean => (TERMINAL_TYPES as string[]).includes(ev.type);

/**
 * 事件获取方式：
 * - `live`：常驻 SSE，边流边推（Run 处于 running / stopping）。
 * - `snapshot`：一次性取回（Run 已终态，事件日志不可变）。
 *
 * 已终态 Run 刻意**不**走 `?live=0` 的 SSE：Host 回放完会 `sink.end()`，而 EventSource
 * 在流结束时必然按 retry 自动重连 → 无限刷请求。改用普通请求取回，同时避免占用
 * 浏览器同源 6 条并发连接——长会话里每个历史回合各占一条 SSE 会互相排队，
 * 连正在流式的 live Run 都拿不到连接。
 */
export type EventStreamMode = 'live' | 'snapshot';

/**
 * 最终答案气泡的流式文本：只拼接**最后一个 messageId** 的 assistant 增量。
 *
 * 为什么：一次 Run 有多轮 LLM 调用，每轮有独立的 messageId（见 llm.ts chat()：
 * 每次调用生成新 UUID）。工具轮的短过渡句（“现在看 X：”）已经由 llm_call 事件
 * 渲染进执行面板，不该混进最终答案气泡。之前无差别累加全部 messageId，
 * 导致运行中的回复气泡把 69 轮过程文本拼成一大段（真实事故 2026-09-28）。
 *
 * 语义：遇到新的 messageId 就重新起头（旧轮文本已被执行面板接管）；
 * reasoning_delta / shell_output_delta 与答案无关，不参与。
 * 乱序重放时以最后一个 messageId 为准，天然幂等。
 */
export function collectFinalAnswerText(events: HostEvent[]): string {
  let lastMessageId: string | null = null;
  let text = '';
  for (const event of events) {
    if (event.type !== 'assistant_delta') continue;
    if (event.messageId !== lastMessageId) {
      lastMessageId = event.messageId;
      text = event.delta;
    } else {
      text += event.delta;
    }
  }
  return text;
}

/**
 * 把一个批次合入当前的「最终答案流式文本」（live 增量路径）。
 *
 * 与 collectFinalAnswerText 同语义，但不回扫全部历史（live 下每帧都来一批，
 * 回扫是 O(累计全文)）；用 lastMessageIdRef 记住当前所属轮，新轮出现即重新起头。
 * SSE 单连接严格顺序投递，因此“批内 + 引用状态”等价于全量回扫。
 */
export function appendFinalAnswerBatch(
  prevText: string,
  lastMessageId: string | null,
  batch: HostEvent[],
): { text: string; lastMessageId: string | null } {
  let text = prevText;
  let current = lastMessageId;
  for (const event of batch) {
    if (event.type !== 'assistant_delta') continue;
    if (event.messageId !== current) {
      current = event.messageId;
      text = event.delta;
    } else {
      text += event.delta;
    }
  }
  return { text, lastMessageId: current };
}

export function useEventStream(
  runId: string | null,
  mode: EventStreamMode = 'live',
  onTerminal?: (event: HostEvent) => void,
) {
  const [events, setEvents] = useState<HostEvent[]>([]);
  // 增量累计的 assistant_delta 全文：只在有新增 delta 时更新引用（无 delta 的事件
  // 如 context_usage 不会改变其引用），供下游 useMemo/React.memo 跳过无关重建。
  const [streamedText, setStreamedText] = useState('');
  // streamedText 当前所属的 LLM 轮（messageId）。新轮出现即重新起头，见 appendFinalAnswerBatch。
  const lastAnswerMessageIdRef = useRef<string | null>(null);
  // SSE 单连接按 append 顺序广播、重连回放也严格递增，seq 单调 → 只需记住最大已见 seq
  // 即可去重（等价于 Set 且 O(1) 内存；若未来服务端乱序广播，此假设不成立需回退 Set）。
  const lastSeqRef = useRef(0);
  const closeRef = useRef<(() => void) | null>(null);
  const endedRef = useRef(false);
  // 当前 events 归属于哪个 Run。用于 live → snapshot 翻转时跳过重复取回：
  // Run 终态后 status 变 completed，但此时 SSE 已把含终态在内的全部事件推完。
  const loadedRunIdRef = useRef<string | null>(null);
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  useEffect(() => {
    // 清理旧连接
    if (closeRef.current) {
      closeRef.current();
      closeRef.current = null;
    }
    endedRef.current = false;

    // runId 为 null 时断开
    if (!runId) {
      setEvents([]);
      setStreamedText('');
      lastSeqRef.current = 0;
      lastAnswerMessageIdRef.current = null;
      loadedRunIdRef.current = null;
      return;
    }

    if (mode === 'snapshot' && loadedRunIdRef.current === runId) {
      // 事件已经完整在手（由 SSE 推完或上一次快照取回），保持现状即可。
      return;
    }

    // 重置状态
    setEvents([]);
    setStreamedText('');
    lastSeqRef.current = 0;
    lastAnswerMessageIdRef.current = null;
    loadedRunIdRef.current = null;

    // ---- 已终态 Run：一次性取回 ----
    if (mode === 'snapshot') {
      let cancelled = false;
      void fetchRunEvents(runId)
        .then(({ events: incoming }) => {
          if (cancelled) return;
          setEvents(mergeStreamingEvents([], incoming));
          // 快照路径一次性拿全量：直接全量回扫，不需要引用状态。
          const deltaText = collectFinalAnswerText(incoming);
          if (deltaText) setStreamedText(deltaText);
          loadedRunIdRef.current = runId;
        })
        .catch(() => {
          // 取回失败不置错：Timeline 仍能用 run.result / run_completed 渲染最终答案，
          // 只缺工具步骤等由事件派生的细节。
        });
      return () => {
        cancelled = true;
      };
    }

    // ---- live Run：常驻 SSE ----
    let isActive = true;
    let pendingEvents: HostEvent[] = [];
    // 浏览器 DOM 中 setTimeout 与 requestAnimationFrame 的句柄同为 number；
    // rAF 回调执行时该 id 仍非 null，所以 flushPending 首行先置 null 再消费。
    let flushTimer: number | null = null;

    const flushPending = (): void => {
      flushTimer = null;
      if (pendingEvents.length === 0) return;
      const batch = pendingEvents;
      pendingEvents = [];
      setEvents((prev) => mergeStreamingEvents(prev, batch));
      // 最终答案流式文本：只跟最后一个 messageId（新轮 → 重新起头，旧轮过程句
      // 已由执行面板渲染）。仅在有 assistant 增量时 setState，保持引用稳定。
      if (batch.some((event) => event.type === 'assistant_delta')) {
        setStreamedText((prev) => {
          const next = appendFinalAnswerBatch(prev, lastAnswerMessageIdRef.current, batch);
          lastAnswerMessageIdRef.current = next.lastMessageId;
          return next.text;
        });
      }
    };

    const cancelFlush = (): void => {
      if (flushTimer == null) return;
      // 同时取消两种句柄都是 no-op 安全的（id 空间不同，互不误伤）。
      window.cancelAnimationFrame(flushTimer);
      window.clearTimeout(flushTimer);
      flushTimer = null;
    };

    const scheduleFlush = (): void => {
      if (flushTimer != null) return;
      // 用 rAF 把「发布请求」对齐到帧边界：主线程忙时浏览器自动降频，
      // 天然形成背压（delta 在 pending 队列中累积，绝不丢弃内容，只合并后一次性 setState）。
      // 后台标签页 rAF 会被暂停/降频，回退低频 setTimeout，避免流式完全停滞。
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      flushTimer = hidden
        ? window.setTimeout(flushPending, 250)
        : window.requestAnimationFrame(flushPending);
    };

    const close = connectSSE(runId, true, (ev, seq) => {
      if (!isActive || endedRef.current) return;
      if (seq > 0 && seq <= lastSeqRef.current) return;
      if (seq > 0) lastSeqRef.current = seq;
      pendingEvents.push(ev);
      if (isTerminal(ev)) {
        // Do not let the terminal close discard deltas received in the same
        // network turn. Flush them before closing the EventSource.
        flushPending();
        // Run 已结束：立刻关闭 EventSource，断开浏览器自动重连链路（无限刷请求的根因之一）
        endedRef.current = true;
        loadedRunIdRef.current = runId;
        if (closeRef.current) {
          try {
            closeRef.current();
          } catch {
            /* ignore */
          }
        }
        closeRef.current = null;
        onTerminalRef.current?.(ev);
        return;
      }
      scheduleFlush();
    });

    closeRef.current = close;

    return () => {
      isActive = false;
      cancelFlush();
      pendingEvents = [];
      try {
        close();
      } catch {
        /* ignore */
      }
      closeRef.current = null;
    };
  }, [runId, mode]);

  return { events, streamedText };
}
