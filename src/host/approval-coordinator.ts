// 模块: ApprovalCoordinator —— RunManager 的 JIT 网络审批组合服务。
//
// 为什么单独存在：网络审批有真实业务规则（fail-closed 超时拒绝、requestId
// 归属校验、裁决审计事件），独立成服务后规则有唯一 owner，RunManager 只保留
// 一行委托。
//
// 边界：只依赖注入的 emit 回调（事件广播），不反向依赖 RunManager。

import type { ApprovalPort, NetworkApprovalRequest } from '../runtime/approval-port.js';
import type { HostEvent } from './run-events.js';

// v2.0.1 JIT Approval：批准请求等待超时（用户 60s 未裁决 → 拒绝，不无限挂起 Run）
const APPROVAL_TIMEOUT_MS = 60_000;

interface PendingApproval {
  runId: string;
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ApprovalCoordinatorDeps {
  /** 事件广播（SSE + 持久化）；由 RunManager 提供，内部走 record()。 */
  emit: (runId: string, event: HostEvent) => void;
}

export class ApprovalCoordinator {
  // v2.0.1 JIT Approval：in-flight 批准请求（requestId → 裁决入口 + 超时定时器）
  private readonly pending = new Map<string, PendingApproval>();
  private readonly emit: (runId: string, event: HostEvent) => void;

  constructor(deps: ApprovalCoordinatorDeps) {
    this.emit = deps.emit;
  }

  /** Host 注入给 Runtime 的批准端口。 */
  approvalPort(): ApprovalPort {
    return {
      request: (req: NetworkApprovalRequest) => this.request(req),
    };
  }

  /** 关闭时清理所有在途批准请求（不再触发任何 resolve）。 */
  abortAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();
  }

  /**
   * 裁决入口：由 HTTP 端点（POST /runs/:id/approval）回传结果。
   * 广播裁决事件（审计）。
   */
  resolve(runId: string, requestId: string, approved: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    if (pending.runId !== runId) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(approved);
    this.emit(runId, {
      type: 'approval_resolved',
      runId,
      requestId,
      approved,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  private request(req: NetworkApprovalRequest): Promise<boolean> {
    const runId = req.runId;
    const requestId = crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // 超时未裁决 → 自动拒绝（fail-closed）
        if (this.pending.delete(requestId)) {
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { runId, resolve, timer });
      // 推给前端（不持久化：批准请求是瞬态 UI 交互，重放无意义；拒绝后 Run 自会恢复）
      this.emit(runId, {
        type: 'approval_requested',
        runId,
        requestId,
        toolName: req.toolName,
        args: req.args,
        timestamp: req.timestamp,
      });
    });
  }
}