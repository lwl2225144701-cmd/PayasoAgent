// 模块: RunManager — Host 产品层门面（Facade）
// 职责：组装组合服务（Model / Session / Event / Approval / Toolchain /
// RunLifecycle），保留对外公开 API 与生命周期状态机（open/closing/closed）。
// 边界：每类可变状态有唯一 owner —— 活跃 Run 容器归 RunLifecycleService，
// Session/Workspace 规则归 SessionService；本类只做委托与装配。

import { createDefaultRunStore } from './persistence/sqlite-store.js';
import type { RunStore } from './persistence/store.js';
import {
  getRuntimeToolchainCapabilities,
  type RuntimeToolchainCapabilities,
} from '../sandbox/toolchain-manager.js';
import type {
  ToolchainPreparationPort,
  ToolchainPreparationRunner,
} from '../sandbox/toolchain-preparation.js';
import { prepareMacOSToolchain } from '../sandbox/macos-toolchain-preparer.js';
import type { ApprovalPort } from '../runtime/approval-port.js';
import { ModelService } from './model-service.js';
import { EventStreamService } from './event-stream-service.js';
import { ApprovalCoordinator } from './approval-coordinator.js';
import { ToolchainPreparationCoordinator } from './toolchain-preparation-coordinator.js';
import { SessionService } from './session-service.js';
import { RunLifecycleService, type InternalRun } from './run-lifecycle-service.js';

import { scanPromptCommands } from './prompt-command.js';
export { expandPromptCommand } from './prompt-command.js';
import { getWorkspace } from './workspace.js';
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
} from '../permission-mode.js';
import type {
  CreateModelProviderInput,
  StoredSession,
  UpdateModelProviderInput,
} from './persistence/store.js';
import type {
  CleanupError,
  CreateRunAttachmentInput,
  HostRun,
  HostSession,
  SseSink,
} from './run-types.js';
import type { HostEvent } from './run-events.js';
import type { SessionStats } from './run-stats.js';

export type {
  CleanupError,
  CreateRunAttachmentInput,
  HostRun,
  HostSession,
  SseSink,
} from './run-types.js';
export type { InternalRun } from './run-lifecycle-service.js';

export class RunManager {
  private lifecycle: 'open' | 'closing' | 'closed' = 'open';
  private closePromise?: Promise<void>;

  private readonly store: RunStore;
  private readonly modelService: ModelService;
  private readonly eventStreamService: EventStreamService;
  private readonly sessionService: SessionService;
  private readonly approvalCoordinator: ApprovalCoordinator;
  private readonly toolchainCoordinator: ToolchainPreparationCoordinator;
  private readonly runLifecycle: RunLifecycleService;

  constructor(
    store: RunStore = createDefaultRunStore(),
    private readonly toolchainPreparer: ToolchainPreparationRunner = prepareMacOSToolchain,
    // v1.6 闭环④a：能力快照提供方可注入（测试确定性；生产用真实启动发现）
    private readonly toolchainCapabilitiesProvider: () => RuntimeToolchainCapabilities = getRuntimeToolchainCapabilities,
  ) {
    this.store = store;
    this.modelService = new ModelService({ store });
    this.eventStreamService = new EventStreamService({ store });
    // 组合服务的 emit 回调统一指到 RunLifecycleService 的事件广播入口
    // （活跃 Run 容器归 RunLifecycleService，run 存在性守卫在其内部）。
    // emitRunEvent 在 runLifecycle 创建后赋值（晚绑定间接层，避免循环构造）。
    this.approvalCoordinator = new ApprovalCoordinator({
      emit: (runId, event) => this.emitRunEvent(runId, event),
    });
    this.toolchainCoordinator = new ToolchainPreparationCoordinator({
      emit: (runId, event) => this.emitRunEvent(runId, event),
      preparer: this.toolchainPreparer,
      capabilitiesProvider: this.toolchainCapabilitiesProvider,
    });
    this.sessionService = new SessionService({
      store,
      models: this.modelService,
      host: this,
    });
    this.runLifecycle = new RunLifecycleService({
      store,
      models: this.modelService,
      sessions: this.sessionService,
      approvals: this.approvalCoordinator,
      toolchain: this.toolchainCoordinator,
      events: this.eventStreamService,
    });
    this.emitRunEvent = (runId, event) => this.runLifecycle.emitEvent(runId, event);
  }

  private emitRunEvent: (runId: string, event: HostEvent) => void = () => {};

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
      // 先中止所有活跃 Run，再中止在途工具链准备，最后等待执行链 settle
      this.runLifecycle.abortActiveRuns();
      this.toolchainCoordinator.abortAll();
      await this.runLifecycle.awaitActiveRunsSettled();

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

  // ---- SessionServiceHost：活跃 Run 容器窄访问（归 RunLifecycleService）----

  listActiveRuns() {
    return this.runLifecycle.listActiveRuns();
  }

  removeActiveRun(runId: string): CleanupError[] {
    return this.runLifecycle.removeActiveRun(runId);
  }

  renameActiveRunWorkspace(fromName: string, toName: string): void {
    this.runLifecycle.renameActiveRunWorkspace(fromName, toName);
  }

  // ---- v2.0.1 JIT Approval：Host 注入给 Runtime 的批准端口 ----
  // 规则归 ApprovalCoordinator。
  approvalPort(): ApprovalPort {
    return this.approvalCoordinator.approvalPort();
  }

  resolveApproval(runId: string, requestId: string, approved: boolean): boolean {
    return this.approvalCoordinator.resolve(runId, requestId, approved);
  }

  // ---- macOS Toolchain Preparation：固定白名单 + 用户明确批准 ----
  // 规则归 ToolchainPreparationCoordinator。
  toolchainPreparationPort(): ToolchainPreparationPort {
    return this.toolchainCoordinator.toolchainPreparationPort();
  }

  resolveToolchainPreparation(runId: string, requestId: string, approved: boolean): boolean {
    return this.toolchainCoordinator.resolve(runId, requestId, approved);
  }

  cancelToolchainPreparation(runId: string, requestId: string): boolean {
    return this.toolchainCoordinator.cancel(runId, requestId);
  }

  // ---- Run 生命周期（归 RunLifecycleService）----

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
    return this.runLifecycle.createInSession(task, requestedSessionId, opts);
  }

  resume(runId: string): boolean {
    this.ensureOpen();
    return this.runLifecycle.resume(runId);
  }

  stop(runId: string): boolean {
    return this.runLifecycle.stop(runId);
  }

  get(runId: string): HostRun | null {
    return this.runLifecycle.get(runId);
  }

  getRaw(runId: string): InternalRun | undefined {
    return this.runLifecycle.getRaw(runId);
  }

  list(): HostRun[] {
    return this.runLifecycle.list();
  }

  listRunEvents(runId: string): HostEvent[] | null {
    return this.runLifecycle.listRunEvents(runId);
  }

  getWorkspaceRoot(runId: string): string | null {
    return this.runLifecycle.getWorkspaceRoot(runId);
  }

  // ---- Session / Workspace 委托（组合服务 SessionService；对外 API 不变）----

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

  // ---- Prompt 命令 ----

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

  // ---- SSE 订阅（归 EventStreamService）----

  subscribe(runId: string, sink: SseSink, afterSeq = 0, live = true): boolean {
    return this.eventStreamService.subscribe(runId, sink, afterSeq, live);
  }

  unsubscribe(runId: string, sink: SseSink): void {
    this.eventStreamService.unsubscribe(runId, sink);
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
