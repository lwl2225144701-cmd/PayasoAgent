// 模块: RunManager — Host 产品层状态管理
// 职责：活跃执行状态留在内存；Run 历史、状态和事件由 RunStore 持久化。
// 边界：只通过公开边界 runAgent 调用 Runtime；不持久化 Runtime checkpoint 内容。

import { runAgent } from "../runtime/agent.js";
import type { ChatMessage, ChatStreamDelta } from "../llm/llm.js";
import { loadCheckpoint, checkpointPath } from "../runtime/checkpoint.js";
import { getRunWorkspaceRoot } from "../sandbox/sandbox-manager.js";
import { sseEncode, type HostEvent, type StreamingEvent } from "./run-events.js";
import { createDefaultRunStore } from "./persistence/sqlite-store.js";
import type { RunStore, StoredRun, StoredRunStatus, StoredSession, CreateModelProviderInput, UpdateModelProviderInput } from "./persistence/store.js";
import { clearWorkspace, getWorkspace, renameWorkspaceLabel } from "./workspace.js";
import fs from "node:fs";

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
  target: "checkpoint" | "sandbox";
}

interface InternalRun extends HostRun {
  events: HostEvent[];
  cancelled: boolean;
  workspaceRoot: string;
}

export interface SseSink {
  write: (chunk: string) => void;
  end: () => void;
  closed: () => boolean;
}

const INTERRUPTED_ERROR = "Host restarted before the Run completed";

export class RunManager {
  private runs = new Map<string, InternalRun>();
  private subscribers = new Map<string, Set<SseSink>>();

  constructor(private readonly store: RunStore = createDefaultRunStore()) {
    // A process restart cannot leave persisted rows pretending to execute.
    // Do not auto-resume: checkpoint recovery remains an explicit user action.
    const now = new Date().toISOString();
    for (const run of this.store.listRuns()) {
      if (run.status !== "running") continue;
      const interrupted: StoredRun = {
        ...run,
        status: "interrupted",
        updatedAt: now,
        error: INTERRUPTED_ERROR,
      };
      this.store.updateRun(interrupted);
      this.store.appendEvent(run.runId, {
        type: "run_interrupted",
        runId: run.runId,
        timestamp: now,
        error: INTERRUPTED_ERROR,
      });
    }
  }

  private isSessionDeleted(sessionId: string): boolean {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    return !session || session.deletedAt !== undefined;
  }

  create(task: string): string {
    return this.createInSession(task).runId;
  }

  createInSession(
    task: string,
    requestedSessionId?: string,
    opts?: { workspaceName?: string; startAgent?: boolean },
  ): { runId: string; sessionId: string } {
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    let session: StoredSession;
    if (requestedSessionId) {
      const persisted = this.store.getSession(requestedSessionId);
      if (!persisted) throw new Error("Session not found");
      if (this.store.listRunsBySession(requestedSessionId).some((item) => item.status === "running")) {
        throw new Error("Session already has a running Run");
      }
      session = { ...persisted, updatedAt: now };
      this.store.updateSession(session);
    } else {
      let workspace = getWorkspace();
      if (opts?.workspaceName) {
        // Bind a brand-new Session to an existing (historical) Workspace: inherit
        // its canonical root without ever exposing the absolute path to the client.
        const reference = this.store.findSessionByWorkspaceName(opts.workspaceName);
        if (reference) workspace = { rootPath: reference.workspaceRoot, name: opts.workspaceName };
      }
      session = {
        sessionId: crypto.randomUUID(),
        title: this.sessionTitle(task),
        workspaceRoot: workspace?.rootPath ?? getRunWorkspaceRoot(runId),
        workspaceName: workspace?.name ?? "",
        createdAt: now,
        updatedAt: now,
      };
      this.store.createSession(session);
    }
    const previousRuns = this.store.listRunsBySession(session.sessionId);
    const conversationHistory = this.conversationHistory(previousRuns);
    const run: InternalRun = {
      runId,
      sessionId: session.sessionId,
      turnIndex: previousRuns.length + 1,
      task,
      status: "running",
      createdAt: now,
      updatedAt: now,
      events: [],
      cancelled: false,
      workspace: session.workspaceName ? { name: session.workspaceName } : undefined,
      workspaceRoot: session.workspaceRoot,
    };

    // Persist before execution starts, so every Runtime event has a parent Run.
    this.store.createRun(this.toStoredRun(run));
    this.runs.set(runId, run);
    this.record(run, { type: "run_started", runId, timestamp: now });
    if (opts?.startAgent !== false) {
      this.startAgent(run, task, undefined, conversationHistory);
    }
    return { runId, sessionId: session.sessionId };
  }

  resume(runId: string): boolean {
    if (this.runs.get(runId)?.status === "running") return false;
    const persisted = this.store.getRun(runId);
    const checkpoint = loadCheckpoint(runId);
    if (!persisted || !checkpoint) return false;

    // Historical binding is immutable. Never fall back to currentWorkspace.
    if (checkpoint.workspaceRoot && checkpoint.workspaceRoot !== persisted.workspaceRoot) return false;

    const now = new Date().toISOString();
    const workspaceRoot = persisted.workspaceRoot || checkpoint.workspaceRoot || getRunWorkspaceRoot(runId);
    const workspaceName = persisted.workspaceName;
    const run: InternalRun = {
      runId,
      sessionId: persisted.sessionId,
      turnIndex: persisted.turnIndex,
      task: persisted.task,
      status: "running",
      createdAt: persisted.createdAt,
      updatedAt: now,
      events: this.store.listEvents(runId).map((item) => item.event),
      cancelled: false,
      workspace: workspaceName ? { name: workspaceName } : undefined,
      workspaceRoot,
      result: undefined,
      error: undefined,
    };
    this.store.updateRun(this.toStoredRun(run));
    this.runs.set(runId, run);
    this.record(run, { type: "run_started", runId, timestamp: now });
    this.startAgent(run, checkpoint.task, checkpoint);
    return true;
  }

  renameWorkspace(fromName: string, toName: string): { updated: number } {
    if (toName === fromName) return { updated: 0 };
    const updated = this.store.renameSessionsWorkspace(fromName, toName);
    if (updated === 0) throw new Error(`Workspace not found: ${fromName}`);
    // Keep in-memory active Runs pointing at the same Workspace label.
    for (const run of this.runs.values()) {
      if (run.workspace?.name === fromName) run.workspace = { name: toName };
    }
    renameWorkspaceLabel(toName);
    return { updated };
  }

  deleteWorkspace(sessionId: string): { deleted: number; updatedAt: string } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error("Workspace not found");
    const workspaceRoot = session.workspaceRoot;

    for (const run of this.runs.values()) {
      if (run.status === "running" && run.workspaceRoot === workspaceRoot) {
        throw new Error("Workspace has a running Run");
      }
    }
    const runningInStore = this.store.listRuns({ includeDeleted: true }).some(
      (r) => r.workspaceRoot === workspaceRoot && r.status === "running"
    );
    if (runningInStore) throw new Error("Workspace has a running Run");

    const now = new Date().toISOString();
    const deleted = this.store.softDeleteWorkspace(workspaceRoot, now);

    if (getWorkspace()?.rootPath === workspaceRoot) {
      clearWorkspace();
    }
    return { deleted, updatedAt: now };
  }

  restoreWorkspace(sessionId: string): { restored: number; updatedAt: string } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error("Workspace not found");
    const workspaceRoot = session.workspaceRoot;

    if (!fs.existsSync(workspaceRoot)) {
      throw new Error("Workspace path no longer exists");
    }
    const stat = fs.statSync(workspaceRoot);
    if (!stat.isDirectory()) {
      throw new Error("Workspace path is no longer a directory");
    }
    const real = fs.realpathSync.native(workspaceRoot);
    if (real !== workspaceRoot) {
      throw new Error("Workspace path has changed");
    }

    const now = new Date().toISOString();
    const restored = this.store.restoreWorkspace(workspaceRoot, now);
    return { restored, updatedAt: now };
  }

  purgeWorkspace(sessionId: string): { purged: number; cleanupErrors: CleanupError[] } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error("Workspace not found");
    const workspaceRoot = session.workspaceRoot;

    if (!session.deletedAt) {
      throw new Error("Workspace has not been deleted");
    }

    const hasRunning = this.store.listRuns({ includeDeleted: true }).some(
      (r) => r.workspaceRoot === workspaceRoot && r.status === "running"
    );
    if (hasRunning) throw new Error("Workspace has a running Run");

    const runs = this.store.listRuns({ includeDeleted: true }).filter(
      (r) => r.workspaceRoot === workspaceRoot
    );

    // 先清理数据库，再清理文件；数据库失败则 checkpoint 仍在，避免半完成状态
    const purged = this.store.purgeWorkspace(workspaceRoot);
    const cleanupErrors: CleanupError[] = [];
    for (const run of runs) {
      this.runs.delete(run.runId);
      const sinks = this.subscribers.get(run.runId);
      if (sinks) {
        for (const sink of sinks) {
          try { sink.end(); } catch { /* ignore shutdown write failures */ }
        }
        this.subscribers.delete(run.runId);
      }
      cleanupErrors.push(...this.cleanupRun(run.runId));
    }
    return { purged, cleanupErrors };
  }

  renameSession(sessionId: string, title: string): { updatedAt: string; title: string } {
    this.store.renameSession(sessionId, title);
    const now = new Date().toISOString();
    return { updatedAt: now, title };
  }

  archiveSession(sessionId: string): { archived: number; updatedAt: string } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error("Session not found");
    if (session.deletedAt) throw new Error("Session already archived");

    const hasRunning = [...this.runs.values()].some(
      (r) => r.sessionId === sessionId && r.status === "running"
    );
    if (hasRunning) throw new Error("Session has a running Run");

    const now = new Date().toISOString();
    const archived = this.store.archiveSession(sessionId, now);
    return { archived, updatedAt: now };
  }

  restoreSession(sessionId: string): { restored: number; updatedAt: string } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error("Session not found");
    if (!session.deletedAt) throw new Error("Session is not archived");

    const now = new Date().toISOString();
    const restored = this.store.restoreSession(sessionId, now);
    return { restored, updatedAt: now };
  }

  deleteSession(sessionId: string): { deleted: number; cleanupErrors: CleanupError[] } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error("Session not found");
    if (!session.deletedAt) throw new Error("Session has not been archived");

    const hasRunning = this.store.listRuns({ includeDeleted: true }).some(
      (r) => r.sessionId === sessionId && r.status === "running"
    );
    if (hasRunning) throw new Error("Session has a running Run");

    const runs = this.store.listRunsBySession(sessionId, { includeDeleted: true });
    const deleted = this.store.deleteSession(sessionId);
    const cleanupErrors: CleanupError[] = [];
    for (const run of runs) {
      this.runs.delete(run.runId);
      const sinks = this.subscribers.get(run.runId);
      if (sinks) {
        for (const sink of sinks) {
          try { sink.end(); } catch { /* ignore shutdown write failures */ }
        }
        this.subscribers.delete(run.runId);
      }
      cleanupErrors.push(...this.cleanupRun(run.runId));
    }
    return { deleted, cleanupErrors };
  }

  private cleanupRun(runId: string): CleanupError[] {
    const errors: CleanupError[] = [];
    try {
      fs.rmSync(checkpointPath(runId), { force: true });
    } catch (err) {
      // 原始错误（可能含绝对路径）只写 Host 日志，不返回前端
      console.error(`[RunStore] purge checkpoint cleanup failed for ${runId}: ${(err as Error).message}`);
      errors.push({ runId, target: "checkpoint" });
    }
    try {
      const sandboxRoot = getRunWorkspaceRoot(runId);
      if (sandboxRoot && fs.existsSync(sandboxRoot)) {
        fs.rmSync(sandboxRoot, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`[RunStore] purge sandbox cleanup failed for ${runId}: ${(err as Error).message}`);
      errors.push({ runId, target: "sandbox" });
    }
    return errors;
  }

  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) {
      const stored = this.store.getRun(runId);
      return stored !== null && !this.isSessionDeleted(stored.sessionId);
    }
    if (this.isSessionDeleted(run.sessionId)) return false;
    if (run.status !== "running") {
      run.cancelled = true;
      return true;
    }
    run.cancelled = true;
    this.finish(run, "stopped");
    return true;
  }

  list(): HostRun[] {
    return this.store.listRuns().map((run) => this.publicStoredView(run));
  }

  listSessions(): HostSession[] {
    return this.store.listSessions().map((session) => this.publicSessionView(session));
  }

  getSession(sessionId: string): HostSession | null {
    const session = this.store.getSession(sessionId);
    return session ? this.publicSessionView(session) : null;
  }

  findSessionByWorkspaceName(name: string, opts?: { includeDeleted?: boolean }): StoredSession | null {
    const sessions = this.store.listSessions(opts).filter((s) => s.workspaceName === name);
    if (sessions.length === 0) return null;
    const roots = new Set(sessions.map((s) => s.workspaceRoot));
    if (roots.size > 1) {
      throw new Error(`Workspace name "${name}" matches multiple roots`);
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions[0];
  }

  listSessionRuns(sessionId: string): HostRun[] | null {
    if (!this.store.getSession(sessionId)) return null;
    return this.store.listRunsBySession(sessionId).map((run) => this.publicStoredView(run));
  }

  get(runId: string): HostRun | null {
    const active = this.runs.get(runId);
    if (active && !this.isSessionDeleted(active.sessionId)) return this.publicView(active);
    const stored = this.store.getRun(runId);
    return stored && !this.isSessionDeleted(stored.sessionId) ? this.publicStoredView(stored) : null;
  }

  getRaw(runId: string): InternalRun | undefined {
    return this.runs.get(runId);
  }

  getWorkspaceRoot(runId: string): string | null {
    const active = this.runs.get(runId);
    if (active) {
        return this.isSessionDeleted(active.sessionId) ? null : active.workspaceRoot;
    }
    const stored = this.store.getRun(runId);
    return stored && !this.isSessionDeleted(stored.sessionId) ? stored.workspaceRoot : null;
  }

  subscribe(runId: string, sink: SseSink, afterSeq = 0, live = true): boolean {
    if (!this.store.getRun(runId)) return false;
    if (!this.subscribers.has(runId)) this.subscribers.set(runId, new Set());
    const set = this.subscribers.get(runId)!;
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

  close(): void {
    for (const sinks of this.subscribers.values()) {
      for (const sink of sinks) {
        try { sink.end(); } catch { /* ignore shutdown write failures */ }
      }
    }
    this.subscribers.clear();
    this.store.close();
  }

  private startAgent(
    run: InternalRun,
    task: string,
    resume?: Parameters<typeof runAgent>[1],
    conversationHistory: ChatMessage[] = [],
  ): void {
    let pendingDelta: StreamingEvent | null = null;
    let deltaTimer: ReturnType<typeof setTimeout> | null = null;
    const flushDelta = () => {
      if (deltaTimer) clearTimeout(deltaTimer);
      deltaTimer = null;
      if (!pendingDelta) return;
      this.record(run, pendingDelta);
      pendingDelta = null;
    };
    const queueDelta = (delta: ChatStreamDelta) => {
      if (
        pendingDelta
        && pendingDelta.type === delta.type
        && pendingDelta.messageId === delta.messageId
      ) {
        pendingDelta.delta += delta.delta;
      } else {
        flushDelta();
        pendingDelta = {
          type: delta.type,
          runId: run.runId,
          messageId: delta.messageId,
          timestamp: new Date().toISOString(),
          delta: delta.delta,
        };
      }
      if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 16);
    };
    void runAgent(task, resume, {
      runId: run.runId,
      workspaceRoot: run.workspaceRoot,
      conversationHistory,
      onStreamDelta: queueDelta,
      onTrace: (event) => {
        flushDelta();
        this.record(run, event);
      },
      isCancelled: () => run.cancelled,
    })
      .then((result) => {
        flushDelta();
        if (run.cancelled) {
          this.finish(run, "stopped");
          return;
        }
        run.status = "completed";
        run.result = result;
        run.error = undefined;
        run.updatedAt = new Date().toISOString();
        this.persistRunSafely(run);
        this.record(run, {
          type: "run_completed",
          runId: run.runId,
          timestamp: run.updatedAt,
          result,
        });
      })
      .catch((err: unknown) => {
        flushDelta();
        if (run.cancelled) {
          this.finish(run, "stopped");
          return;
        }
        run.status = "failed";
        run.error = (err as Error).message;
        run.updatedAt = new Date().toISOString();
        this.persistRunSafely(run);
        this.record(run, {
          type: "run_failed",
          runId: run.runId,
          timestamp: run.updatedAt,
          error: run.error,
        });
      });
  }

  private finish(run: InternalRun, status: "stopped"): void {
    if (run.status !== "running") return;
    run.status = status;
    run.updatedAt = new Date().toISOString();
    this.persistRunSafely(run);
    this.record(run, { type: "run_stopped", runId: run.runId, timestamp: run.updatedAt });
  }

  // Persistence precedes SSE. If local storage fails, do not broadcast an
  // event the product cannot replay after restart; Runtime remains isolated
  // from Host observability failures.
  private record(run: InternalRun, event: HostEvent): void {
    let seq: number;
    try {
      seq = this.store.appendEvent(run.runId, event);
    } catch (err) {
      console.error(`[RunStore] appendEvent failed for ${run.runId}: ${(err as Error).message}`);
      return;
    }
    run.events.push(event);
    const sinks = this.subscribers.get(run.runId);
    if (!sinks) return;
    const chunk = sseEncode(seq, event);
    for (const sink of sinks) {
      if (!sink.closed()) {
        try { sink.write(chunk); } catch { /* isolate one broken SSE client */ }
      }
    }
  }

  private persistRunSafely(run: InternalRun): void {
    try {
      this.store.updateRun(this.toStoredRun(run));
    } catch (err) {
      console.error(`[RunStore] updateRun failed for ${run.runId}: ${(err as Error).message}`);
    }
  }

  private toStoredRun(run: InternalRun): StoredRun {
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      turnIndex: run.turnIndex,
      task: run.task,
      status: run.status,
      workspaceRoot: run.workspaceRoot,
      workspaceName: run.workspace?.name ?? "",
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      result: run.result,
      error: run.error,
    };
  }

  private publicView(run: InternalRun): HostRun {
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
    };
  }

  private publicStoredView(run: StoredRun): HostRun {
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
    };
  }

  private publicSessionView(session: StoredSession): HostSession {
    return {
      sessionId: session.sessionId,
      title: session.title,
      workspace: session.workspaceName ? { name: session.workspaceName } : undefined,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private sessionTitle(task: string): string {
    return task.replace(/\s+/g, " ").trim().slice(0, 80) || "未命名任务";
  }

  private conversationHistory(runs: StoredRun[]): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const run of runs) {
      if (run.status === "running" || run.status === "interrupted") continue;
      messages.push({ role: "user", content: run.task });
      if (run.status === "completed" && run.result) {
        messages.push({ role: "assistant", content: run.result });
      } else {
        // Product errors may contain Host-only paths/provider details. Preserve
        // conversational continuity without feeding those internals to the LLM.
        messages.push({ role: "assistant", content: `上一轮未完成（${run.status}）` });
      }
    }
    return messages;
  }

  listModelProviders() {
    return this.store.listModelProviders();
  }

  addModelProvider(input: CreateModelProviderInput) {
    return this.store.addModelProvider(input);
  }

  updateModelProvider(id: string, input: UpdateModelProviderInput) {
    return this.store.updateModelProvider(id, input);
  }

  deleteModelProvider(id: string) {
    return this.store.deleteModelProvider(id);
  }
}
