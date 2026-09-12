// 模块: EventStreamService —— Run 事件流订阅管理（SSE 回放 + live 推送）。
//
// 为什么单独存在：RunManager 里「Run 状态机」与「事件流订阅」是两类职责。
// 订阅只依赖 store（历史事件回放）与自己的 subscribers 表（live 推送），
// 独立成服务后事件流语义有唯一 owner，RunManager 只保留一行委托。
//
// 契约：
// - subscribe 先回放 store 中的历史事件（seq > afterSeq），再登记 live sink；
// - live=false 时回放完即 end()（一次性快照语义）；
// - unsubscribe 从 live 表移除 sink（不 end，由调用方负责关闭连接）。

import type { RunStore } from './persistence/store.js';
import { type HostEvent, sseEncode } from './run-events.js';
import type { SseSink } from './run-types.js';

export interface EventStreamServiceDeps {
  store: RunStore;
}

export class EventStreamService {
  private readonly store: RunStore;
  private readonly subscribers = new Map<string, Set<SseSink>>();

  constructor(deps: EventStreamServiceDeps) {
    this.store = deps.store;
  }

  subscribe(runId: string, sink: SseSink, afterSeq = 0, live = true): boolean {
    if (!this.store.getRun(runId)) return false;
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    for (const item of this.store.listEvents(runId)) {
      if (item.seq <= afterSeq) continue;
      if (!sink.closed()) sink.write(sseEncode(item.seq, item.event));
    }
    if (!live) {
      sink.end();
      return true;
    }
    set.add(sink);
    return true;
  }

  unsubscribe(runId: string, sink: SseSink): void {
    this.subscribers.get(runId)?.delete(sink);
  }

  /** 向某 Run 的所有 live sink 推送一条已编码事件（seq 由调用方决定）。 */
  publish(runId: string, seq: number, event: HostEvent): void {
    const set = this.subscribers.get(runId);
    if (!set) return;
    const payload = sseEncode(seq, event);
    for (const sink of set) {
      if (sink.closed()) {
        set.delete(sink);
        continue;
      }
      sink.write(payload);
    }
  }

  /** Run 终态回收：清理其 live 订阅（close/finalize 时调用）。 */
  disposeRun(runId: string): void {
    this.subscribers.delete(runId);
  }

  /** 关闭所有 live sink 并清空订阅表（Host close 时调用）。 */
  closeAll(): void {
    for (const sinks of this.subscribers.values()) {
      for (const sink of sinks) {
        try {
          sink.end();
        } catch {
          /* ignore shutdown write failures */
        }
      }
    }
    this.subscribers.clear();
  }

  /** 关闭某 Run 的所有 live sink 并移除订阅（purge/delete 时调用）。 */
  closeRun(runId: string): void {
    const sinks = this.subscribers.get(runId);
    if (!sinks) return;
    for (const sink of sinks) {
      try {
        sink.end();
      } catch {
        /* ignore shutdown write failures */
      }
    }
    this.subscribers.delete(runId);
  }
}
