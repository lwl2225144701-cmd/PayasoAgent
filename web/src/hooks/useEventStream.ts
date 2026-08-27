import { useState, useEffect, useRef, useCallback } from 'react';
import type { HostEvent } from '../types';
import { connectSSE } from '../api';

export function useEventStream(runId: string | null, live = true) {
  const [events, setEvents] = useState<HostEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const processedIdsRef = useRef<Set<number>>(new Set());
  const cleanupRef = useRef<(() => void) | null>(null);
  const runIdRef = useRef<string | null>(runId);

  runIdRef.current = runId;

  useEffect(() => {
    // 清理旧连接
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

    // runId 为 null 时断开
    if (!runId) {
      setEvents([]);
      setIsConnected(false);
      processedIdsRef.current = new Set();
      return;
    }

    // 重置状态
    setEvents([]);
    setIsConnected(false);
    processedIdsRef.current = new Set();

    let isActive = true;

    const close = connectSSE(
      runId,
      live,
      (ev, seq) => {
        if (!isActive) return;
        // SQLite/SSE seq is the only stable identity. step+type is not unique:
        // one LLM turn may emit multiple tool calls or streaming deltas.
        if (seq > 0 && processedIdsRef.current.has(seq)) return;
        if (seq > 0) processedIdsRef.current.add(seq);
        setEvents((prev) => [...prev, ev]);
      },
      () => { if (isActive) setIsConnected(true); },
      () => { if (isActive) setIsConnected(false); },
    );

    cleanupRef.current = () => {
      isActive = false;
      close();
    };

    return () => {
      isActive = false;
      close();
      cleanupRef.current = null;
    };
  }, [runId, live]);

  const appendEvent = useCallback((ev: HostEvent) => {
    setEvents((prev) => [...prev, ev]);
  }, []);

  return { events, isConnected, appendEvent };
}
