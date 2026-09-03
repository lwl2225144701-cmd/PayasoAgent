// 模块: RunManager — Host 产品层状态管理
// 职责：活跃执行状态留在内存；Run 历史、状态和事件由 RunStore 持久化。
// 边界：只通过公开边界 runAgent 调用 Runtime；不持久化 Runtime checkpoint 内容。

import { runAgent } from "../runtime/agent.js";
import { DefaultContextHarness } from "../harness/context-harness.js";
import { createAgentExecutionContext, createDefaultRuntimeServices } from "../bootstrap/runtime-bootstrap.js";
import type { ChatMessage, ChatStreamDelta, ModelConfig } from "../llm/llm.js";
import { loadCheckpoint, checkpointPath } from "../persistence/file-checkpoint-store.js";
import { getRunWorkspaceRoot } from "../sandbox/sandbox-manager.js";
import { sseEncode, type HostEvent, type StreamingEvent } from "./run-events.js";
import { createDefaultRunStore } from "./persistence/sqlite-store.js";
import { isTerminalRunStatus, type RunStore, type StoredRun, type StoredRunStatus, type StoredSession, type ModelProviderView, type CreateModelProviderInput, type UpdateModelProviderInput, type TerminalRunStatus } from "./persistence/store.js";
import { clearWorkspace, getWorkspace, renameWorkspaceLabel } from "./workspace.js";
import { isAbortError } from "../util/abort.js";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERMISSION_MODE, storedPermissionMode, type PermissionMode } from "../permission-mode.js";
import type { ApprovalPort, NetworkApprovalRequest } from "../runtime/approval-port.js";

// v2.0.1 JIT Approval：批准请求等待超时（用户 60s 未裁决 → 拒绝，不无限挂起 Run）
const APPROVAL_TIMEOUT_MS = 60_000;

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

// purge 文件清理失败的结构化描述；不包含文件系统路径，可安全返回前端
export interface CleanupError {
  runId: string;
  target: "checkpoint" | "sandbox";
}

interface InternalRun extends HostRun {
  events: HostEvent[];
  cancelled: boolean;
  workspaceRoot: string;
  providerId?: string;
  baseUrl?: string;
  // True cancellation (v1.6)：每个活跃 Run 独立的 AbortController；
  // startAgent 时创建，stop() 触发 abort，Run 真正退出后由 Host 落 stopped。
  abortController?: AbortController;
  // v1.6.1：执行链 promise 句柄（fire-and-forget 任务的引用）。
  // close() 用它等待执行链真正结束（而非仅状态变终态），避免 Store 关闭后 agent 仍在写库。
  agentPromise?: Promise<void>;
}

export interface SseSink {
  write: (chunk: string) => void;
  end: () => void;
  closed: () => boolean;
}

const INTERRUPTED_ERROR = "Host restarted before the Run completed";

// 可取消状态：running（执行中）/ stopping（已请求停止、abort 已发出、执行未退出）
function isCancellable(status: HostRunStatus): boolean {
  return status === "running" || status === "stopping";
}

export class RunManager {
  private acceptingNewRuns = true;
  private runs = new Map<string, InternalRun>();
  private subscribers = new Map<string, Set<SseSink>>();
  private lifecycle: "open" | "closing" | "closed" = "open";
  private closePromise?: Promise<void>;
  // v2.0.1 JIT Approval：in-flight 批准请求（requestId → 裁决入口 + 超时定时器）
  private pendingApprovals = new Map<
    string,
    { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout>; runId: string }
  >();

  constructor(private readonly store: RunStore = createDefaultRunStore()) {
    // A process restart cannot leave persisted rows pretending to execute.
    // Do not auto-resume: checkpoint recovery remains an explicit user action.
    const now = new Date().toISOString();
    for (const run of this.store.listRuns()) {
      if (run.status !== "running" && run.status !== "stopping") continue;
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

  private ensureOpen(): void {
    if (this.lifecycle !== "open") {
      throw new Error("RunManager is not accepting new runs");
    }
  }

  close(): Promise<void> {
    if (this.lifecycle === "closed") return Promise.resolve();
    if (this.lifecycle === "closing" && this.closePromise) return this.closePromise;

    this.lifecycle = "closing";
    this.acceptingNewRuns = false;
    this.closePromise = (async () => {
      const activeRuns = [...this.runs.values()];
      const waitPromises: Promise<void>[] = [];
      for (const run of activeRuns) {
        if (isCancellable(run.status) && run.abortController) {
          run.cancelled = true;
          run.abortController.abort();
        }
        // 等待状态进入终态（超时则强制 finish）
        waitPromises.push(this.waitForRunTerminal(run.runId, 10_000));
        // 等待执行链真正结束（带 cap），确保 Store 关闭前 agent 不再写库
        waitPromises.push(this.waitAgentSettled(run, 2_000));
      }
      await Promise.all(waitPromises);

      // 关闭所有 SSE 连接
      for (const sinks of this.subscribers.values()) {
        for (const sink of sinks) {
          try { sink.end(); } catch { /* ignore shutdown write failures */ }
        }
      }
      this.subscribers.clear();

      // 关闭持久层（只关闭一次）
      try {
        this.store.close();
      } catch {
        // ignore store close errors
      }

      this.lifecycle = "closed";
    })();

    return this.closePromise;
  }

  // ---- v2.0.1 JIT Approval：Host 注入给 Runtime 的批准端口 ----
  // request() 把批准请求推给前端（SSE approval_requested），挂起等待用户裁决；
  // resolveApproval() 由 HTTP 端点（POST /runs/:id/approval）回传结果。
  // 超时（APPROVAL_TIMEOUT_MS）未裁决 → 自动拒绝（fail-closed，Run 不无限挂起）。
  approvalPort(): ApprovalPort {
    return {
      request: (req: NetworkApprovalRequest) => this.requestApproval(req),
    };
  }

  // 加载/恢复 Run 时需要新建端口的场景：同一实例共享 pendingApprovals 状态
  resolveApproval(runId: string, requestId: string, approved: boolean): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    if (pending.runId !== runId) return false;
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(requestId);
    pending.resolve(approved);
    // 广播裁决事件（审计）
    const run = this.runs.get(runId);
    if (run) {
      this.record(run, {
        type: "approval_resolved",
        runId,
        requestId,
        approved,
        timestamp: new Date().toISOString(),
      });
    }
    return true;
  }

  private requestApproval(req: NetworkApprovalRequest): Promise<boolean> {
    const runId = req.runId;
    const requestId = crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // 超时未裁决 → 自动拒绝
        if (this.pendingApprovals.delete(requestId)) {
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.pendingApprovals.set(requestId, { resolve, timer, runId });
      // 推给前端（不持久化：批准请求是瞬态 UI 交互，重放无意义；拒绝后 Run 自会恢复）
      const run = this.runs.get(runId);
      if (run) {
        this.record(run, {
          type: "approval_requested",
          runId,
          requestId,
          toolName: req.toolName,
          args: req.args,
          timestamp: req.timestamp,
        });
      }
    });
  }

  create(task: string): string {
    this.ensureOpen();
    return this.createInSession(task).runId;
  }

  createInSession(
    task: string,
    requestedSessionId?: string,
    opts?: { workspaceName?: string; startAgent?: boolean; permissionMode?: PermissionMode },
  ): { runId: string; sessionId: string } {
    this.ensureOpen();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    let session: StoredSession;
    if (requestedSessionId) {
      const persisted = this.store.getSession(requestedSessionId);
      if (!persisted) throw new Error("Session not found");
      if (this.store.listRunsBySession(requestedSessionId).some((item) => isCancellable(item.status))) {
        throw new Error("Session already has a running Run");
      }
      session = { ...persisted, updatedAt: now };
      this.store.updateSession(session);
    } else {
      let workspace = getWorkspace();
      if (opts?.workspaceName) {
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
    const resolved = this.resolveModelConfig();
    const permissionMode = opts?.permissionMode ?? DEFAULT_PERMISSION_MODE;
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
      model: resolved?.model,
      providerId: resolved?.providerId,
      baseUrl: resolved?.baseUrl,
      permissionMode,
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
    this.ensureOpen();
    const active = this.runs.get(runId);
    if (active && isCancellable(active.status)) return false;
    const persisted = this.store.getRun(runId);
    const checkpoint = loadCheckpoint(runId);
    if (!persisted || !checkpoint) return false;

    // Historical binding is immutable. Never fall back to currentWorkspace.
    // Resolve symlinks (macOS /var -> /private/var) before comparing.
    const normalizeRoot = (root: string): string => {
      try { return fs.realpathSync(root); } catch { return path.resolve(root); }
    };
    const persistedRoot = persisted.workspaceRoot ? normalizeRoot(persisted.workspaceRoot) : "";
    const checkpointRoot = checkpoint.workspaceRoot ? normalizeRoot(checkpoint.workspaceRoot) : "";
    if (checkpointRoot && persistedRoot && checkpointRoot !== persistedRoot) return false;
    const persistedPermission = storedPermissionMode(persisted.permissionMode);
    if (checkpoint.permissionMode && checkpoint.permissionMode !== persistedPermission) return false;

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
      model: persisted.model,
      providerId: persisted.providerId,
      baseUrl: persisted.baseUrl,
      permissionMode: persistedPermission,
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
      if (isCancellable(run.status) && run.workspaceRoot === workspaceRoot) {
        throw new Error("Workspace has a running Run");
      }
    }
    const runningInStore = this.store.listRuns({ includeDeleted: true }).some(
      (r) => r.workspaceRoot === workspaceRoot && isCancellable(r.status)
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
      (r) => r.workspaceRoot === workspaceRoot && isCancellable(r.status)
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
      (r) => r.sessionId === sessionId && isCancellable(r.status)
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
      (r) => r.sessionId === sessionId && isCancellable(r.status)
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

  // True cancellation（v1.6）状态机：
  //   running  -> stopping（持久化 + run_stopping 事件 + abort signal）
  //   stopping -> no-op（幂等）
  //   终态     -> no-op
  // 此时不立刻置 stopped —— 等 Runtime（LLM/tool/shell）真正退出后，
  // startAgent 的结束路径才 finish(run)（原子终态落盘）。
  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) {
      const stored = this.store.getRun(runId);
      return stored !== null && !this.isSessionDeleted(stored.sessionId);
    }
    if (this.isSessionDeleted(run.sessionId)) return false;
    // legacy fallback flag：主机制是 abortController.abort()；
    // 覆盖「abort 之后 agent 才 resolve」的完成竞态判定。
    run.cancelled = true;
    if (run.status === "running") {
      if (run.abortController) {
        this.markStopping(run);
      } else {
        // 占位 Run（persist 先于执行的窗口 / startAgent:false）：没有在途执行可等待，
        // 直接落 stopped（这同时让工作区/会话清理守卫不再被其阻塞）。
        this.finish(run);
      }
    }
    return true;
  }

  private markStopping(run: InternalRun): void {
    if (run.status !== "running") return;
    run.status = "stopping";
    run.updatedAt = new Date().toISOString();
    this.persistRunSafely(run);
    this.record(run, { type: "run_stopping", runId: run.runId, timestamp: run.updatedAt });
    run.abortController?.abort();
  }

  // v1.6 Atomic Run Finalization：completed / failed / stopped 三条终态路径
  // 全部走同一条管线 —— prepare → 原子持久化（status+event 同一事务）→
  // 提交成功后才应用 memory 并广播 SSE。终态不可覆盖（幂等：已终态 no-op）；
  // 持久化失败时 Run 保持原非终态、不广播终态，绝不降级为单独 update/append。
  private finalizeRun(
    run: InternalRun,
    status: TerminalRunStatus,
    extra?: { result?: string; error?: string },
  ): boolean {
    if (isTerminalRunStatus(run.status)) return false;
    const timestamp = new Date().toISOString();
    // 终态映射（业务语义归 RunManager；Store 只负责原子持久化）
    const terminalEvent: HostEvent =
      status === "completed"
        ? { type: "run_completed", runId: run.runId, timestamp, result: extra?.result }
        : status === "failed"
          ? { type: "run_failed", runId: run.runId, timestamp, error: extra?.error }
          : { type: "run_stopped", runId: run.runId, timestamp };
    const persisted: StoredRun = {
      ...this.toStoredRun(run),
      status,
      updatedAt: timestamp,
      ...(status === "completed" ? { result: extra?.result, error: undefined } : {}),
      ...(status === "failed" ? { error: extra?.error } : {}),
    };

    let seq: number;
    try {
      seq = this.store.finalizeRun(persisted, terminalEvent);
    } catch (err) {
      // 持久化失败 ≠ 执行失败：不伪造终态、不广播终态 SSE；Run 保持在原非终态。
      // 禁止降级为单独 updateRun/appendEvent（会重新制造状态与事件的不一致）。
      console.error(
        `[RunManager] terminal finalization failed for ${run.runId} (${run.status} → ${status}): ` +
        `${(err as Error).message} — run stays ${run.status}, terminal event not broadcast`
      );
      return false;
    }
    // 提交成功后才应用到内存并发布（memory 不会提前显示未持久化的终态）
    run.status = status;
    run.updatedAt = timestamp;
    if (status === "completed") {
      run.result = extra?.result;
      run.error = undefined;
    }
    if (status === "failed") {
      run.error = extra?.error;
    }
    this.publishEvent(run, terminalEvent, seq);
    return true;
  }

  private finish(run: InternalRun): void {
    // stopped 的进入边：running（同步 stop 竞态 / 占位 Run）或 stopping（取消完成路径）
    this.finalizeRun(run, "stopped");
  }

  // v1.6：仅发布已在持久层落库的事件（memory + SSE）；durability 优先于 delivery
  private publishEvent(run: InternalRun, event: HostEvent, seq: number): void {
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

  private async waitForRunTerminal(runId: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const run = this.runs.get(runId);
      if (!run || isTerminalRunStatus(run.status)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // 超时后强制终止（理论上 abort 已发出，这里做最后清理）
    const run = this.runs.get(runId);
    if (run && isCancellable(run.status)) {
      this.finish(run);
    }
  }

  // 等待执行链（agentPromise）真正 settle，带 cap 防卡死。
  // 主要目的：close() 关闭 Store 之前保证没有 agent 继续写库。
  private async waitAgentSettled(run: InternalRun, capMs: number): Promise<void> {
    const p = run.agentPromise;
    if (!p) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      p.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, capMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
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

    // True cancellation (v1.6)：每次执行一个独立 AbortController（resume 也一样）。
    const abortController = new AbortController();
    run.abortController = abortController;

    // Run 已经持久化为 running，任何启动失败都必须落为 failed + run_failed，
    // 不允许同步 throw 留下永远 running 的僵尸 Run（模型解析失败也走同一条路）。
    run.agentPromise = (async () => {
      let modelConfig: ModelConfig | undefined;
      try {
        modelConfig = this.modelConfigForRun(run);
      } catch (err) {
        this.failRun(run, (err as Error).message);
        return;
      }
      try {
        const result = await runAgent(task, resume, {
          executionContext: createAgentExecutionContext({
            runId: run.runId,
            workspaceRoot: run.workspaceRoot,
            permissionMode: run.permissionMode,
          }),
          ...createDefaultRuntimeServices(),
          approvalPort: this.approvalPort(),
          conversationHistory,
          modelConfig,
          contextHarness: new DefaultContextHarness({
            permissionMode: run.permissionMode,
            // No configured provider is a supported CLI/test compatibility
            // path; both Harness and LLM then resolve the same env fallback.
            modelConfig,
          }),
          signal: abortController.signal,
          onStreamDelta: queueDelta,
          onTrace: (event) => {
            flushDelta();
            this.record(run, event);
          },
        });
        flushDelta();
        // stop() 之后 agent 才正常 resolve 的竞态：用户意图是停止 → stopped
        if (run.cancelled || abortController.signal.aborted) {
          this.finish(run);
          return;
        }
        // v1.6：completed 终态原子落盘（status + run_completed 同一事务）
        this.finalizeRun(run, "completed", { result });
      } catch (err) {
        flushDelta();
        // 用户主动取消（signal 已 abort）→ stopped，绝不算 failed；
        // 其余 AbortError（非本 Run 的 signal）仍按失败处理。
        if (run.cancelled || (abortController.signal.aborted && isAbortError(err))) {
          this.finish(run);
          return;
        }
        this.failRun(run, (err as Error).message);
      }
    })();
  }

  private failRun(run: InternalRun, message: string): void {
    // v1.6：failed 终态与 run_failed 事件原子落盘（与 completed/stopped 同一管线）
    this.finalizeRun(run, "failed", { error: message });
  }

  // Persistence precedes SSE. If local storage fails, do not broadcast an
  // event the product cannot replay after restart; Runtime remains isolated
  // from Host observability failures.
  // 非终态事件（run_started/stopping/trace/delta）的追加路径：persist → memory → SSE。
  // 终态事件（run_completed/failed/stopped）不走这里 —— 必须走 finalizeRun 的
  // 原子管线（status+event 同一事务），避免状态与事件不一致。
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
      permissionMode: run.permissionMode,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      result: run.result,
      error: run.error,
      model: run.model,
      providerId: run.providerId,
      baseUrl: run.baseUrl,
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
      model: run.model,
      providerId: run.providerId,
      baseUrl: run.baseUrl,
      permissionMode: run.permissionMode,
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
      model: run.model,
      providerId: run.providerId,
      baseUrl: run.baseUrl,
      permissionMode: storedPermissionMode(run.permissionMode),
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

  getModelProvider(id: string) {
    return this.store.getModelProvider(id);
  }

  // 密钥只在服务端使用（如代拉 /models 目录），绝不进入 API 响应
  getModelProviderSecret(id: string) {
    return this.store.getModelProviderSecret(id);
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

  getDefaultProviderId(): string {
    return this.store.getDefaultProviderId();
  }

  getDefaultModelId(): string {
    return this.store.getDefaultModelId();
  }

  setDefaultModel(providerId: string, modelId?: string): { providerId: string; modelId: string } {
    return this.store.setDefaultModel(providerId, modelId);
  }

  // Host 启动时一次性导入 .env 环境模型配置（设置中已有导入标记则不重复）
  importEnvModelProvider(input: { baseUrl: string; apiKey: string; model: string }): { providerId: string; modelId: string } | null {
    return this.store.importEnvFallback(input);
  }

  // 原子解析模型配置：要么返回完整可用的 {providerId, baseUrl, apiKey, model}，
  // 要么返回 undefined（调用方整组回退环境配置）。绝不返回残缺元组：
  // 默认 Provider 只有配置了密钥且有模型时才参与选中，否则跳过（而不是拿着空密钥命中）。
  private resolveModelConfig(): ModelConfig | undefined {
    const providers = this.store.listModelProviders();
    const usable = (p: ModelProviderView): boolean => p.hasApiKey && p.models.length > 0;
    const defaultId = this.store.getDefaultProviderId();
    const byDefault = providers.find(p => p.id === defaultId && usable(p));
    const configured = byDefault ?? providers.find(usable);
    if (!configured) return undefined;
    const full = this.store.getModelProviderSecret(configured.id);
    if (!full?.apiKey || !full.baseUrl) return undefined;
    const defaultModelId = this.store.getDefaultModelId();
    const model =
      defaultId === configured.id && defaultModelId && configured.models.includes(defaultModelId)
        ? defaultModelId
        : configured.models[0];
    if (!model) return undefined;
    return {
      providerId: configured.id,
      baseUrl: full.baseUrl,
      apiKey: full.apiKey,
      model,
    };
  }

  // Run 快照绑定了 provider/model 时，必须仍能组成完整元组（密钥可能事后被清除）；
  // 组不出来就 fail-closed 抛错，由 startAgent 落为 failed Run。
  // 安全语义：Resume 必须使用当前完整配置（当前 baseUrl + 当前 Secret），
  // 禁止历史 baseUrl 与当前 Secret 混用；模型也必须在当前 provider 目录中。
  private modelConfigForRun(run: InternalRun): ModelConfig | undefined {
    if (run.providerId && run.model) {
      const secret = this.store.getModelProviderSecret(run.providerId);
      const provider = this.store.getModelProvider(run.providerId);
      if (!secret?.apiKey || !provider) {
        throw new Error(`Provider ${run.providerId} is not available for run ${run.runId}`);
      }
      if (!provider.models.includes(run.model)) {
        throw new Error(`Model ${run.model} is no longer in provider ${run.providerId} catalog`);
      }
      return {
        providerId: run.providerId,
        baseUrl: secret.baseUrl,
        apiKey: secret.apiKey,
        model: run.model,
      };
    }
    return this.resolveModelConfig();
  }
}
