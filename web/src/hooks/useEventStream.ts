import { useEffect, useRef, useState } from 'react';
import { connectSSE } from '../api';
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

export function useEventStream(
  runId: string | null,
  live = true,
  onTerminal?: (event: HostEvent) => void,
) {
  const [events, setEvents] = useState<HostEvent[]>([]);
  // 增量累计的 assistant_delta 全文：只在有新增 delta 时更新引用（无 delta 的事件
  // 如 context_usage 不会改变其引用），供下游 useMemo/React.memo 跳过无关重建。
  const [streamedText, setStreamedText] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  // SSE 单连接按 append 顺序广播、重连回放也严格递增，seq 单调 → 只需记住最大已见 seq
  // 即可去重（等价于 Set 且 O(1) 内存；若未来服务端乱序广播，此假设不成立需回退 Set）。
  const lastSeqRef = useRef(0);
  const closeRef = useRef<(() => void) | null>(null);
  const endedRef = useRef(false);
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
      setIsConnected(false);
      lastSeqRef.current = 0;
      return;
    }

    // 重置状态
    setEvents([]);
    setStreamedText('');
    setIsConnected(false);
    lastSeqRef.current = 0;

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
      // 增量累计 assistant_delta 全文：仅在有新增 delta 时 setState（引用变化），
      // 纯事件批次（context_usage/tool 等）不会触碰 streamedText，保持引用稳定。
      let deltaAcc = '';
      for (const ev of batch) {
        if (ev.type === 'assistant_delta') deltaAcc += ev.delta;
      }
      if (deltaAcc) setStreamedText((prev) => prev + deltaAcc);
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

    const close = connectSSE(
      runId,
      live,
      (ev, seq) => {
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
          if (closeRef.current) {
            try {
              closeRef.current();
            } catch {
              /* ignore */
            }
          }
          closeRef.current = null;
          setIsConnected(false);
          onTerminalRef.current?.(ev);
          return;
        }
        scheduleFlush();
      },
      () => {
        if (isActive && !endedRef.current) setIsConnected(true);
      },
      () => {
        if (isActive) setIsConnected(false);
      },
    );

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
  }, [runId, live]);

  return { events, streamedText, isConnected };
}
