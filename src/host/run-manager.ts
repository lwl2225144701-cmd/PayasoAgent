// 模块: RunManager — Host 产品层状态管理
// 职责：活跃执行状态留在内存；Run 历史、状态和事件由 RunStore 持久化。
// 边界：只通过公开边界 runAgent 调用 Runtime；不持久化 Runtime checkpoint 内容。

import { runAgent } from "../runtime/agent.js";
import { loadCheckpoint } from "../runtime/checkpoint.js";
import { getRunWorkspaceRoot } from "../sandbox/sandbox-manager.js";
import { sseEncode, type HostEvent } from "./run-events.js";
import { createDefaultRunStore } from "./persistence/sqlite-store.js";
import type { RunStore, StoredRun, StoredRunStatus } from "./persistence/store.js";
import { getWorkspace, workspacePublicView } from "./workspace.js";

export type HostRunStatus = StoredRunStatus;

export interface HostRun {
  runId: string;
  task: string;
  status: HostRunStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  workspace?: { name: string };
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

  create(task: string): string {
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workspace = getWorkspace();
    const workspaceRoot = workspace?.rootPath ?? getRunWorkspaceRoot(runId);
    const workspaceName = workspace?.name ?? "";
    const run: InternalRun = {
      runId,
      task,
      status: "running",
      createdAt: now,
      updatedAt: now,
      events: [],
      cancelled: false,
      workspace: workspacePublicView(workspace) ?? undefined,
      workspaceRoot,
    };

    // Persist before execution starts, so every Runtime event has a parent Run.
    this.store.createRun(this.toStoredRun(run));
    this.runs.set(runId, run);
    this.record(run, { type: "run_started", runId, timestamp: now });
    this.startAgent(run, task);
    return runId;
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

  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return this.store.getRun(runId) !== null;
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

  get(runId: string): HostRun | null {
    const active = this.runs.get(runId);
    if (active) return this.publicView(active);
    const stored = this.store.getRun(runId);
    return stored ? this.publicStoredView(stored) : null;
  }

  getRaw(runId: string): InternalRun | undefined {
    return this.runs.get(runId);
  }

  getWorkspaceRoot(runId: string): string | null {
    return this.runs.get(runId)?.workspaceRoot ?? this.store.getRun(runId)?.workspaceRoot ?? null;
  }

  subscribe(runId: string, sink: SseSink, afterSeq = 0): boolean {
    if (!this.store.getRun(runId)) return false;
    if (!this.subscribers.has(runId)) this.subscribers.set(runId, new Set());
    const set = this.subscribers.get(runId)!;
    for (const item of this.store.listEvents(runId)) {
      if (item.seq <= afterSeq) continue;
      if (!sink.closed()) sink.write(sseEncode(item.seq, item.event));
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

  private startAgent(run: InternalRun, task: string, resume?: Parameters<typeof runAgent>[1]): void {
    void runAgent(task, resume, {
      runId: run.runId,
      workspaceRoot: run.workspaceRoot,
      onTrace: (event) => this.record(run, event),
      isCancelled: () => run.cancelled,
    })
      .then((result) => {
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
      task: run.task,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      result: run.result,
      error: run.error,
      workspace: run.workspaceName ? { name: run.workspaceName } : undefined,
    };
  }
}
