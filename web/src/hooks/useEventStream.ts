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
      setIsConnected(false);
      lastSeqRef.current = 0;
      return;
    }

    // 重置状态
    setEvents([]);
    setIsConnected(false);
    lastSeqRef.current = 0;

    let isActive = true;
    let pendingEvents: HostEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushPending = (): void => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (pendingEvents.length === 0) return;
      const batch = pendingEvents;
      pendingEvents = [];
      setEvents((prev) => mergeStreamingEvents(prev, batch));
    };

    const scheduleFlush = (): void => {
      if (flushTimer) return;
      // Keep the stream visually live while capping React/Markdown work to
      // roughly one update per animation frame.
      flushTimer = setTimeout(flushPending, 16);
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
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      pendingEvents = [];
      try {
        close();
      } catch {
        /* ignore */
      }
      closeRef.current = null;
    };
  }, [runId, live]);

  return { events, isConnected };
}
