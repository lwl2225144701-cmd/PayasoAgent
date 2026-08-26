// 模块: RunManager — Host 产品层状态管理（内存保存，不落库）
// 职责：维护 HostRun 元数据、启动/恢复/停止 Run、广播 Trace/生命周期事件给 SSE 订阅者。
// 边界：只通过公开边界 runAgent 调用 Runtime；Host 不接触 Runtime 内部对象、不直接 execute。
// 注意：HostRun.status 是 Host 层状态机（running/completed/failed/stopped），
//       与 Runtime 的 Task Outcome 判读（calculator NaN 等）互相独立。

import { runAgent } from "../runtime/agent.js";
import { loadCheckpoint } from "../runtime/checkpoint.js";
import { sseEncode, type HostEvent } from "./run-events.js";
import { getWorkspace, workspacePublicView } from "./workspace.js";
import path from "node:path";
import { getRunWorkspaceRoot } from "../sandbox/sandbox-manager.js";

export type HostRunStatus = "running" | "completed" | "failed" | "stopped";

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

// 内部 run 记录（含事件缓冲 + 取消标记，不对外暴露）
interface InternalRun extends HostRun {
  events: HostEvent[];
  cancelled: boolean;
  workspaceRoot?: string;
}

// SSE 订阅者：持有下游响应写入（由 server 层提供）
export interface SseSink {
  write: (chunk: string) => void;
  end: () => void;
  closed: () => boolean;
}

export class RunManager {
  private runs = new Map<string, InternalRun>();
  private subscribers = new Map<string, Set<SseSink>>();
  // 简单自增事件序号（SSE id）
  private counters = new Map<string, number>();

  // ---- 创建 Run：立即返回 runId，Agent 后台执行 ----
  create(task: string): string {
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workspace = getWorkspace();
    const run: InternalRun = {
      runId,
      task,
      status: "running",
      createdAt: now,
      updatedAt: now,
      events: [],
      cancelled: false,
      workspace: workspacePublicView(workspace) ?? undefined,
      workspaceRoot: workspace?.rootPath ?? getRunWorkspaceRoot(runId),
    };
    this.runs.set(runId, run);
    this.counters.set(runId, 0);
    this.record(run, { type: "run_started", runId, timestamp: now });

    // 启动后台 Run（不 await，立即返回）
    void runAgent(task, undefined, {
      runId,
      workspaceRoot: run.workspaceRoot,
      onTrace: (ev) => this.record(run, ev),
      isCancelled: () => run.cancelled,
    })
      .then((result) => {
        if (run.cancelled) {
          this.finish(run, "stopped");
          return;
        }
        run.status = "completed";
        run.result = result;
        run.updatedAt = new Date().toISOString();
        this.record(run, { type: "run_completed", runId, timestamp: run.updatedAt, result });
      })
      .catch((err: unknown) => {
        if (run.cancelled) {
          this.finish(run, "stopped");
          return;
        }
        run.status = "failed";
        run.error = (err as Error).message;
        run.updatedAt = new Date().toISOString();
        this.record(run, { type: "run_failed", runId, timestamp: run.updatedAt, error: run.error });
      });
    return runId;
  }

  // ---- 复用 Checkpoint/Resume 恢复 Run（该 runId 需有 checkpoint）----
  resume(runId: string): boolean {
    // A single Host process may only have one active executor for a runId.
    // Check this before loading/replacing the in-memory record so two agents
    // can never race on the same checkpoint and Workspace.
    if (this.runs.get(runId)?.status === "running") return false;
    const cp = loadCheckpoint(runId);
    if (!cp) return false;
    const now = new Date().toISOString();
    const workspace = cp.workspaceRoot
      ? { rootPath: cp.workspaceRoot, name: path.basename(cp.workspaceRoot) || cp.workspaceRoot }
      : null;
    const run: InternalRun = {
      runId,
      task: cp.task,
      status: "running",
      createdAt: now,
      updatedAt: now,
      events: [],
      cancelled: false,
      workspace: workspacePublicView(workspace) ?? undefined,
      workspaceRoot: cp.workspaceRoot ?? getRunWorkspaceRoot(runId),
    };
    this.runs.set(runId, run);
    this.counters.set(runId, 0);
    this.record(run, { type: "run_started", runId, timestamp: now });
    void runAgent(cp.task, cp, {
      runId,
      onTrace: (ev) => this.record(run, ev),
      isCancelled: () => run.cancelled,
    })
      .then((result) => {
        if (run.cancelled) { this.finish(run, "stopped"); return; }
        run.status = "completed"; run.result = result; run.updatedAt = new Date().toISOString();
        this.record(run, { type: "run_completed", runId, timestamp: run.updatedAt, result });
      })
      .catch((err: unknown) => {
        if (run.cancelled) { this.finish(run, "stopped"); return; }
        run.status = "failed"; run.error = (err as Error).message; run.updatedAt = new Date().toISOString();
        this.record(run, { type: "run_failed", runId, timestamp: run.updatedAt, error: run.error });
      });
    return true;
  }

  // ---- Stop（受限能力）：标记取消 + 置为 stopped。
  // 依赖 runAgent 在迭代边界检查 isCancelled；无法打断进行中的单个 LLM await，
  // 因此 stop 会在当前迭代结束后生效。底层若已结束，则保持其结果状态。
  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (run.status === "completed" || run.status === "failed" || run.status === "stopped") {
      // 已终结：标记 cancelled 防止后续重名误判，状态保持不变
      run.cancelled = true;
      return true;
    }
    run.cancelled = true;
    this.finish(run, "stopped");
    return true;
  }

  private finish(run: InternalRun, status: HostRunStatus): void {
    if (run.status !== "running") return; // 已在终结态则不再覆盖
    run.status = status;
    run.updatedAt = new Date().toISOString();
    if (status === "stopped") {
      this.record(run, { type: "run_stopped", runId: run.runId, timestamp: run.updatedAt });
    }
  }

  // ---- 查询 ----
  list(): HostRun[] {
    return [...this.runs.values()].map((r) => this.publicView(r));
  }

  get(runId: string): HostRun | null {
    const r = this.runs.get(runId);
    return r ? this.publicView(r) : null;
  }

  getRaw(runId: string): InternalRun | undefined {
    return this.runs.get(runId);
  }

  getWorkspaceRoot(runId: string): string | null {
    return this.runs.get(runId)?.workspaceRoot ?? null;
  }

  private publicView(r: InternalRun): HostRun {
    return {
      runId: r.runId,
      task: r.task,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      result: r.result,
      error: r.error,
      workspace: r.workspace,
    };
  }

  // ---- SSE 订阅/退订 ----
  subscribe(runId: string, sink: SseSink): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (!this.subscribers.has(runId)) this.subscribers.set(runId, new Set());
    const set = this.subscribers.get(runId)!;
    // 回放历史事件，再进入实时流
    run.events.forEach((ev, idx) => {
      if (!sink.closed()) sink.write(sseEncode(idx + 1, ev));
    });
    set.add(sink);
    return true;
  }

  unsubscribe(runId: string, sink: SseSink): void {
    this.subscribers.get(runId)?.delete(sink);
  }

  // ---- 记录事件到 run 缓冲 + 广播给订阅者 ----
  private record(run: InternalRun, ev: HostEvent): void {
    try {
      run.events.push(ev);
      const id = (this.counters.get(run.runId) ?? 0) + 1;
      this.counters.set(run.runId, id);
      const set = this.subscribers.get(run.runId);
      if (set) {
        const chunk = sseEncode(id, ev);
        for (const sink of set) {
          if (!sink.closed()) {
            try { sink.write(chunk); } catch { /* 忽略单写失败 */ }
          }
        }
      }
    } catch {
      // Host 层为此类可观测路径兜底：事件记录失败不应影响 Runtime 执行
    }
  }
}
