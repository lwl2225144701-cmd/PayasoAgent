// 模块: ToolchainPreparationCoordinator —— RunManager 的 macOS 工具链准备组合服务。
//
// 为什么单独存在：工具链准备有真实业务规则（固定白名单、网络能力独立门控、
// 同 package 共享安装合并、批准/拒绝/超时/取消四态决策、能力快照刷新），
// 独立成服务后规则有唯一 owner，RunManager 只保留一行委托。
//
// 边界：只依赖注入的 emit 回调（事件广播）与 preparer/capabilitiesProvider，
// 不反向依赖 RunManager。

import { getNetworkMode } from '../network-mode.js';
import type { RuntimeToolchainCapabilities } from '../sandbox/toolchain-manager.js';
import type {
  ToolchainPreparationObserver,
  ToolchainPreparationPort,
  ToolchainPreparationRequest,
  ToolchainPreparationResult,
  ToolchainPreparationRunner,
} from '../sandbox/toolchain-preparation.js';
import { getToolchainPreparationPlan } from '../sandbox/toolchain-preparation.js';
import type { HostEvent } from './run-events.js';

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

export interface ToolchainPreparationCoordinatorDeps {
  /** 事件广播（SSE + 持久化）；由 RunManager 提供，内部走 record()。 */
  emit: (runId: string, event: HostEvent) => void;
  preparer: ToolchainPreparationRunner;
  capabilitiesProvider: () => RuntimeToolchainCapabilities;
}

export class ToolchainPreparationCoordinator {
  // macOS toolchain preparation requests are separate from network approval.
  // They are user-facing, bounded, and resolve to a fixed installer plan.
  private readonly pending = new Map<string, PendingToolchainPreparation>();
  // v1.6 闭环③：同 packageName 的在途安装合并表 —— 至多一个 brew install，
  // 后来者等待同一 Promise 共享结果，绝不并发安装。
  private readonly activeInstalls = new Map<string, Promise<ToolchainPreparationResult>>();

  private readonly emit: (runId: string, event: HostEvent) => void;
  private readonly preparer: ToolchainPreparationRunner;
  private readonly capabilitiesProvider: () => RuntimeToolchainCapabilities;

  constructor(deps: ToolchainPreparationCoordinatorDeps) {
    this.emit = deps.emit;
    this.preparer = deps.preparer;
    this.capabilitiesProvider = deps.capabilitiesProvider;
  }

  toolchainPreparationPort(): ToolchainPreparationPort {
    return {
      request: (req, signal) => this.request(req, signal),
    };
  }

  resolve(runId: string, requestId: string, approved: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.runId !== runId || pending.state !== 'waiting') return false;
    clearTimeout(pending.timer);
    pending.state = approved ? 'preparing' : 'finishing';
    pending.decide(approved ? 'approved' : 'denied');
    return true;
  }

  cancel(runId: string, requestId: string): boolean {
    const pending = this.pending.get(requestId);
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

  /** close() 时中止所有在途准备：preparing 走 abort，其余按 aborted 收口。 */
  abortAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.state === 'preparing') {
        pending.controller.abort();
      } else {
        pending.decide('aborted');
      }
    }
    this.pending.clear();
  }

  private async request(
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
    const live = this.capabilitiesProvider();
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
    const sharedInstall = this.activeInstalls.get(plan.packageName);
    if (sharedInstall) {
      const result = await this.awaitSharedInstall(sharedInstall, signal);
      const mergedRequestId = crypto.randomUUID();
      this.recordResolved(req.runId, mergedRequestId, result);
      if (result.prepared) {
        result.capabilities = this.capabilitiesProvider();
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
          const pending = this.pending.get(requestId);
          if (!pending || pending.decide !== decide) return;
          if (pending.state === 'waiting') {
            pending.state = value === 'approved' ? 'preparing' : 'finishing';
            if (value !== 'approved') this.pending.delete(requestId);
          }
          clearTimeout(timer);
          if (value !== 'approved') signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => {
          const pending = this.pending.get(requestId);
          if (pending?.state === 'preparing') controller.abort();
          else decide('aborted');
        };
        timer = setTimeout(() => decide('timed_out'), APPROVAL_TIMEOUT_MS);
        timer.unref?.();
        this.pending.set(requestId, {
          runId: req.runId,
          decide,
          timer,
          controller,
          state: 'waiting',
          cancelRequested: false,
        });
        this.emit(req.runId, {
          type: 'toolchain_preparation_requested',
          runId: req.runId,
          requestId,
          toolName: plan.toolName,
          packageName: plan.packageName,
          source: plan.source,
          timestamp: req.timestamp,
        });
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
          this.emit(req.runId, {
            type: 'toolchain_preparation_started',
            runId: req.runId,
            requestId,
            toolName: plan.toolName,
            packageName: plan.packageName,
            source: plan.source,
            phase: 'checking',
            timestamp: new Date().toISOString(),
          });
          const onPhase: ToolchainPreparationObserver = (phase) => {
            this.emit(req.runId, {
              type: 'toolchain_preparation_progress',
              runId: req.runId,
              requestId,
              phase: phase === 'checking' ? 'installing' : phase,
              timestamp: new Date().toISOString(),
            });
          };
          try {
            result = await this.preparer(plan, controller.signal, onPhase);
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
        this.pending.delete(requestId);
        detachSignal();
        this.recordResolved(req.runId, requestId, result);
        if (result.prepared) {
          result.capabilities = this.capabilitiesProvider();
        }
        return result;
      });
    })();

    this.activeInstalls.set(plan.packageName, install);
    // 表项生命周期管理：install 本身从不 reject（内部已兜底），此处的派生
    // Promise 仅用于在结束后清理合并表，不存在 unhandled rejection。
    void install.then(
      () => this.activeInstalls.delete(plan.packageName),
      () => this.activeInstalls.delete(plan.packageName),
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
    if (signal.aborted) return this.abortedResult();
    return Promise.race([
      shared,
      new Promise<ToolchainPreparationResult>((resolve) => {
        signal.addEventListener('abort', () => resolve(this.abortedResult()), {
          once: true,
        });
      }),
    ]);
  }

  private abortedResult(): ToolchainPreparationResult {
    return {
      approved: true,
      prepared: false,
      status: 'aborted',
      message: 'Dependency preparation was cancelled.',
    };
  }

  private recordResolved(
    runId: string,
    requestId: string,
    result: ToolchainPreparationResult,
  ): void {
    this.emit(runId, {
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
}
