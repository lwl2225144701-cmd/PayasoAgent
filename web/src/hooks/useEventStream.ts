import { useState, useEffect, useRef, useCallback } from 'react';
import type { HostEvent } from '../types';
import { connectSSE } from '../api';

export function useEventStream(runId: string | null) {
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
      (ev) => {
        if (!isActive) return;
        // 使用 step + type 做去重（SSE 重连回放时避免重复）
        const evStep = 'step' in ev ? (ev as { step: number }).step : -1;
        const dedupeKey = evStep * 1000 + hashEventType(ev.type);
        if (processedIdsRef.current.has(dedupeKey)) return;
        processedIdsRef.current.add(dedupeKey);
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
  }, [runId]);

  const appendEvent = useCallback((ev: HostEvent) => {
    setEvents((prev) => [...prev, ev]);
  }, []);

  return { events, isConnected, appendEvent };
}

function hashEventType(type: string): number {
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) & 0xffff;
  return h;
}
