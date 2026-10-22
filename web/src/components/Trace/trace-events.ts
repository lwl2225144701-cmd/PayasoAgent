// 模块: Trace 事件获取 —— 终态 Run 事件快照的会话内缓存
// 职责边界：轨迹页与对话 Timeline 各自拉一遍同一批历史 Run 的快照（两者数据源
//   独立、组件互不感知），这里给轨迹侧加一层**有界**缓存，避免每次打开轨迹页
//   都把全部历史 Run 的快照重新拉一遍。
//
// 正确性约束：
//   - 只有「快照最后一个事件就是终态事件」时才入缓存 —— 快照若在落盘中途被读出
//     （缺终态事件），说明数据不完整，绝不缓存半截数据；
//   - 缓存键绑定 run.updatedAt：Run 被 resume 后 updatedAt 变化，旧缓存自动失效，
//     不会把 resume 前的事件当好数据用；
//   - 缓存容量有界（FIFO 淘汰），长会话连开多个会话也不会无限膨胀。

import { fetchRunEvents } from '../../api';
import type { HostEvent } from '../../types';

interface SnapshotCacheEntry {
  updatedAt: string;
  events: HostEvent[];
}

const TERMINAL_EVENT_TYPES = new Set([
  'run_completed',
  'run_failed',
  'run_stopped',
  'run_interrupted',
]);

const CACHE_MAX_ENTRIES = 24;
const snapshotCache = new Map<string, SnapshotCacheEntry>();

/** 轨迹页专用快照取回：同一 Run（updatedAt 未变）命中缓存，否则走既有接口。 */
export function fetchTraceRunEvents(runId: string, updatedAt: string): Promise<HostEvent[]> {
  const hit = snapshotCache.get(runId);
  if (hit && hit.updatedAt === updatedAt) return Promise.resolve(hit.events);
  return fetchRunEvents(runId).then(({ events }) => {
    const last = events[events.length - 1];
    if (last && TERMINAL_EVENT_TYPES.has(last.type)) {
      if (snapshotCache.size >= CACHE_MAX_ENTRIES) {
        const oldest = snapshotCache.keys().next().value;
        if (oldest !== undefined) snapshotCache.delete(oldest);
      }
      snapshotCache.set(runId, { updatedAt, events });
    }
    return events;
  });
}
