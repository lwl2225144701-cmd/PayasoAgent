// 模块: RunLifecycleService —— RunManager 的 Run 生命周期组合服务。
//
// 为什么单独存在：Run 生命周期（create/resume/stop/finalize/startAgent）是
// 产品层最核心的一类职责，包含真实业务规则（原子终态落盘、true cancellation
// 状态机、checkpoint 恢复校验、流式 delta 合并）。独立成服务后这些规则有
// 唯一 owner；RunManager 只保留一行委托与门面组装。
//
// 边界：活跃 Run 容器（runs map）归本服务所有；只依赖注入的 store / 组合服务
// （Model / Session / Approval / Toolchain / Event），不反向依赖 RunManager。

import fs from 'node:fs';
import path from 'node:path';
import type { TextAttachmentRef } from '../attachment-types.js';
import { restoreAttachment } from '../attachments/store.js';
import { refreshExtraction } from './attachments/refresh-extraction.js';
import {
  createAgentExecutionContext,
  createDefaultRuntimeServices,
} from '../bootstrap/runtime-bootstrap.js';
import { attachmentManifest } from '../harness/attachment-manifest.js';
import { DefaultContextHarness } from '../harness/context-harness.js';
import type { ContextHarnessState } from '../harness/context-state.js';
import type { ChatMessage, ChatStreamDelta, MessageImage, ModelConfig } from '../llm/llm.js';
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  storedPermissionMode,
} from '../permission-mode.js';
import { checkpointPath, loadCheckpoint } from '../persistence/file-checkpoint-store.js';
import { AgentStopRequestedError, runAgent } from '../runtime/agent.js';
import { createWorkspace, getRunWorkspaceRoot } from '../sandbox/sandbox-manager.js';
import { isAbortError } from '../util/abort.js';
import type { ApprovalCoordinator } from './approval-coordinator.js';
import { publishAttachments } from './attachments/publish.js';
import type { EventStreamService } from './event-stream-service.js';
import type { ModelService } from './model-service.js';
import {
  isTerminalRunStatus,
  type RunStore,
  type StoredRun,
  type StoredSession,
  type TerminalRunStatus,
} from './persistence/store.js';
import { expandPromptCommand, scanPromptCommands } from './prompt-command.js';
import type { HostAttachment, HostEvent, StreamingEvent } from './run-events.js';
import type { CreateRunAttachmentInput } from './run-types.js';
import { type CleanupError, type HostRun, isCancellable } from './run-types.js';
import { publicActiveView, publicStoredView, sessionTitle } from './run-views.js';

// HostAttachment（含 mimeType 等展示字段）→ 模型侧清单引用（仅定位信息）。
type TextLikeAttachment = Omit<HostAttachment, 'kind'> & { kind?: 'text' | 'binary' };
function asTextAttachmentRefs(views: HostAttachment[]): TextAttachmentRef[] {
  return views
    .filter((item): item is TextLikeAttachment => item.kind === 'text' || item.kind === 'binary')
    .map(({ name, path, sizeBytes, sha256, kind, extraction }) => ({
      name,
      path,
      sizeBytes,
      sha256,
      kind,
      extraction,
    }));
}

import type { SessionService } from './session-service.js';
import { PLAN_DIRECTIVE } from './session-service.js';
import { prepareTaskConstraints, renderEvidence } from './task-constraints.js';
import type { ToolchainPreparationCoordinator } from './toolchain-preparation-coordinator.js';
import { getWorkspace } from './workspace.js';
import { readProjectInstructions, scanWorkspaceSkills } from './workspace-instructions.js';

const INTERRUPTED_ERROR = 'Host restarted before the Run completed';

export interface InternalRun extends HostRun {
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

export interface RunLifecycleServiceDeps {
  store: RunStore;
  models: ModelService;
  sessions: SessionService;
  approvals: ApprovalCoordinator;
  toolchain: ToolchainPreparationCoordinator;
  events: EventStreamService;
}

export class RunLifecycleService {
  private readonly runs = new Map<string, InternalRun>();
  private readonly store: RunStore;
  private readonly models: ModelService;
  private readonly sessions: SessionService;
  private readonly approvals: ApprovalCoordinator;
  private readonly toolchain: ToolchainPreparationCoordinator;
  private readonly events: EventStreamService;

  constructor(deps: RunLifecycleServiceDeps) {
    this.store = deps.store;
    this.models = deps.models;
    this.sessions = deps.sessions;
    this.approvals = deps.approvals;
    this.toolchain = deps.toolchain;
    this.events = deps.events;

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

  private isSessionDeleted(sessionId: string): boolean {
    const session = this.store.getSession(sessionId, { includeDeleted: true });
    return !session || session.deletedAt !== undefined;
  }

  // ---- 创建 / 恢复 ----

  createInSession(
    task: string,
    requestedSessionId?: string,
    opts?: {
      workspaceName?: string;
      startAgent?: boolean;
      constraints?: import('../task-constraints.js').TaskConstraintsInput;
      permissionMode?: PermissionMode;
      providerId?: string;
      model?: string;
      // 用户随消息发送的图片附件：Host 在会话工作区内落盘后把路径引用
      // 交给 Runtime（base64 不进 Run 状态 / 事件 / checkpoint）。
      attachments?: CreateRunAttachmentInput[];
    },
  ): { runId: string; sessionId: string } {
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    // Validate and snapshot the browser's explicit model selection before
    // creating a session/run. This prevents a fast send immediately after a
    // dropdown change from racing the asynchronous default-model save, and it
    // avoids leaving an orphan session when the selection is invalid.
    const resolved = this.models.resolveModelConfig(opts?.providerId, opts?.model);
    // 视觉强校验（在 session 落库之前拒绝，不产生孤儿会话）：模型配置已显式
    // 解析且视觉未开启 → 拒绝带图请求（400）。前端发前已警告；env 兜底模型
    // 能力未知，保持宽容不拒（物化阶段仍会剥图并注明）。
    if (
      opts?.attachments?.some((item) => item.mimeType.startsWith('image/')) &&
      resolved &&
      resolved.vision !== true
    ) {
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
    }
    const previousRuns = this.store.listRunsBySession(session.sessionId);
    const { messages: conversationHistory, harnessState: previousHarnessState } =
      this.conversationHistory(previousRuns);
    // /plan 模式：会话级标记 → 本轮强制只读 + 任务注入方案指令（覆盖用户所选档）。
    const planMode = this.sessions.getSessionPlanMode(session.sessionId);
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
    // 旧式 per-run 工作区要等 startAgent 里的 createWorkspace 才真正创建；
    // 落附件早于那一步，必须先确保根存在，否则 assertInsideRoot 对不存在
    // 的根直接拒绝 ——「默认工作区 + 会话首个 Run + 带附件」必现 400。
    if (run.workspaceRoot === getRunWorkspaceRoot(runId)) createWorkspace(runId);
    run.constraints = prepareTaskConstraints(run.workspaceRoot, opts?.constraints);
    if (run.constraints?.evidence) run.permissionMode = 'read-only';
    const { images: attachmentImages, views: attachmentViews } = publishAttachments(
      run.workspaceRoot,
      runId,
      opts?.attachments ?? [],
    );

    if (requestedSessionId) this.store.updateSession(session);
    else this.store.createSession(session);

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
        asTextAttachmentRefs(attachmentViews),
      );
    }
    return { runId, sessionId: session.sessionId };
  }

  resume(runId: string): boolean {
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
      constraints: persisted.constraints,
    };
    this.store.updateRun(this.toStoredRun(run));
    this.runs.set(runId, run);
    const originalStart = run.events.find(
      (event) => event.type === 'run_started' && event.attachments?.length,
    );
    this.record(run, {
      type: 'run_started',
      runId,
      timestamp: now,
      ...(originalStart?.type === 'run_started' ? { attachments: originalStart.attachments } : {}),
    });
    this.startAgent(run, checkpoint.task, checkpoint);
    return true;
  }

  // ---- 停止 / 终态 ----

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
    // 终态映射（业务语义归 RunLifecycleService；Store 只负责原子持久化）
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
    // v2.3 Background Job 升级为 Session 级所有权：Run 进入终态不再回收
    // 后台作业——作业随 Session 存在（Session 删除 / Host 关闭时统一清理）。
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

  private failRun(run: InternalRun, message: string): void {
    // v1.6：failed 终态与 run_failed 事件原子落盘（与 completed/stopped 同一管线）
    this.finalizeRun(run, 'failed', { error: message });
  }

  // v1.6：仅发布已在持久层落库的事件（memory + SSE）；durability 优先于 delivery
  private publishEvent(run: InternalRun, event: HostEvent, seq: number): void {
    run.events.push(event);
    // 推流交给 EventStreamService（管理 live sink 生命周期）
    this.events.publish(run.runId, seq, event);
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
    this.events.publish(run.runId, seq, event);
  }

  /** 供组合服务（Approval / Toolchain Coordinator）广播事件的入口。 */
  emitEvent(runId: string, event: HostEvent): void {
    const run = this.runs.get(runId);
    if (run) this.record(run, event);
  }

  private persistRunSafely(run: InternalRun): void {
    try {
      this.store.updateRun(this.toStoredRun(run));
    } catch (err) {
      console.error(`[RunStore] updateRun failed for ${run.runId}: ${(err as Error).message}`);
    }
  }

  // ---- 查询 ----

  get(runId: string): HostRun | null {
    const active = this.runs.get(runId);
    if (active && !this.isSessionDeleted(active.sessionId)) return publicActiveView(active);
    const stored = this.store.getRun(runId);
    return stored && !this.isSessionDeleted(stored.sessionId) ? publicStoredView(stored) : null;
  }

  getRaw(runId: string): InternalRun | undefined {
    return this.runs.get(runId);
  }

  list(): HostRun[] {
    return this.store.listRuns().map((run) => publicStoredView(run));
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

  // ---- 活跃 Run 容器窄访问（SessionServiceHost 由 RunManager 实现）----

  listActiveRuns() {
    return [...this.runs.values()].map((run) => ({
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.status,
      workspaceRoot: run.workspaceRoot,
      workspace: run.workspace,
    }));
  }

  /**
   * 该 Run 的执行链 Promise（不存在/未启动时 undefined）。无人值守 harness
   * （如 tests/swebench）需要等执行链真正 settle 才算「写入已停止」——终态事件
   * 与 checkpoint 都不能证明 Agent 已停止（close 路径允许 cap 后强制收态）。
   * 只读暴露既有内部状态，不改任何行为。
   */
  runExecution(runId: string): Promise<void> | undefined {
    return this.runs.get(runId)?.agentPromise;
  }

  removeActiveRun(runId: string): CleanupError[] {
    this.runs.delete(runId);
    this.events.closeRun(runId);
    return this.cleanupRun(runId);
  }

  renameActiveRunWorkspace(fromName: string, toName: string): void {
    for (const run of this.runs.values()) {
      if (run.workspace?.name === fromName) run.workspace = { name: toName };
    }
  }

  // ---- close() 支撑 ----

  /** 中止所有活跃 Run（cancelled + abort），与 close() 的终态等待解耦。 */
  abortActiveRuns(): void {
    for (const run of this.runs.values()) {
      if (isCancellable(run.status) && run.abortController) {
        run.cancelled = true;
        run.abortController.abort();
      }
    }
  }

  /** 等待所有活跃 Run 进入终态并让执行链 settle（带 cap，防卡死）。 */
  async awaitActiveRunsSettled(): Promise<void> {
    const waitPromises: Promise<void>[] = [];
    for (const run of this.runs.values()) {
      // 等待状态进入终态（超时则强制 finish）
      waitPromises.push(this.waitForRunTerminal(run.runId, 10_000));
      // 等待执行链真正结束（带 cap），确保 Store 关闭前 agent 不再写库
      waitPromises.push(this.waitAgentSettled(run, 2_000));
    }
    await Promise.all(waitPromises);
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

  // ---- 内部支撑 ----

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
      constraints: run.constraints,
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
      const rejectedDraft = run.status !== 'completed' && this.store.listEvents(run.runId)
        .some(({ event }) => event.type === 'llm_call' && event.purpose === 'final_draft');
      if (run.constraints?.evidence || rejectedDraft) {
        messages.push({ role: 'user', content: run.task });
        messages.push({ role: 'assistant', content: run.status === 'completed' && run.result ? run.result : '上一轮交付未通过验证' });
        harnessState = undefined;
        lastCheckpointIndex = index;
        continue;
      }
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
      const started = this.store
        .listEvents(run.runId)
        .map((item) => item.event)
        .find((event) => event.type === 'run_started' && event.attachments?.length);
      const files =
        started?.type === 'run_started' ? asTextAttachmentRefs(started.attachments ?? []) : [];
      messages.push({
        role: 'user',
        content: run.task + attachmentManifest(files),
        ...(files.length ? { textAttachments: files } : {}),
      });
      if (run.status === 'completed' && run.result) {
        messages.push({ role: 'assistant', content: run.result });
      } else {
        messages.push({ role: 'assistant', content: `上一轮未完成（${run.status}）` });
      }
    }
    return { messages, harnessState };
  }

  // ---- 执行 ----

  private startAgent(
    run: InternalRun,
    task: string,
    resume?: Parameters<typeof runAgent>[1],
    conversationHistory: ChatMessage[] = [],
    previousHarnessState?: ContextHarnessState,
    attachments?: MessageImage[],
    textAttachments: TextAttachmentRef[] = [],
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

    // Run 已经持久化为 running，任何启动失败都必须落为 failed + run_failed，
    // 不允许同步 throw 留下永远 running 的僵尸 Run（模型解析失败也走同一条路）。
    run.agentPromise = (async () => {
      let modelConfig: ModelConfig | undefined;
      try {
        modelConfig = this.models.modelConfigForRun(run);
      } catch (err) {
        this.failRun(run, (err as Error).message);
        return;
      }
      try {
        // 恢复当前会话已上传的文本/二进制副本（图片走 content store 之外
        // 的物化路径，不在此列）；不能恢复时让 read/工具调用返回明确错误。
        // 产物按版本刷新：提取逻辑升级后，旧事件里的过期产物（如乱码闸门上线前
        // 落盘的二进制 .txt）在原件恢复后用现行逻辑重提覆盖，避免「代码已修、
        // 旧会话读到的还是旧产物」。失败静默跳过，保留旧产物下轮再试。
        for (const previous of this.store.listRunsBySession(run.sessionId)) {
          for (const { event } of this.store.listEvents(previous.runId)) {
            if (event.type !== 'run_started') continue;
            for (const file of event.attachments ?? []) {
              if (file.kind === 'image' || !file.sha256) continue;
              for (const ref of [file, file.extraction]) {
                if (!ref?.path || !ref.sha256) continue;
                try {
                  restoreAttachment(run.workspaceRoot, ref.path, ref.sha256);
                } catch {
                  /* 清单保留路径，工具读取时报告缺失。 */
                }
              }
              if (file.extraction) {
                try {
                  await refreshExtraction(file, run.workspaceRoot);
                } catch {
                  /* 刷新失败不影响 Run 启动，旧产物保留。 */
                }
              }
            }
          }
        }
        const projectInstructions = readProjectInstructions(run.workspaceRoot, run.permissionMode);
        const skills = scanWorkspaceSkills(run.workspaceRoot, run.permissionMode);
        const executionContext = createAgentExecutionContext({
          runId: run.runId,
          sessionId: run.sessionId,
          workspaceRoot: run.workspaceRoot,
          permissionMode: run.permissionMode,
          writeScope: run.constraints?.writeScope,
          projectInstructions,
        });
        const result = await runAgent(task, resume, {
          executionContext,
          ...createDefaultRuntimeServices(),
          approvalPort: this.approvals.approvalPort(),
          toolchainPreparationPort: this.toolchain.toolchainPreparationPort(),
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
              // 候选功能先走独立真实任务验收，通过后才启用默认行为。
              finalReview: process.env.PAYASO_FINAL_REVIEW === '1',
            });
            harness.setTaskConstraints?.(run.constraints);
            harness.setSkills(skills);
            harness.setTextAttachments(textAttachments);
            return harness;
          })(),
          previousHarnessState,
          signal: abortController.signal,
          onStreamDelta: run.constraints?.evidence ? undefined : queueDelta,
          onTrace: (event) => {
            flushDelta();
            // 证据模式只发布 Host 校验后的答复，原始 JSON 留在私有 checkpoint。
            if (run.constraints?.evidence && event.type === 'final_answer') return;
            this.record(
              run,
              run.constraints?.evidence && event.type === 'llm_call'
                ? { ...event, response: '', reasoning: undefined }
                : event,
            );
          },
        });
        flushDelta();
        // stop() 之后 agent 才正常 resolve 的竞态：用户意图是停止 → stopped
        if (run.cancelled || abortController.signal.aborted) {
          this.finish(run);
          return;
        }
        // v1.6：completed 终态原子落盘（status + run_completed 同一事务）
        const delivered = run.constraints?.evidence
          ? renderEvidence(run.workspaceRoot, run.constraints.evidence, result)
          : result;
        this.finalizeRun(run, 'completed', { result: delivered });
      } catch (err) {
        flushDelta();
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
}
