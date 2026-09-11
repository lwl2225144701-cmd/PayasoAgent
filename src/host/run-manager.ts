// 模块: RunManager — Host 产品层状态管理
// 职责：活跃执行状态留在内存；Run 历史、状态和事件由 RunStore 持久化。
// 边界：只通过公开边界 runAgent 调用 Runtime；不持久化 Runtime checkpoint 内容。

import fs from 'node:fs';
import path from 'node:path';
import {
  createAgentExecutionContext,
  createDefaultRuntimeServices,
} from '../bootstrap/runtime-bootstrap.js';
import { DefaultContextHarness } from '../harness/context-harness.js';
import type { ContextHarnessState } from '../harness/context-state.js';
import type { ChatMessage, ChatStreamDelta, MessageImage, ModelConfig } from '../llm/llm.js';
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  storedPermissionMode,
} from '../permission-mode.js';
import {
  checkpointPath,
  loadCheckpoint,
} from '../persistence/file-checkpoint-store.js';
import { AgentStopRequestedError, runAgent } from '../runtime/agent.js';
import type { ApprovalPort } from '../runtime/approval-port.js';
import { writeAttachmentFile } from '../runtime/image-materialize.js';
import { prepareMacOSToolchain } from '../sandbox/macos-toolchain-preparer.js';
import { getRunWorkspaceRoot } from '../sandbox/sandbox-manager.js';
import {
  getRuntimeToolchainCapabilities,
  type RuntimeToolchainCapabilities,
} from '../sandbox/toolchain-manager.js';
import type {
  ToolchainPreparationPort,
  ToolchainPreparationRunner,
} from '../sandbox/toolchain-preparation.js';
import { isAbortError } from '../util/abort.js';
import type { SessionStats } from './run-stats.js';
import {
  readProjectInstructions,
  scanWorkspaceSkills,
} from './workspace-instructions.js';
import { disposeRunBackgroundJobs } from '../sandbox/background-jobs.js';
import { ModelService } from './model-service.js';
import { EventStreamService } from './event-stream-service.js';
import { ApprovalCoordinator } from './approval-coordinator.js';
import { ToolchainPreparationCoordinator } from './toolchain-preparation-coordinator.js';
import { PLAN_DIRECTIVE, SessionService } from './session-service.js';

import { expandPromptCommand, scanPromptCommands } from './prompt-command.js';
export { expandPromptCommand } from './prompt-command.js';

import { createDefaultRunStore } from './persistence/sqlite-store.js';
import {
  type CreateModelProviderInput,
  isTerminalRunStatus,
  type RunStore,
  type StoredRun,
  type StoredSession,
  type TerminalRunStatus,
  type UpdateModelProviderInput,
} from './persistence/store.js';
import type {
  HostAttachment,
  HostEvent,
  StreamingEvent,
} from './run-events.js';
import { getWorkspace } from './workspace.js';
import type {
  CleanupError,
  CreateRunAttachmentInput,
  HostRun,
  HostSession,
  SseSink,
} from './run-types.js';
import { isCancellable } from './run-types.js';
import {
  publicActiveView,
  publicStoredView,
  sessionTitle,
} from './run-views.js';
export type {
  CleanupError,
  CreateRunAttachmentInput,
  HostRun,
  HostSession,
  SseSink,
} from './run-types.js';

// 创建 Run 时随消息上传的图片附件（routes 已做 MIME/大小/数量校验；
// P1 起 routes 还会先经 attachment-normalize 归一化并附带尺寸元数据）。

// 附件在工作区内的落盘目录（相对 workspaceRoot）。
const ATTACHMENT_DIR = 'input/attachments';

interface InternalRun extends HostRun {
  events: HostEvent[];
  cancelled: boolean;
  workspaceRoot: string;
  providerId?: string;
  baseUrl?: string;
  // True cancellation (v1.6)：每个活跃 Run 独立的 AbortController；
  // startAgent 时创建，stop() 触发 abort，Run 真正退出后由 Host 落 stopped。
  abortController?: AbortController;
  // Host resource fuse for the unbounded Runtime loop. Keep timeout separate
  // from an explicit user stop so the terminal reason remains observable.
  abortReason?: 'user' | 'timeout';
  runTimeoutTimer?: ReturnType<typeof setTimeout>;
  // v1.6.1：执行链 promise 句柄（fire-and-forget 任务的引用）。
  // close() 用它等待执行链真正结束（而非仅状态变终态），避免 Store 关闭后 agent 仍在写库。
  agentPromise?: Promise<void>;
}


const INTERRUPTED_ERROR = 'Host restarted before the Run completed';
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;

function runTimeoutMs(): number {
  const raw = process.env.AGENT_RUN_TIMEOUT_MS;
  if (raw && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return DEFAULT_RUN_TIMEOUT_MS;
}

export class RunManager {
  private runs = new Map<string, InternalRun>();
  private lifecycle: 'open' | 'closing' | 'closed' = 'open';
  private closePromise?: Promise<void>;
  constructor(
    private readonly store: RunStore = createDefaultRunStore(),
    private readonly toolchainPreparer: ToolchainPreparationRunner = prepareMacOSToolchain,
    // v1.6 闭环④a：能力快照提供方可注入（测试确定性；生产用真实启动发现）
    private readonly toolchainCapabilitiesProvider: () => RuntimeToolchainCapabilities = getRuntimeToolchainCapabilities,
  ) {
    this.modelService = new ModelService({ store: this.store });
    this.eventStreamService = new EventStreamService({ store: this.store });
    this.sessionService = new SessionService({
      store: this.store,
      models: this.modelService,
      host: this,
    });
    this.approvalCoordinator = new ApprovalCoordinator({
      emit: (runId, event) => {
        const run = this.runs.get(runId);
        if (run) this.record(run, event);
      },
    });
    this.toolchainCoordinator = new ToolchainPreparationCoordinator({
      emit: (runId, event) => {
        const run = this.runs.get(runId);
        if (run) this.record(run, event);
      },
      preparer: this.toolchainPreparer,
      capabilitiesProvider: this.toolchainCapabilitiesProvider,
    });
    // A process restart cannot leave persisted rows pretending to execute.
    // Do not auto-resume: checkpoint recovery remains an explicit user action.
    const now = new Date().toISOString();
    for (const run of this.store.listRuns()) {
      if (run.status !== 'running' && run.status !== 'stopping') continue;
      const interrupted: StoredRun = {
        ...run,
        status: 'interrupted',
        updatedAt: now,
        error: INTERRUPTED_ERROR,
      };
      this.store.updateRun(interrupted);
      this.store.appendEvent(run.runId, {
        type: 'run_interrupted',
        runId: run.runId,
        timestamp: now,
        error: INTERRUPTED_ERROR,
      });
    }
  }

  private readonly eventStreamService: EventStreamService;
  private readonly modelService: ModelService;
  private readonly sessionService: SessionService;
  private readonly approvalCoordinator: ApprovalCoordinator;
  private readonly toolchainCoordinator: ToolchainPreparationCoordinator;

  private isSessionDeleted(sessionId: string): boolean {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    return !session || session.deletedAt !== undefined;
  }

  private ensureOpen(): void {
    if (this.lifecycle !== 'open') {
      throw new Error('RunManager is not accepting new runs');
    }
  }

  close(): Promise<void> {
    if (this.lifecycle === 'closed') return Promise.resolve();
    if (this.lifecycle === 'closing' && this.closePromise) return this.closePromise;

    this.lifecycle = 'closing';
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
      this.toolchainCoordinator.abortAll();
      await Promise.all(waitPromises);

      // 关闭所有 SSE 连接
      this.eventStreamService.closeAll();

      // 关闭持久层（只关闭一次）
      try {
        this.store.close();
      } catch {
        // ignore store close errors
      }

      this.lifecycle = 'closed';
    })();

    return this.closePromise;
  }

  // ---- v2.0.1 JIT Approval：Host 注入给 Runtime 的批准端口 ----
  // request() 把批准请求推给前端（SSE approval_requested），挂起等待用户裁决；
  // resolveApproval() 由 HTTP 端点（POST /runs/:id/approval）回传结果。
  // 超时未裁决 → 自动拒绝（fail-closed，Run 不无限挂起）。规则归 ApprovalCoordinator。
  approvalPort(): ApprovalPort {
    return this.approvalCoordinator.approvalPort();
  }

  resolveApproval(runId: string, requestId: string, approved: boolean): boolean {
    return this.approvalCoordinator.resolve(runId, requestId, approved);
  }


  // ---- macOS Toolchain Preparation：固定白名单 + 用户明确批准 ----
  // 规则归 ToolchainPreparationCoordinator（白名单、共享安装合并、能力刷新）。
  toolchainPreparationPort(): ToolchainPreparationPort {
    return this.toolchainCoordinator.toolchainPreparationPort();
  }

  resolveToolchainPreparation(runId: string, requestId: string, approved: boolean): boolean {
    return this.toolchainCoordinator.resolve(runId, requestId, approved);
  }

  cancelToolchainPreparation(runId: string, requestId: string): boolean {
    return this.toolchainCoordinator.cancel(runId, requestId);
  }


  create(task: string): string {
    this.ensureOpen();
    return this.createInSession(task).runId;
  }

  createInSession(
    task: string,
    requestedSessionId?: string,
    opts?: {
      workspaceName?: string;
      startAgent?: boolean;
      permissionMode?: PermissionMode;
      providerId?: string;
      model?: string;
      // 用户随消息发送的图片附件：Host 在会话工作区内落盘后把路径引用
      // 交给 Runtime（base64 不进 Run 状态 / 事件 / checkpoint）。
      attachments?: CreateRunAttachmentInput[];
    },
  ): { runId: string; sessionId: string } {
    this.ensureOpen();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    // Validate and snapshot the browser's explicit model selection before
    // creating a session/run. This prevents a fast send immediately after a
    // dropdown change from racing the asynchronous default-model save, and it
    // avoids leaving an orphan session when the selection is invalid.
    const resolved = this.modelService.resolveModelConfig(opts?.providerId, opts?.model);
    // 视觉强校验（在 session 落库之前拒绝，不产生孤儿会话）：模型配置已显式
    // 解析且视觉未开启 → 拒绝带图请求（400）。前端发前已警告；env 兜底模型
    // 能力未知，保持宽容不拒（物化阶段仍会剥图并注明）。
    if (opts?.attachments?.length && resolved && resolved.vision !== true) {
      throw new Error('当前模型已关闭视觉输入，已拒绝图片附件（可在设置中开启该模型的视觉能力）');
    }
    let session: StoredSession;
    if (requestedSessionId) {
      const persisted = this.store.getSession(requestedSessionId);
      if (!persisted) throw new Error('Session not found');
      if (
        this.store.listRunsBySession(requestedSessionId).some((item) => isCancellable(item.status))
      ) {
        throw new Error('Session already has a running Run');
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
        title: sessionTitle(task),
        workspaceRoot: workspace?.rootPath ?? getRunWorkspaceRoot(runId),
        workspaceName: workspace?.name ?? '',
        createdAt: now,
        updatedAt: now,
      };
      this.store.createSession(session);
    }
    const previousRuns = this.store.listRunsBySession(session.sessionId);
    const { messages: conversationHistory, harnessState: previousHarnessState } =
      this.conversationHistory(previousRuns);
    // /plan 模式：会话级标记 → 本轮强制只读 + 任务注入方案指令（覆盖用户所选档）。
    const planMode = this.sessionService.getSessionPlanMode(session.sessionId);
    let permissionMode: PermissionMode = opts?.permissionMode ?? DEFAULT_PERMISSION_MODE;
    if (planMode) permissionMode = 'read-only';
    // Prompt 命令展开：/cmd ... → 完整用户消息。未匹配则原样使用。
    const promptCommands = scanPromptCommands(session.workspaceRoot, permissionMode);
    const expandedTask = expandPromptCommand(task, promptCommands) ?? task;
    // Agent 实际收到的任务：plan 指令前缀 + 展开后的任务（run.task 仅作展示）。
    const agentTask = planMode ? `${PLAN_DIRECTIVE}\n\n${expandedTask}` : expandedTask;
    const run: InternalRun = {
      runId,
      sessionId: session.sessionId,
      turnIndex: previousRuns.length + 1,
      task: expandedTask,
      status: 'running',
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

    // 附件落盘（v2 内容寻址）：字节入库 sha256 去重 + 原子发布，再硬链接进
    // 会话工作区 input/attachments/（agent 可见，只读）。同名冲突由库自动加
    // 后缀，永不覆盖。落盘失败按创建失败处理（不留下无附件的 Run）。
    const attachmentImages: MessageImage[] = [];
    const attachmentViews: HostAttachment[] = [];
    for (const attachment of opts?.attachments ?? []) {
      const { relPath, sha256 } = writeAttachmentFile({
        workspaceRoot: run.workspaceRoot,
        directory: ATTACHMENT_DIR,
        fileName: `${runId.slice(0, 8)}-${attachment.name}`,
        dataBase64: attachment.dataBase64,
      });
      attachmentImages.push({
        mimeType: attachment.mimeType,
        path: relPath,
        sha256,
        width: attachment.width,
        height: attachment.height,
        originalDimensions: attachment.originalDimensions,
      });
      attachmentViews.push({ name: attachment.name, mimeType: attachment.mimeType, path: relPath });
    }

    // Persist before execution starts, so every Runtime event has a parent Run.
    this.store.createRun(this.toStoredRun(run));
    this.runs.set(runId, run);
    this.record(run, {
      type: 'run_started',
      runId,
      timestamp: now,
      ...(attachmentViews.length > 0 ? { attachments: attachmentViews } : {}),
    });
    if (opts?.startAgent !== false) {
      this.startAgent(
        run,
        agentTask,
        undefined,
        conversationHistory,
        previousHarnessState,
        attachmentImages,
      );
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
      try {
        return fs.realpathSync(root);
      } catch {
        return path.resolve(root);
      }
    };
    const persistedRoot = persisted.workspaceRoot ? normalizeRoot(persisted.workspaceRoot) : '';
    const checkpointRoot = checkpoint.workspaceRoot ? normalizeRoot(checkpoint.workspaceRoot) : '';
    if (checkpointRoot && persistedRoot && checkpointRoot !== persistedRoot) return false;
    const persistedPermission = storedPermissionMode(persisted.permissionMode);
    if (checkpoint.permissionMode && checkpoint.permissionMode !== persistedPermission)
      return false;

    const now = new Date().toISOString();
    const workspaceRoot =
      persisted.workspaceRoot || checkpoint.workspaceRoot || getRunWorkspaceRoot(runId);
    const workspaceName = persisted.workspaceName;
    const run: InternalRun = {
      runId,
      sessionId: persisted.sessionId,
      turnIndex: persisted.turnIndex,
      task: persisted.task,
      status: 'running',
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
    this.record(run, { type: 'run_started', runId, timestamp: now });
    this.startAgent(run, checkpoint.task, checkpoint);
    return true;
  }

  // ---- Session / Workspace 委托（组合服务 SessionService；对外 API 不变）----

  // SessionServiceHost：活跃 Run 容器窄访问（容器归 RunManager 所有）。
  listActiveRuns() {
    return [...this.runs.values()].map((run) => ({
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.status,
      workspaceRoot: run.workspaceRoot,
      workspace: run.workspace,
    }));
  }

  removeActiveRun(runId: string): CleanupError[] {
    this.runs.delete(runId);
    this.eventStreamService.closeRun(runId);
    return this.cleanupRun(runId);
  }

  renameActiveRunWorkspace(fromName: string, toName: string): void {
    for (const run of this.runs.values()) {
      if (run.workspace?.name === fromName) run.workspace = { name: toName };
    }
  }

  renameWorkspace(fromName: string, toName: string): { updated: number } {
    return this.sessionService.renameWorkspace(fromName, toName);
  }

  deleteWorkspace(sessionId: string): { deleted: number; updatedAt: string } {
    return this.sessionService.deleteWorkspace(sessionId);
  }

  restoreWorkspace(sessionId: string): { restored: number; updatedAt: string } {
    return this.sessionService.restoreWorkspace(sessionId);
  }

  purgeWorkspace(sessionId: string): { purged: number; cleanupErrors: CleanupError[] } {
    return this.sessionService.purgeWorkspace(sessionId);
  }

  renameSession(sessionId: string, title: string): { updatedAt: string; title: string } {
    return this.sessionService.renameSession(sessionId, title);
  }

  archiveSession(sessionId: string): { archived: number; updatedAt: string } {
    return this.sessionService.archiveSession(sessionId);
  }

  restoreSession(sessionId: string): { restored: number; updatedAt: string } {
    return this.sessionService.restoreSession(sessionId);
  }

  deleteSession(sessionId: string): { deleted: number; cleanupErrors: CleanupError[] } {
    return this.sessionService.deleteSession(sessionId);
  }


  private cleanupRun(runId: string): CleanupError[] {
    const errors: CleanupError[] = [];
    try {
      fs.rmSync(checkpointPath(runId), { force: true });
    } catch (err) {
      // 原始错误（可能含绝对路径）只写 Host 日志，不返回前端
      console.error(
        `[RunStore] purge checkpoint cleanup failed for ${runId}: ${(err as Error).message}`,
      );
      errors.push({ runId, target: 'checkpoint' });
    }
    try {
      const sandboxRoot = getRunWorkspaceRoot(runId);
      if (sandboxRoot && fs.existsSync(sandboxRoot)) {
        fs.rmSync(sandboxRoot, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(
        `[RunStore] purge sandbox cleanup failed for ${runId}: ${(err as Error).message}`,
      );
      errors.push({ runId, target: 'sandbox' });
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
    // Do not overwrite a timeout reason if the user clicks Stop while the
    // Host fuse is already aborting the Run; terminal status should retain
    // the first abort cause.
    run.abortReason ??= 'user';
    if (run.status === 'running') {
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
    if (run.status !== 'running') return;
    run.status = 'stopping';
    run.updatedAt = new Date().toISOString();
    this.persistRunSafely(run);
    this.record(run, { type: 'run_stopping', runId: run.runId, timestamp: run.updatedAt });
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
      status === 'completed'
        ? { type: 'run_completed', runId: run.runId, timestamp, result: extra?.result }
        : status === 'failed'
          ? { type: 'run_failed', runId: run.runId, timestamp, error: extra?.error }
          : { type: 'run_stopped', runId: run.runId, timestamp };
    const persisted: StoredRun = {
      ...this.toStoredRun(run),
      status,
      updatedAt: timestamp,
      ...(status === 'completed' ? { result: extra?.result, error: undefined } : {}),
      ...(status === 'failed' ? { error: extra?.error } : {}),
    };

    let seq: number;
    try {
      seq = this.store.finalizeRun(persisted, terminalEvent);
    } catch (err) {
      // 持久化失败 ≠ 执行失败：不伪造终态、不广播终态 SSE；Run 保持在原非终态。
      // 禁止降级为单独 updateRun/appendEvent（会重新制造状态与事件的不一致）。
      console.error(
        `[RunManager] terminal finalization failed for ${run.runId} (${run.status} → ${status}): ` +
          `${(err as Error).message} — run stays ${run.status}, terminal event not broadcast`,
      );
      return false;
    }
    if (run.runTimeoutTimer) {
      clearTimeout(run.runTimeoutTimer);
      run.runTimeoutTimer = undefined;
    }
    // v1.10：Run 进入终态即回收后台作业，绝不留下孤儿进程（幂等）。
    disposeRunBackgroundJobs(run.runId);
    // 提交成功后才应用到内存并发布（memory 不会提前显示未持久化的终态）
    run.status = status;
    run.updatedAt = timestamp;
    if (status === 'completed') {
      run.result = extra?.result;
      run.error = undefined;
    }
    if (status === 'failed') {
      run.error = extra?.error;
    }
    this.publishEvent(run, terminalEvent, seq);
    return true;
  }

  private finish(run: InternalRun): void {
    // stopped 的进入边：running（同步 stop 竞态 / 占位 Run）或 stopping（取消完成路径）
    this.finalizeRun(run, 'stopped');
  }

  // v1.6：仅发布已在持久层落库的事件（memory + SSE）；durability 优先于 delivery
  private publishEvent(run: InternalRun, event: HostEvent, seq: number): void {
    run.events.push(event);
    // 推流交给 EventStreamService（管理 live sink 生命周期）
    this.eventStreamService.publish(run.runId, seq, event);
  }

  list(): HostRun[] {
    return this.store.listRuns().map((run) => publicStoredView(run));
  }

  listSessions(): HostSession[] {
    return this.sessionService.listSessions();
  }

  getSession(sessionId: string): HostSession | null {
    return this.sessionService.getSession(sessionId);
  }

  findSessionByWorkspaceName(
    name: string,
    opts?: { includeDeleted?: boolean },
  ): StoredSession | null {
    return this.sessionService.findSessionByWorkspaceName(name, opts);
  }

  listSessionRuns(sessionId: string): HostRun[] | null {
    return this.sessionService.listSessionRuns(sessionId);
  }

  sessionStats(sessionId: string): SessionStats | null {
    return this.sessionService.sessionStats(sessionId);
  }

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
    return this.sessionService.compactSession(sessionId);
  }

  getSessionGoal(sessionId: string): string | null {
    return this.sessionService.getSessionGoal(sessionId);
  }

  setSessionGoal(sessionId: string, goal: string): boolean {
    return this.sessionService.setSessionGoal(sessionId, goal);
  }

  getSessionPlanMode(sessionId: string): boolean {
    return this.sessionService.getSessionPlanMode(sessionId);
  }

  setSessionPlanMode(sessionId: string, enabled: boolean): boolean {
    return this.sessionService.setSessionPlanMode(sessionId, enabled);
  }

  addSessionFeedback(sessionId: string, comment: string): boolean {
    return this.sessionService.addSessionFeedback(sessionId, comment);
  }

  buildSessionExport(sessionId: string): { fileName: string; bytes: Uint8Array } | null {
    return this.sessionService.buildSessionExport(sessionId);
  }


  get(runId: string): HostRun | null {
    const active = this.runs.get(runId);
    if (active && !this.isSessionDeleted(active.sessionId)) return publicActiveView(active);
    const stored = this.store.getRun(runId);
    return stored && !this.isSessionDeleted(stored.sessionId)
      ? publicStoredView(stored)
      : null;
  }

  getRaw(runId: string): InternalRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * Run 的完整事件日志快照（只读，供前端一次性取回）。
   *
   * 已完成 Run 的事件不可变，前端不需要为它维持 SSE 长连接：SSE 会占用浏览器
   * 同源 6 条并发额度，长会话（N 个历史回合同时挂载）打开时会退化成连接队列。
   * 与 `subscribe(runId, sink, 0)` 的回放同源，语义一致。
   * Run 不存在或所属会话已删除 → null（与 `get` 同一套可见性判定）。
   */
  listRunEvents(runId: string): HostEvent[] | null {
    if (!this.get(runId)) return null;
    return this.store.listEvents(runId).map((item) => item.event);
  }

  getWorkspaceRoot(runId: string): string | null {
    const active = this.runs.get(runId);
    if (active) {
      return this.isSessionDeleted(active.sessionId) ? null : active.workspaceRoot;
    }
    const stored = this.store.getRun(runId);
    return stored && !this.isSessionDeleted(stored.sessionId) ? stored.workspaceRoot : null;
  }

  // 当前工作区可用的 Prompt 命令（name + description）。只返回元数据，不暴露模板正文。
  // read-only 权限 / 无工作区 / 无 .payaso/prompts 目录 → 空数组（fail-closed）。
  listPromptCommands(): Array<{ name: string; description: string }> {
    const workspace = getWorkspace();
    if (!workspace?.rootPath) return [];
    // 当前会话默认权限：以最近一次 Run 或默认档为准。这里沿用默认权限门控；
    // 若没有活跃 Run 也无持久化权限，用最严格档（不加载）保证 fail-closed。
    return scanPromptCommands(workspace.rootPath, DEFAULT_PERMISSION_MODE).map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
    }));
  }

  subscribe(runId: string, sink: SseSink, afterSeq = 0, live = true): boolean {
    return this.eventStreamService.subscribe(runId, sink, afterSeq, live);
  }

  unsubscribe(runId: string, sink: SseSink): void {
    this.eventStreamService.unsubscribe(runId, sink);
  }

  private async waitForRunTerminal(runId: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const run = this.runs.get(runId);
      if (!run || isTerminalRunStatus(run.status)) return;
      // 没有在途执行链的占位 Run（startAgent:false / persist 先于执行的窗口）不会
      // 自己进入终态：等满 cap 只是让 close() 白等 10s。与 stop() 对占位 Run 的
      // 处理一致 —— 没有在途执行可等，直接走下面的兜底收口。
      if (!run.agentPromise) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
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
    previousHarnessState?: ContextHarnessState,
    attachments?: MessageImage[],
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
        pendingDelta &&
        pendingDelta.type === delta.type &&
        pendingDelta.messageId === delta.messageId
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
    const timeoutMs = runTimeoutMs();
    run.runTimeoutTimer = setTimeout(() => {
      if (run.status !== 'running' || run.abortReason) return;
      run.abortReason = 'timeout';
      this.markStopping(run);
    }, timeoutMs);
    run.runTimeoutTimer.unref?.();

    // Run 已经持久化为 running，任何启动失败都必须落为 failed + run_failed，
    // 不允许同步 throw 留下永远 running 的僵尸 Run（模型解析失败也走同一条路）。
    run.agentPromise = (async () => {
      let modelConfig: ModelConfig | undefined;
      try {
        modelConfig = this.modelService.modelConfigForRun(run);
      } catch (err) {
        this.failRun(run, (err as Error).message);
        return;
      }
      try {
        const projectInstructions = readProjectInstructions(run.workspaceRoot, run.permissionMode);
        const skills = scanWorkspaceSkills(run.workspaceRoot, run.permissionMode);
        const executionContext = createAgentExecutionContext({
          runId: run.runId,
          workspaceRoot: run.workspaceRoot,
          permissionMode: run.permissionMode,
          projectInstructions,
        });
        const result = await runAgent(task, resume, {
          executionContext,
          ...createDefaultRuntimeServices(),
          approvalPort: this.approvalPort(),
          toolchainPreparationPort: this.toolchainPreparationPort(),
          conversationHistory,
          attachments,
          modelConfig,
          contextHarness: (() => {
            const harness = new DefaultContextHarness({
              permissionMode: run.permissionMode,
              // No configured provider is a supported CLI/test compatibility
              // path; both Harness and LLM then resolve the same env fallback.
              modelConfig,
              toolchain: executionContext.toolchain,
              projectInstructions,
              workspaceName: run.workspace?.name ?? '',
            });
            harness.setSkills(skills);
            return harness;
          })(),
          previousHarnessState,
          signal: abortController.signal,
          onStreamDelta: queueDelta,
          onTrace: (event) => {
            flushDelta();
            this.record(run, event);
          },
        });
        flushDelta();
        if (run.abortReason === 'timeout') {
          this.failRun(run, `Run exceeded host time limit of ${timeoutMs}ms`);
          return;
        }
        // stop() 之后 agent 才正常 resolve 的竞态：用户意图是停止 → stopped
        if (run.cancelled || abortController.signal.aborted) {
          this.finish(run);
          return;
        }
        // v1.6：completed 终态原子落盘（status + run_completed 同一事务）
        this.finalizeRun(run, 'completed', { result });
      } catch (err) {
        flushDelta();
        if (run.abortReason === 'timeout') {
          this.failRun(run, `Run exceeded host time limit of ${timeoutMs}ms`);
          return;
        }
        if (err instanceof AgentStopRequestedError) {
          this.finish(run);
          return;
        }
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
    this.finalizeRun(run, 'failed', { error: message });
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
    this.eventStreamService.publish(run.runId, seq, event);
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
      workspaceName: run.workspace?.name ?? '',
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

  private conversationHistory(runs: StoredRun[]): {
    messages: ChatMessage[];
    harnessState?: ContextHarnessState;
  } {
    // 会话级上下文累计：每轮 Run 的 checkpoint 保存的是完整 canonical transcript
    // （含之前所有轮次 + 本轮全部工具交互）。新 Run 直接复用最近一个可用
    // checkpoint 的完整 transcript（去掉旧 system，保留 tool 调用链），而不是
    // 只拼 task + result —— 否则中间的工具交互/细节每轮都会丢失（上下文"重置"）。
    let messages: ChatMessage[] = [];
    let harnessState: ContextHarnessState | undefined;
    let lastCheckpointIndex = -1;
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index];
      if (run.status === 'running' || run.status === 'interrupted') continue;
      const checkpoint = loadCheckpoint(run.runId);
      if (checkpoint?.messages?.length) {
        messages = checkpoint.messages.filter((message) => message.role !== 'system');
        if (checkpoint.harnessState) harnessState = checkpoint.harnessState;
        lastCheckpointIndex = index;
      }
    }
    // 最近 checkpoint 之后的 Run（或全部无 checkpoint）：回退为 task + result 对。
    // Product errors may contain Host-only paths/provider details. Preserve
    // conversational continuity without feeding those internals to the LLM.
    for (let index = lastCheckpointIndex + 1; index < runs.length; index++) {
      const run = runs[index];
      if (run.status === 'running' || run.status === 'interrupted') continue;
      messages.push({ role: 'user', content: run.task });
      if (run.status === 'completed' && run.result) {
        messages.push({ role: 'assistant', content: run.result });
      } else {
        messages.push({ role: 'assistant', content: `上一轮未完成（${run.status}）` });
      }
    }
    return { messages, harnessState };
  }

  // ---- Model / Provider 委托（组合服务 ModelService；对外 API 不变）----
  listModelProviders() {
    return this.modelService.listModelProviders();
  }

  getModelProvider(id: string) {
    return this.modelService.getModelProvider(id);
  }

  // 密钥只在服务端使用（如代拉 /models 目录），绝不进入 API 响应
  getModelProviderSecret(id: string, model?: string) {
    return this.modelService.getModelProviderSecret(id, model);
  }

  addModelProvider(input: CreateModelProviderInput) {
    return this.modelService.addModelProvider(input);
  }

  updateModelProvider(id: string, input: UpdateModelProviderInput) {
    return this.modelService.updateModelProvider(id, input);
  }

  deleteModelProvider(id: string) {
    return this.modelService.deleteModelProvider(id);
  }

  getDefaultProviderId(): string {
    return this.modelService.getDefaultProviderId();
  }

  getDefaultModelId(): string {
    return this.modelService.getDefaultModelId();
  }

  setDefaultModel(providerId: string, modelId?: string): { providerId: string; modelId: string } {
    return this.modelService.setDefaultModel(providerId, modelId);
  }

  recordModelProbe(id: string, result: { status: 'available' | 'error'; error?: string }) {
    return this.modelService.recordModelProbe(id, result);
  }

  // Host 启动时一次性导入 .env 环境模型配置（设置中已有导入标记则不重复）
  importEnvModelProvider(input: {
    baseUrl: string;
    apiKey: string;
    model: string;
  }): { providerId: string; modelId: string } | null {
    return this.modelService.importEnvModelProvider(input);
  }
}
