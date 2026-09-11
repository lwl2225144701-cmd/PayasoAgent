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
import {
  type ContextHarnessState,
  normalizeContextHarnessState,
} from '../harness/context-state.js';
import type { ChatMessage, ChatStreamDelta, MessageImage, ModelConfig } from '../llm/llm.js';
import { getNetworkMode } from '../network-mode.js';
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  storedPermissionMode,
} from '../permission-mode.js';
import {
  checkpointPath,
  loadCheckpoint,
  saveCheckpoint,
} from '../persistence/file-checkpoint-store.js';
import { AgentStopRequestedError, runAgent } from '../runtime/agent.js';
import type { ApprovalPort, NetworkApprovalRequest } from '../runtime/approval-port.js';
import type { Checkpoint } from '../runtime/checkpoint-port.js';
import { writeAttachmentFile } from '../runtime/image-materialize.js';
import { prepareMacOSToolchain } from '../sandbox/macos-toolchain-preparer.js';
import { getRunWorkspaceRoot } from '../sandbox/sandbox-manager.js';
import {
  getRuntimeToolchainCapabilities,
  type RuntimeToolchainCapabilities,
} from '../sandbox/toolchain-manager.js';
import type {
  ToolchainPreparationObserver,
  ToolchainPreparationPort,
  ToolchainPreparationRequest,
  ToolchainPreparationResult,
  ToolchainPreparationRunner,
} from '../sandbox/toolchain-preparation.js';
import { getToolchainPreparationPlan } from '../sandbox/toolchain-preparation.js';
import { getSchemas } from '../tools/tools.js';
import { isAbortError } from '../util/abort.js';
import { aggregateSessionStats, deriveRunStats, type SessionStats } from './run-stats.js';
import { createZip, type ZipEntry } from './zip.js';
import {
  readProjectInstructions,
  scanWorkspaceSkills,
} from './workspace-instructions.js';
import { disposeRunBackgroundJobs } from '../sandbox/background-jobs.js';
import { ModelService } from './model-service.js';

import { expandPromptCommand, scanPromptCommands, type PromptCommand } from './prompt-command.js';
export { expandPromptCommand } from './prompt-command.js';

import { createDefaultRunStore } from './persistence/sqlite-store.js';
import {
  type CreateModelProviderInput,
  isTerminalRunStatus,
  type ModelProviderView,
  type RunStore,
  type StoredRun,
  type StoredRunStatus,
  type StoredSession,
  type TerminalRunStatus,
  type UpdateModelProviderInput,
} from './persistence/store.js';
import { getPiAiProviderModel } from './pi-ai-providers.js';
import {
  type HostAttachment,
  type HostEvent,
  type StreamingEvent,
  sseEncode,
} from './run-events.js';
import { clearWorkspace, getWorkspace, renameWorkspaceLabel } from './workspace.js';

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

// 附件在工作区内的落盘目录（相对 workspaceRoot）。
const ATTACHMENT_DIR = 'input/attachments';

// v2.0.1 JIT Approval：批准请求等待超时（用户 60s 未裁决 → 拒绝，不无限挂起 Run）
const APPROVAL_TIMEOUT_MS = 60_000;

type ToolchainPreparationDecision = 'approved' | 'denied' | 'aborted' | 'timed_out';
type ToolchainPreparationState = 'waiting' | 'preparing' | 'finishing';

interface PendingToolchainPreparation {
  runId: string;
  decide: (decision: ToolchainPreparationDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
  state: ToolchainPreparationState;
  cancelRequested: boolean;
}

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
  target: 'checkpoint' | 'sandbox';
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
  // Host resource fuse for the unbounded Runtime loop. Keep timeout separate
  // from an explicit user stop so the terminal reason remains observable.
  abortReason?: 'user' | 'timeout';
  runTimeoutTimer?: ReturnType<typeof setTimeout>;
  // v1.6.1：执行链 promise 句柄（fire-and-forget 任务的引用）。
  // close() 用它等待执行链真正结束（而非仅状态变终态），避免 Store 关闭后 agent 仍在写库。
  agentPromise?: Promise<void>;
}

export interface SseSink {
  write: (chunk: string) => void;
  end: () => void;
  closed: () => boolean;
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

// 可取消状态：running（执行中）/ stopping（已请求停止、abort 已发出、执行未退出）
function isCancellable(status: HostRunStatus): boolean {
  return status === 'running' || status === 'stopping';
}

export class RunManager {
  private runs = new Map<string, InternalRun>();
  private subscribers = new Map<string, Set<SseSink>>();
  private lifecycle: 'open' | 'closing' | 'closed' = 'open';
  private closePromise?: Promise<void>;
  // v2.0.1 JIT Approval：in-flight 批准请求（requestId → 裁决入口 + 超时定时器）
  private pendingApprovals = new Map<
    string,
    { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout>; runId: string }
  >();
  // macOS toolchain preparation requests are separate from network approval.
  // They are user-facing, bounded, and resolve to a fixed installer plan.
  private pendingToolchainPreparations = new Map<string, PendingToolchainPreparation>();

  // v1.6 闭环③：同 packageName 的在途安装合并表 —— 至多一个 brew install，
  // 后来者等待同一 Promise 共享结果，绝不并发安装。
  private activeToolchainInstalls = new Map<string, Promise<ToolchainPreparationResult>>();

  constructor(
    private readonly store: RunStore = createDefaultRunStore(),
    private readonly toolchainPreparer: ToolchainPreparationRunner = prepareMacOSToolchain,
    // v1.6 闭环④a：能力快照提供方可注入（测试确定性；生产用真实启动发现）
    private readonly toolchainCapabilitiesProvider: () => RuntimeToolchainCapabilities = getRuntimeToolchainCapabilities,
  ) {
    this.modelService = new ModelService({ store: this.store });
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

  private readonly modelService: ModelService;

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
      for (const pending of this.pendingToolchainPreparations.values()) {
        clearTimeout(pending.timer);
        if (pending.state === 'preparing') {
          pending.controller.abort();
        } else {
          pending.decide('aborted');
        }
      }
      await Promise.all(waitPromises);
      this.pendingToolchainPreparations.clear();

      // 关闭所有 SSE 连接
      for (const sinks of this.subscribers.values()) {
        for (const sink of sinks) {
          try {
            sink.end();
          } catch {
            /* ignore shutdown write failures */
          }
        }
      }
      this.subscribers.clear();

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
        type: 'approval_resolved',
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
          type: 'approval_requested',
          runId,
          requestId,
          toolName: req.toolName,
          args: req.args,
          timestamp: req.timestamp,
        });
      }
    });
  }

  // ---- macOS Toolchain Preparation：固定白名单 + 用户明确批准 ----
  toolchainPreparationPort(): ToolchainPreparationPort {
    return {
      request: (req, signal) => this.requestToolchainPreparation(req, signal),
    };
  }

  resolveToolchainPreparation(runId: string, requestId: string, approved: boolean): boolean {
    const pending = this.pendingToolchainPreparations.get(requestId);
    if (!pending || pending.runId !== runId || pending.state !== 'waiting') return false;
    clearTimeout(pending.timer);
    pending.state = approved ? 'preparing' : 'finishing';
    pending.decide(approved ? 'approved' : 'denied');
    return true;
  }

  cancelToolchainPreparation(runId: string, requestId: string): boolean {
    const pending = this.pendingToolchainPreparations.get(requestId);
    if (
      !pending ||
      pending.runId !== runId ||
      pending.cancelRequested ||
      (pending.state !== 'waiting' && pending.state !== 'preparing')
    )
      return false;
    pending.cancelRequested = true;
    clearTimeout(pending.timer);
    if (pending.state === 'waiting') {
      pending.state = 'finishing';
      pending.decide('aborted');
    } else if (pending.state === 'preparing') {
      pending.controller.abort();
    }
    return true;
  }

  private async requestToolchainPreparation(
    req: ToolchainPreparationRequest,
    signal?: AbortSignal,
  ): Promise<ToolchainPreparationResult> {
    const plan = getToolchainPreparationPlan(req.toolName);
    if (process.platform !== 'darwin') {
      return Promise.resolve({
        approved: false,
        prepared: false,
        status: 'unavailable',
        message: 'Controlled dependency preparation is currently available only on macOS.',
      });
    }
    if (plan === undefined || req.packageName !== plan.packageName || req.source !== plan.source) {
      return Promise.resolve({
        approved: false,
        prepared: false,
        status: 'unavailable',
        message: 'This dependency is not available through the controlled preparation flow.',
      });
    }
    // Host-level package preparation may need to download artifacts. Keep it
    // behind the independent network capability: explicit install approval is
    // not a way to bypass network.mode=off/ask.
    if (getNetworkMode() !== 'on') {
      return Promise.resolve({
        approved: false,
        prepared: false,
        status: 'unavailable',
        message:
          'Network access is not enabled for dependency preparation. Enable it separately and try again.',
      });
    }

    // v1.6 闭环④a：实时快照显示该工具已可用 → 无需任何准备直接返回 prepared
    //（避免陈旧的 per-Run 快照发起注定重复的安装；例如用户在准备期间自行安装）。
    const live = this.toolchainCapabilitiesProvider();
    if (live.tools[plan.toolName]?.status === 'available') {
      return Promise.resolve({
        approved: true,
        prepared: true,
        status: 'prepared' as const,
        capabilities: live,
      });
    }

    // v1.6 闭环③（合并）：同 packageName 已有在途准备（含批准等待）→ 等待同一
    // Promise 并共享结果（拒绝/超时同样共享），绝不并发执行多个 Homebrew 安装。
    // 合并等待者不创建独立批准卡片/超时器；其自身 signal 取消只让该等待者以
    // aborted 退出，不影响共享安装与其他等待者。
    const sharedInstall = this.activeToolchainInstalls.get(plan.packageName);
    if (sharedInstall) {
      const result = await this.awaitSharedInstall(sharedInstall, signal);
      const mergedRequestId = crypto.randomUUID();
      this.recordToolchainResolved(req.runId, mergedRequestId, result);
      if (result.prepared) {
        result.capabilities = this.toolchainCapabilitiesProvider();
      }
      return result;
    }

    // 以下整段（批准等待 + 安装 + resolved 事件）= 该 package 的共享安装 Promise：
    // 合并等待者挂在同一个 Promise 上，保证至多一个在途 Homebrew 安装。
    const install = (async (): Promise<ToolchainPreparationResult> => {
      const requestId = crypto.randomUUID();
      const controller = new AbortController();
      let detachSignal = (): void => {};
      const decision = new Promise<ToolchainPreparationDecision>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const decide = (value: ToolchainPreparationDecision) => {
          const pending = this.pendingToolchainPreparations.get(requestId);
          if (!pending || pending.decide !== decide) return;
          if (pending.state === 'waiting') {
            pending.state = value === 'approved' ? 'preparing' : 'finishing';
            if (value !== 'approved') this.pendingToolchainPreparations.delete(requestId);
          }
          clearTimeout(timer);
          if (value !== 'approved') signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => {
          const pending = this.pendingToolchainPreparations.get(requestId);
          if (pending?.state === 'preparing') controller.abort();
          else decide('aborted');
        };
        timer = setTimeout(() => decide('timed_out'), APPROVAL_TIMEOUT_MS);
        timer.unref?.();
        this.pendingToolchainPreparations.set(requestId, {
          runId: req.runId,
          decide,
          timer,
          controller,
          state: 'waiting',
          cancelRequested: false,
        });
        const run = this.runs.get(req.runId);
        if (run) {
          this.record(run, {
            type: 'toolchain_preparation_requested',
            runId: req.runId,
            requestId,
            toolName: plan.toolName,
            packageName: plan.packageName,
            source: plan.source,
            timestamp: req.timestamp,
          });
        }
        if (signal) {
          detachSignal = () => signal.removeEventListener('abort', onAbort);
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });

      return decision.then(async (value) => {
        let result: ToolchainPreparationResult;
        if (value === 'denied') {
          result = {
            approved: false,
            prepared: false,
            status: 'denied',
            message: 'Dependency preparation was not authorized.',
          };
        } else if (value === 'aborted') {
          result = {
            approved: false,
            prepared: false,
            status: 'aborted',
            message: 'Dependency preparation was cancelled.',
          };
        } else if (value === 'timed_out') {
          result = {
            approved: false,
            prepared: false,
            status: 'timed_out',
            message: 'Dependency preparation approval timed out.',
          };
        } else {
          const run = this.runs.get(req.runId);
          if (run) {
            this.record(run, {
              type: 'toolchain_preparation_started',
              runId: req.runId,
              requestId,
              toolName: plan.toolName,
              packageName: plan.packageName,
              source: plan.source,
              phase: 'checking',
              timestamp: new Date().toISOString(),
            });
          }
          const onPhase: ToolchainPreparationObserver = (phase) => {
            const currentRun = this.runs.get(req.runId);
            if (!currentRun) return;
            this.record(currentRun, {
              type: 'toolchain_preparation_progress',
              runId: req.runId,
              requestId,
              phase: phase === 'checking' ? 'installing' : phase,
              timestamp: new Date().toISOString(),
            });
          };
          try {
            result = await this.toolchainPreparer(plan, controller.signal, onPhase);
          } catch {
            result = {
              approved: true,
              prepared: false,
              status: 'failed',
              message:
                'Dependency preparation failed. Review the host package manager and try again.',
            };
          }
        }
        this.pendingToolchainPreparations.delete(requestId);
        detachSignal();
        this.recordToolchainResolved(req.runId, requestId, result);
        if (result.prepared) {
          result.capabilities = this.toolchainCapabilitiesProvider();
        }
        return result;
      });
    })();

    this.activeToolchainInstalls.set(plan.packageName, install);
    // 表项生命周期管理：install 本身从不 reject（内部已兜底），此处的派生
    // Promise 仅用于在结束后清理合并表，不存在 unhandled rejection。
    void install.then(
      () => this.activeToolchainInstalls.delete(plan.packageName),
      () => this.activeToolchainInstalls.delete(plan.packageName),
    );
    return install;
  }

  // 合并等待者：自身 signal 取消只让当前等待者以 aborted 退出，
  // 不影响共享安装与其他等待者。
  private async awaitSharedInstall(
    shared: Promise<ToolchainPreparationResult>,
    signal?: AbortSignal,
  ): Promise<ToolchainPreparationResult> {
    if (signal === undefined) return shared;
    if (signal.aborted) return this.abortedToolchainPreparation();
    return Promise.race([
      shared,
      new Promise<ToolchainPreparationResult>((resolve) => {
        signal.addEventListener('abort', () => resolve(this.abortedToolchainPreparation()), {
          once: true,
        });
      }),
    ]);
  }

  private abortedToolchainPreparation(): ToolchainPreparationResult {
    return {
      approved: true,
      prepared: false,
      status: 'aborted',
      message: 'Dependency preparation was cancelled.',
    };
  }

  private recordToolchainResolved(
    runId: string,
    requestId: string,
    result: ToolchainPreparationResult,
  ): void {
    const run = this.runs.get(runId);
    if (!run) return;
    this.record(run, {
      type: 'toolchain_preparation_resolved',
      runId,
      requestId,
      approved: result.approved,
      prepared: result.prepared,
      status: result.status,
      ...(result.message === undefined ? {} : { message: result.message }),
      timestamp: new Date().toISOString(),
    });
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
        title: this.sessionTitle(task),
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
    const planMode =
      this.store.getSessionMeta(session.sessionId, RunManager.META_PLAN_MODE) === '1';
    let permissionMode: PermissionMode = opts?.permissionMode ?? DEFAULT_PERMISSION_MODE;
    if (planMode) permissionMode = 'read-only';
    // Prompt 命令展开：/cmd ... → 完整用户消息。未匹配则原样使用。
    const promptCommands = scanPromptCommands(session.workspaceRoot, permissionMode);
    const expandedTask = expandPromptCommand(task, promptCommands) ?? task;
    // Agent 实际收到的任务：plan 指令前缀 + 展开后的任务（run.task 仅作展示）。
    const agentTask = planMode ? `${RunManager.PLAN_DIRECTIVE}\n\n${expandedTask}` : expandedTask;
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
    if (!session) throw new Error('Workspace not found');
    const workspaceRoot = session.workspaceRoot;

    for (const run of this.runs.values()) {
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
      this.runs.delete(run.runId);
      const sinks = this.subscribers.get(run.runId);
      if (sinks) {
        for (const sink of sinks) {
          try {
            sink.end();
          } catch {
            /* ignore shutdown write failures */
          }
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
    if (!session) throw new Error('Session not found');
    if (session.deletedAt) throw new Error('Session already archived');

    const hasRunning = [...this.runs.values()].some(
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
      this.runs.delete(run.runId);
      const sinks = this.subscribers.get(run.runId);
      if (sinks) {
        for (const sink of sinks) {
          try {
            sink.end();
          } catch {
            /* ignore shutdown write failures */
          }
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
    const sinks = this.subscribers.get(run.runId);
    if (!sinks) return;
    const chunk = sseEncode(seq, event);
    for (const sink of sinks) {
      if (!sink.closed()) {
        try {
          sink.write(chunk);
        } catch {
          /* isolate one broken SSE client */
        }
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
    return this.store.listRunsBySession(sessionId).map((run) => this.publicStoredView(run));
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

  // ---- 内置会话命令（/compact /export /feedback /goal /plan）----
  // 全部落在 session_meta KV 上：一次建表支撑多个命令，键由本类统一管理。

  private static readonly META_PLAN_MODE = 'plan_mode';
  private static readonly META_GOAL = 'goal';
  private static readonly META_FEEDBACK_PREFIX = 'feedback:';

  /** /plan 模式注入的任务前缀：只读权限 + 仅产出方案，等用户确认后再实施。 */
  private static readonly PLAN_DIRECTIVE =
    '[Plan 模式] 当前会话处于计划模式：只做调研、分析与方案设计，不要执行任何写入或修改类操作。' +
    '最终输出一份可执行计划（步骤、涉及文件、风险与验证方式），等待用户确认后再实施。';

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
      modelConfig: this.modelService.resolveModelConfig(checkpointSource.providerId, checkpointSource.model),
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
    return this.store.getSessionMeta(sessionId, RunManager.META_GOAL);
  }

  setSessionGoal(sessionId: string, goal: string): boolean {
    if (!this.store.getSession(sessionId)) return false;
    const trimmed = goal.trim();
    if (!trimmed) this.store.deleteSessionMeta(sessionId, RunManager.META_GOAL);
    else this.store.setSessionMeta(sessionId, RunManager.META_GOAL, trimmed);
    return true;
  }

  getSessionPlanMode(sessionId: string): boolean {
    return this.store.getSessionMeta(sessionId, RunManager.META_PLAN_MODE) === '1';
  }

  setSessionPlanMode(sessionId: string, enabled: boolean): boolean {
    if (!this.store.getSession(sessionId)) return false;
    this.store.setSessionMeta(sessionId, RunManager.META_PLAN_MODE, enabled ? '1' : '0');
    return true;
  }

  addSessionFeedback(sessionId: string, comment: string): boolean {
    if (!this.store.getSession(sessionId)) return false;
    const key = `${RunManager.META_FEEDBACK_PREFIX}${Date.now()}`;
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
        data: runs.map((run) => JSON.stringify(this.publicStoredView(run))).join('\n'),
      },
      {
        name: 'meta.json',
        data: JSON.stringify(
          {
            goal: this.store.getSessionMeta(sessionId, RunManager.META_GOAL),
            planMode: this.getSessionPlanMode(sessionId),
            feedback: this.store
              .listSessionMeta(sessionId, RunManager.META_FEEDBACK_PREFIX)
              .map((item) => ({
                at: item.key.slice(RunManager.META_FEEDBACK_PREFIX.length),
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

  get(runId: string): HostRun | null {
    const active = this.runs.get(runId);
    if (active && !this.isSessionDeleted(active.sessionId)) return this.publicView(active);
    const stored = this.store.getRun(runId);
    return stored && !this.isSessionDeleted(stored.sessionId)
      ? this.publicStoredView(stored)
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
    if (!this.store.getRun(runId)) return false;
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
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
    const sinks = this.subscribers.get(run.runId);
    if (!sinks) return;
    const chunk = sseEncode(seq, event);
    for (const sink of sinks) {
      if (!sink.closed()) {
        try {
          sink.write(chunk);
        } catch {
          /* isolate one broken SSE client */
        }
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
    return task.replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名任务';
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
