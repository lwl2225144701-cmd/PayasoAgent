// 模块: Run/Session 公开类型 —— RunManager 对外 API 的类型契约。
//
// 为什么单独存在：RunManager、视图转换（run-views.ts）、路由 handler 与 Event
// 服务共享这些类型。独立成文件避免 run-manager ↔ run-views 循环依赖，也让
// 「对外投影形状」有唯一 owner。

import type { PermissionMode } from '../permission-mode.js';
import type { StoredRunStatus } from './persistence/store.js';

export type { CreateRunAttachmentInput } from './attachments/types.js';

export type HostRunStatus = StoredRunStatus;

// 可取消状态：running（执行中）/ stopping（已请求停止、abort 已发出、执行未退出）
export function isCancellable(status: HostRunStatus): boolean {
  return status === 'running' || status === 'stopping';
}

export interface HostRun {
  runId: string;
  sessionId: string;
  turnIndex: number;
  task: string;
  status: HostRunStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  workspace?: { name: string };
  model?: string;
  providerId?: string;
  baseUrl?: string;
  permissionMode: PermissionMode;
  constraints?: import('../task-constraints.js').TaskConstraints;
}

export interface HostSession {
  sessionId: string;
  title: string;
  workspace?: { name: string };
  createdAt: string;
  updatedAt: string;
}

// purge 文件清理失败的结构化描述；不包含文件系统路径，可安全返回前端
export interface CleanupError {
  runId: string;
  target: 'checkpoint' | 'sandbox';
}

export interface SseSink {
  write: (chunk: string) => void;
  end: () => void;
  closed: () => boolean;
}
