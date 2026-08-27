// 模块: Host 事件类型 — 浏览器通过 SSE 接收的 Run 事件
// 组成 = Runtime Trace 事件（透传，保持 type/step/timestamp 原样） + Host 生命周期事件。
// 生命周期事件由 RunManager 在 Run 状态转换时产生（Host Run Status，与 Runtime Task Outcome 独立）。

import type { TraceEvent } from "../runtime/trace.js";

// Host 生命周期事件
export type LifecycleEvent =
  | { type: "run_started"; runId: string; timestamp: string }
  | { type: "run_completed"; runId: string; timestamp: string; result?: string }
  | { type: "run_failed"; runId: string; timestamp: string; error?: string }
  | { type: "run_stopped"; runId: string; timestamp: string }
  | { type: "run_interrupted"; runId: string; timestamp: string; error: string };

// 浏览器收到的统一事件：Runtime Trace 事件 或 Host 生命周期事件
export type HostEvent = TraceEvent | LifecycleEvent;

// 是否为 Host 生命周期事件
export function isLifecycle(ev: HostEvent): ev is LifecycleEvent {
  return (
    ev.type === "run_started" ||
    ev.type === "run_completed" ||
    ev.type === "run_failed" ||
    ev.type === "run_stopped" ||
    ev.type === "run_interrupted"
  );
}

// 编码为一条 SSE 消息（event 字段 = 事件类型，data = JSON；浏览器端无需解析 Runtime stdout）
export function sseEncode(id: number, event: HostEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify({ runId: (event as { runId?: string }).runId, ...event })}\n\n`;
}
