// 模块: Run/Session 视图转换 —— 持久层对象 → 对外 API 投影（纯函数）。
//
// 为什么单独存在：RunManager / SessionService 都需要把 StoredRun/StoredSession
// 投影成不含内部字段的公开视图（隐藏 workspaceRoot、events、cancelled 等）。
// 投影规则有唯一 owner，避免多服务各写一份导致漂移。

import { storedPermissionMode } from '../permission-mode.js';
import type { StoredRun, StoredSession } from './persistence/store.js';
import type { HostRun, HostSession } from './run-types.js';

// 活跃（in-memory）Run 的公开投影：InternalRun 是 HostRun 的超集（含 events、
// workspaceRoot、abortController 等内部字段），投影时逐字段挑选，绝不展开。
export function publicActiveView(run: HostRun): HostRun {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    turnIndex: run.turnIndex,
    task: run.task,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    result: run.result,
    error: run.error,
    workspace: run.workspace,
    model: run.model,
    providerId: run.providerId,
    baseUrl: run.baseUrl,
    permissionMode: run.permissionMode,
  };
}

export function publicStoredView(run: StoredRun): HostRun {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    turnIndex: run.turnIndex,
    task: run.task,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    result: run.result,
    error: run.error,
    workspace: run.workspaceName ? { name: run.workspaceName } : undefined,
    model: run.model,
    providerId: run.providerId,
    baseUrl: run.baseUrl,
    permissionMode: storedPermissionMode(run.permissionMode),
  };
}

export function publicSessionView(session: StoredSession): HostSession {
  return {
    sessionId: session.sessionId,
    title: session.title,
    workspace: session.workspaceName ? { name: session.workspaceName } : undefined,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function sessionTitle(task: string): string {
  return task.replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名任务';
}
