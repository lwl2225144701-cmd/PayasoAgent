// 模块: Run/Session 公开类型 —— RunManager 对外 API 的类型契约。
//
// 为什么单独存在：RunManager、视图转换（run-views.ts）、路由 handler 与 Event
// 服务共享这些类型。独立成文件避免 run-manager ↔ run-views 循环依赖，也让
// 「对外投影形状」有唯一 owner。

import type { PermissionMode } from '../permission-mode.js';
import type { StoredRunStatus } from './persistence/store.js';

export type HostRunStatus = StoredRunStatus;

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
}

export interface HostSession {
  sessionId: string;
  title: string;
  workspace?: { name: string };
  createdAt: string;
  updatedAt: string;
}

// 创建 Run 时随消息上传的图片附件（routes 已做 MIME/大小/数量校验；
// P1 起 routes 还会先经 attachment-normalize 归一化并附带尺寸元数据）。
export interface CreateRunAttachmentInput {
  name: string;
  mimeType: string;
  dataBase64: string;
  /** 归一化后尺寸（attachment-normalize 产出；缺省 = 未归一化） */
  width?: number;
  height?: number;
  /** 归一化前原图尺寸，如 "5000x3000" */
  originalDimensions?: string;
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
