// 模块: Approval Port — 网络访问的即时授权（JIT Approval / "ask" 模式）
//
// 边界：
// - Runtime 只定义"请求授权"的抽象与 fail-closed 语义，不包含任何 UI/超时策略；
//   Host（CLI / Web）负责注入真实实现（弹窗/TTY），并决定批准超时。
// - 请求中只带最小必要信息（runId/toolName/args），凭证、workspace 路径等
//   内部细节不进入批准请求。
// - 默认实现 = 拒绝（denyAll）：未注入端口时，ask 模式退化为拒绝，绝不自动放行。

// 一次网络访问的授权请求（LLM 不可见；由 Runtime 在执行前构造）
export interface NetworkApprovalRequest {
  runId: string;
  toolName: string;
  args: Record<string, unknown>;
  // 请求发起时间（ISO），供 Host 展示/超时参考
  timestamp: string;
}

// Host 注入的授权通道：resolve(true) = 批准，resolve(false) = 拒绝。
// 超时语义由实现方负责（如 30s 无回应视为拒绝）；Runtime 不等待无限。
export interface ApprovalPort {
  request(req: NetworkApprovalRequest): Promise<boolean>;
}

// fail-closed 默认：无端口时一律拒绝（不自动放行任何网络访问）
export const denyAllApprovalPort: ApprovalPort = {
  async request() {
    return false;
  },
};

// 便捷工具：undefined → denyAll（保证调用方永远拿到一个可用的端口）
export function resolveApprovalPort(port?: ApprovalPort): ApprovalPort {
  return port ?? denyAllApprovalPort;
}
