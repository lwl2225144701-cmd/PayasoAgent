// 模块: SessionService —— RunManager 的 Session / Workspace 组合服务。
//
// 为什么单独存在：RunManager 里「Run 生命周期」与「Session/Workspace 管理与
// 会话命令」是两类职责。Session CRUD、归档、导出、goal/plan/feedback 与
// /compact 有真实业务规则（归档守卫、checkpoint 回退、fail-closed），独立成
// 服务后规则有唯一 owner，RunManager 只保留一行委托。
//
// 边界：只依赖 RunStore、ModelService 与注入的 SessionServiceHost（活跃 Run
// 容器窄访问），不反向依赖 RunManager。

import fs from 'node:fs';
import { DefaultContextHarness } from '../harness/context-harness.js';
import { normalizeContextHarnessState } from '../harness/context-state.js';
import {
  loadCheckpoint,
  saveCheckpoint,
} from '../persistence/file-checkpoint-store.js';
import type { Checkpoint } from '../runtime/checkpoint-port.js';
import { getSchemas } from '../tools/tools.js';
import { storedPermissionMode } from '../permission-mode.js';
import type { RunStore, StoredRun, StoredSession } from './persistence/store.js';
import { aggregateSessionStats, deriveRunStats, type SessionStats } from './run-stats.js';
import type { ModelService } from './model-service.js';
import { createZip, type ZipEntry } from './zip.js';
import type { CleanupError, HostRun, HostRunStatus, HostSession } from './run-types.js';
import { isCancellable } from './run-types.js';
import { publicSessionView, publicStoredView } from './run-views.js';
import { clearWorkspace, getWorkspace, renameWorkspaceLabel } from './workspace.js';

// 会话元数据 KV 键（一次建表支撑多个命令，键由本服务统一管理）
const META_PLAN_MODE = 'plan_mode';
const META_GOAL = 'goal';
const META_FEEDBACK_PREFIX = 'feedback:';

/** /plan 模式注入的任务前缀：只读权限 + 仅产出方案，等用户确认后再实施。 */
export const PLAN_DIRECTIVE =
  '[Plan 模式] 当前会话处于计划模式：只做调研、分析与方案设计，不要执行任何写入或修改类操作。' +
  '最终输出一份可执行计划（步骤、涉及文件、风险与验证方式），等待用户确认后再实施。';

export interface ActiveRunSnapshot {
  runId: string;
  sessionId: string;
  status: HostRunStatus;
  workspaceRoot: string;
  workspace?: { name: string };
}

// 活跃 Run 容器窄访问。Session 操作需要读取/修改「在内存中执行的 Run」，
// 但该容器归 RunManager（RunLifecycleService）所有；以接口注入避免
// SessionService 反向依赖 RunManager Facade。
export interface SessionServiceHost {
  listActiveRuns(): ActiveRunSnapshot[];
  /** 从活跃表移除 Run，并关闭其 SSE 流、清理 checkpoint/sandbox 资源。 */
  removeActiveRun(runId: string): CleanupError[];
  /** 工作区改名时，同步活跃 Run 的工作区标签。 */
  renameActiveRunWorkspace(fromName: string, toName: string): void;
}

export interface SessionServiceDeps {
  store: RunStore;
  models: ModelService;
  host: SessionServiceHost;
}

export class SessionService {
  private readonly store: RunStore;
  private readonly models: ModelService;
  private readonly host: SessionServiceHost;

  constructor(deps: SessionServiceDeps) {
    this.store = deps.store;
    this.models = deps.models;
    this.host = deps.host;
  }

  // ---- Workspace（会话维度）----

  renameWorkspace(fromName: string, toName: string): { updated: number } {
    if (toName === fromName) return { updated: 0 };
    const updated = this.store.renameSessionsWorkspace(fromName, toName);
    if (updated === 0) throw new Error(`Workspace not found: ${fromName}`);
    // Keep in-memory active Runs pointing at the same Workspace label.
    this.host.renameActiveRunWorkspace(fromName, toName);
    renameWorkspaceLabel(toName);
    return { updated };
  }

  deleteWorkspace(sessionId: string): { deleted: number; updatedAt: string } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error('Workspace not found');
    const workspaceRoot = session.workspaceRoot;

    for (const run of this.host.listActiveRuns()) {
      if (isCancellable(run.status) && run.workspaceRoot === workspaceRoot) {
        throw new Error('Workspace has a running Run');
      }
    }
    const runningInStore = this.store
      .listRuns({ includeDeleted: true })
      .some((r) => r.workspaceRoot === workspaceRoot && isCancellable(r.status));
    if (runningInStore) throw new Error('Workspace has a running Run');

    const now = new Date().toISOString();
    const deleted = this.store.softDeleteWorkspace(workspaceRoot, now);

    if (getWorkspace()?.rootPath === workspaceRoot) {
      clearWorkspace();
    }
    return { deleted, updatedAt: now };
  }

  restoreWorkspace(sessionId: string): { restored: number; updatedAt: string } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error('Workspace not found');
    const workspaceRoot = session.workspaceRoot;

    if (!fs.existsSync(workspaceRoot)) {
      throw new Error('Workspace path no longer exists');
    }
    const stat = fs.statSync(workspaceRoot);
    if (!stat.isDirectory()) {
      throw new Error('Workspace path is no longer a directory');
    }
    const real = fs.realpathSync.native(workspaceRoot);
    if (real !== workspaceRoot) {
      throw new Error('Workspace path has changed');
    }

    const now = new Date().toISOString();
    const restored = this.store.restoreWorkspace(workspaceRoot, now);
    return { restored, updatedAt: now };
  }

  purgeWorkspace(sessionId: string): { purged: number; cleanupErrors: CleanupError[] } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error('Workspace not found');
    const workspaceRoot = session.workspaceRoot;

    if (!session.deletedAt) {
      throw new Error('Workspace has not been deleted');
    }

    const hasRunning = this.store
      .listRuns({ includeDeleted: true })
      .some((r) => r.workspaceRoot === workspaceRoot && isCancellable(r.status));
    if (hasRunning) throw new Error('Workspace has a running Run');

    const runs = this.store
      .listRuns({ includeDeleted: true })
      .filter((r) => r.workspaceRoot === workspaceRoot);

    // 先清理数据库，再清理文件；数据库失败则 checkpoint 仍在，避免半完成状态
    const purged = this.store.purgeWorkspace(workspaceRoot);
    const cleanupErrors: CleanupError[] = [];
    for (const run of runs) {
      cleanupErrors.push(...this.host.removeActiveRun(run.runId));
    }
    return { purged, cleanupErrors };
  }

  // ---- Session CRUD ----

  renameSession(sessionId: string, title: string): { updatedAt: string; title: string } {
    this.store.renameSession(sessionId, title);
    const now = new Date().toISOString();
    return { updatedAt: now, title };
  }

  archiveSession(sessionId: string): { archived: number; updatedAt: string } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error('Session not found');
    if (session.deletedAt) throw new Error('Session already archived');

    const hasRunning = this.host.listActiveRuns().some(
      (r) => r.sessionId === sessionId && isCancellable(r.status),
    );
    if (hasRunning) throw new Error('Session has a running Run');

    const now = new Date().toISOString();
    const archived = this.store.archiveSession(sessionId, now);
    return { archived, updatedAt: now };
  }

  restoreSession(sessionId: string): { restored: number; updatedAt: string } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error('Session not found');
    if (!session.deletedAt) throw new Error('Session is not archived');

    const now = new Date().toISOString();
    const restored = this.store.restoreSession(sessionId, now);
    return { restored, updatedAt: now };
  }

  deleteSession(sessionId: string): { deleted: number; cleanupErrors: CleanupError[] } {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    if (!session) throw new Error('Session not found');
    if (!session.deletedAt) throw new Error('Session has not been archived');

    const hasRunning = this.store
      .listRuns({ includeDeleted: true })
      .some((r) => r.sessionId === sessionId && isCancellable(r.status));
    if (hasRunning) throw new Error('Session has a running Run');

    const runs = this.store.listRunsBySession(sessionId, { includeDeleted: true });
    const deleted = this.store.deleteSession(sessionId);
    const cleanupErrors: CleanupError[] = [];
    for (const run of runs) {
      cleanupErrors.push(...this.host.removeActiveRun(run.runId));
    }
    return { deleted, cleanupErrors };
  }

  // ---- Session 查询与统计 ----

  listSessions(): HostSession[] {
    return this.store.listSessions().map((session) => publicSessionView(session));
  }

  getSession(sessionId: string): HostSession | null {
    const session = this.store.getSession(sessionId);
    return session ? publicSessionView(session) : null;
  }

  findSessionByWorkspaceName(
    name: string,
    opts?: { includeDeleted?: boolean },
  ): StoredSession | null {
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
    return this.store.listRunsBySession(sessionId).map((run) => publicStoredView(run));
  }

  /** 会话级统计投影：折叠每个 Run 的持久化事件并聚合（顶栏 stats strip 数据源）。 */
  sessionStats(sessionId: string): SessionStats | null {
    if (!this.store.getSession(sessionId)) return null;
    const runs = this.store.listRunsBySession(sessionId);
    const stats = runs.map((run) => {
      const events = this.store.listEvents(run.runId).map((item) => item.event);
      return deriveRunStats(events, run.createdAt, run.updatedAt);
    });
    return aggregateSessionStats(stats, runs.length);
  }

  // ---- 会话命令（/compact /export /feedback /goal /plan）----

  /**
   * /compact：立即对会话执行一次轮边界压缩（不走「下一轮生效」的延迟路径）。
   * 从最新 Run 往前找第一个带 checkpoint 的（与 conversationHistory 的回退一致），
   * 以 target=0 压缩**全部**可压缩历史（不按预算只裁一部分）——摘要后把新
   * Harness 状态写回同一 checkpoint，下一个 Run 即以压缩后视图启动。
   * 有运行中 Run 时拒绝（避免 checkpoint 写入竞争）。
   */
  async compactSession(sessionId: string): Promise<{
    summarizedMessages: number;
    totalSummarizedMessages: number;
    compactedTokens: number;
    reason?: 'no_checkpoint' | 'nothing_compactable';
    /** 压缩后模型视图的输入占用（供前端立即刷新上下文占用环）。 */
    usage?: {
      messageTokens: number;
      systemTokens?: number;
      toolSchemaTokens: number;
      estimatedInputTokens: number;
      inputBudgetTokens: number;
      usageRatio: number;
    };
  } | null> {
    if (!this.store.getSession(sessionId)) return null;
    if (this.store.listRunsBySession(sessionId).some((run) => isCancellable(run.status))) {
      throw new Error('会话有正在执行的 Run，请先停止再压缩');
    }
    const runs = this.store.listRunsBySession(sessionId);
    let checkpointSource: StoredRun | undefined;
    let checkpoint: Checkpoint | null = null;
    for (const run of [...runs].reverse()) {
      const candidate = loadCheckpoint(run.runId);
      if (candidate && candidate.messages.length > 0) {
        checkpointSource = run;
        checkpoint = candidate;
        break;
      }
    }
    if (!checkpointSource || !checkpoint) {
      return {
        summarizedMessages: 0,
        totalSummarizedMessages: 0,
        compactedTokens: 0,
        reason: 'no_checkpoint' as const,
      };
    }
    const harness = new DefaultContextHarness({
      permissionMode: storedPermissionMode(checkpointSource.permissionMode),
      modelConfig: this.models.resolveModelConfig(
        checkpointSource.providerId,
        checkpointSource.model,
      ),
    });
    harness.restoreState(normalizeContextHarnessState(checkpoint.harnessState));
    // target=0：立即压缩不按预算裁一部分，而是压缩全部可压缩历史轮
    const compacted = await harness.compactConversation(checkpoint.messages, getSchemas(), 0);
    if (!compacted) {
      return {
        summarizedMessages: 0,
        totalSummarizedMessages: 0,
        compactedTokens: 0,
        reason: 'nothing_compactable' as const,
      };
    }
    saveCheckpoint({ ...checkpoint, harnessState: harness.snapshotState() });
    return {
      summarizedMessages: compacted.summarizedMessages,
      totalSummarizedMessages: compacted.totalSummarizedMessages,
      compactedTokens: compacted.compactedTokens,
      usage: harness.estimateViewUsage(checkpoint.messages, getSchemas()),
    };
  }

  getSessionGoal(sessionId: string): string | null {
    return this.store.getSessionMeta(sessionId, META_GOAL);
  }

  setSessionGoal(sessionId: string, goal: string): boolean {
    if (!this.store.getSession(sessionId)) return false;
    const trimmed = goal.trim();
    if (!trimmed) this.store.deleteSessionMeta(sessionId, META_GOAL);
    else this.store.setSessionMeta(sessionId, META_GOAL, trimmed);
    return true;
  }

  getSessionPlanMode(sessionId: string): boolean {
    return this.store.getSessionMeta(sessionId, META_PLAN_MODE) === '1';
  }

  setSessionPlanMode(sessionId: string, enabled: boolean): boolean {
    if (!this.store.getSession(sessionId)) return false;
    this.store.setSessionMeta(sessionId, META_PLAN_MODE, enabled ? '1' : '0');
    return true;
  }

  addSessionFeedback(sessionId: string, comment: string): boolean {
    if (!this.store.getSession(sessionId)) return false;
    const key = `${META_FEEDBACK_PREFIX}${Date.now()}`;
    this.store.setSessionMeta(sessionId, key, comment.trim());
    return true;
  }

  /** /export：把会话（元数据 + Runs + 每轮事件 + 命令元数据）打成 ZIP 字节。 */
  buildSessionExport(sessionId: string): { fileName: string; bytes: Uint8Array } | null {
    const session = this.store.getSession(sessionId);
    if (!session) return null;
    const runs = this.store.listRunsBySession(sessionId);

    const entries: ZipEntry[] = [
      {
        name: 'session.json',
        data: JSON.stringify(
          {
            sessionId: session.sessionId,
            title: session.title,
            workspaceName: session.workspaceName,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            exportedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      },
      {
        name: 'runs.jsonl',
        data: runs.map((run) => JSON.stringify(publicStoredView(run))).join('\n'),
      },
      {
        name: 'meta.json',
        data: JSON.stringify(
          {
            goal: this.store.getSessionMeta(sessionId, META_GOAL),
            planMode: this.getSessionPlanMode(sessionId),
            feedback: this.store
              .listSessionMeta(sessionId, META_FEEDBACK_PREFIX)
              .map((item) => ({
                at: item.key.slice(META_FEEDBACK_PREFIX.length),
                comment: item.value,
              })),
          },
          null,
          2,
        ),
      },
    ];
    for (const run of runs) {
      const lines = this.store
        .listEvents(run.runId)
        .map((item) => JSON.stringify(item.event))
        .join('\n');
      entries.push({
        name: `events/${String(run.turnIndex).padStart(3, '0')}-${run.runId}.jsonl`,
        data: lines,
      });
    }
    return {
      fileName: `payaso-session-${sessionId.slice(0, 8)}.zip`,
      bytes: createZip(entries),
    };
  }
}