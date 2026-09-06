// 模块: Host 事件类型 — 浏览器通过 SSE 接收的 Run 事件
// 组成 = Runtime Trace 事件（透传，保持 type/step/timestamp 原样） + Host 生命周期事件。
// 生命周期事件由 RunManager 在 Run 状态转换时产生（Host Run Status，与 Runtime Task Outcome 独立）。

import type { TraceEvent } from '../runtime/trace.js';
import type {
  ToolchainPreparationPhase,
  ToolchainPreparationStatus,
} from '../sandbox/toolchain-preparation.js';

// 用户随消息发送的图片附件（落盘后的引用：工作区相对路径，可走 files 端点预览）。
export interface HostAttachment {
  name: string;
  mimeType: string;
  path: string;
}

// Host 生命周期事件
export type LifecycleEvent =
  | {
      type: 'run_started';
      runId: string;
      timestamp: string;
      // 本轮用户消息附带的图片（无附件时缺省）；前端据此在用户气泡渲染图片。
      attachments?: HostAttachment[];
    }
  | { type: 'run_stopping'; runId: string; timestamp: string }
  | { type: 'run_completed'; runId: string; timestamp: string; result?: string }
  | { type: 'run_failed'; runId: string; timestamp: string; error?: string }
  | { type: 'run_stopped'; runId: string; timestamp: string }
  | { type: 'run_interrupted'; runId: string; timestamp: string; error: string };

// v2.0.1 JIT Approval：网络访问批准请求（推给前端让用户裁决）
export type ApprovalRequestedEvent = {
  type: 'approval_requested';
  runId: string;
  requestId: string; // 批准请求唯一 id（回传时用）
  toolName: string; // 请求网络的工具（如 shell）
  args: Record<string, unknown>; // 工具参数（最小必要信息，无凭证/path 内部细节）
  timestamp: string;
};

export type ApprovalResolvedEvent = {
  type: 'approval_resolved';
  runId: string;
  requestId: string;
  approved: boolean; // true = 用户批准；false = 拒绝
  timestamp: string;
};

// macOS toolchain preparation: user approval is separate from the Shell OS
// sandbox and never contains installer paths or arbitrary commands.
export type ToolchainPreparationRequestedEvent = {
  type: 'toolchain_preparation_requested';
  runId: string;
  requestId: string;
  toolName: string;
  packageName: string;
  source: 'homebrew';
  timestamp: string;
};

export type ToolchainPreparationResolvedEvent = {
  type: 'toolchain_preparation_resolved';
  runId: string;
  requestId: string;
  approved: boolean;
  prepared: boolean;
  status: ToolchainPreparationStatus;
  message?: string;
  timestamp: string;
};

export type ToolchainPreparationStartedEvent = {
  type: 'toolchain_preparation_started';
  runId: string;
  requestId: string;
  toolName: string;
  packageName: string;
  source: 'homebrew';
  phase: 'checking';
  timestamp: string;
};

export type ToolchainPreparationProgressEvent = {
  type: 'toolchain_preparation_progress';
  runId: string;
  requestId: string;
  phase: Exclude<ToolchainPreparationPhase, 'checking'>;
  timestamp: string;
};

export type StreamingEvent = {
  type: 'assistant_delta' | 'reasoning_delta';
  runId: string;
  messageId: string;
  timestamp: string;
  delta: string;
};

// 浏览器收到的统一事件：Runtime Trace 事件 或 Host 生命周期事件 或批准事件
export type HostEvent =
  | TraceEvent
  | LifecycleEvent
  | StreamingEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ToolchainPreparationRequestedEvent
  | ToolchainPreparationResolvedEvent
  | ToolchainPreparationStartedEvent
  | ToolchainPreparationProgressEvent;

// 是否为 Host 生命周期事件
export function isLifecycle(ev: HostEvent): ev is LifecycleEvent {
  return (
    ev.type === 'run_started' ||
    ev.type === 'run_stopping' ||
    ev.type === 'run_completed' ||
    ev.type === 'run_failed' ||
    ev.type === 'run_stopped' ||
    ev.type === 'run_interrupted'
  );
}

// 编码为一条 SSE 消息（event 字段 = 事件类型，data = JSON；浏览器端无需解析 Runtime stdout）
export function sseEncode(id: number, event: HostEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify({ runId: (event as { runId?: string }).runId, ...event })}\n\n`;
}
