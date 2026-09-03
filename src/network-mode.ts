// 全局网络模式（v2.0 Network Control）
//
// 设计边界：
// - network.mode 是 Global Runtime 配置（默认 on = 默认允许联网），由 Host/测试注入，
//   不是 per-Run 的 LLM 可控制输入 —— 与 permissionMode 同一注入模型。
// - Tool 是否具备网络能力由 Tool 注册时 capabilities.network 显式声明（tools.ts），
//   Runtime 不猜测、不分析具体命令（curl/wget/git 全部不做字符串识别）。
// - on/off 之外的模式：ask = 网络工具执行前必须经 ApprovalPort 即时授权（JIT）。
//   allowlist / domain policy 留给后续版本。

export const NETWORK_MODES = ["on", "off", "ask"] as const;

export type NetworkMode = (typeof NETWORK_MODES)[number];

// v2.0 决策：默认允许联网（作为 Network Control 第一版的目标就是反转
// 原 v1.6 shell 固定 deny 网络的默认值 —— 联网可审计、可全局关闭）。
export const DEFAULT_NETWORK_MODE: NetworkMode = "on";

export function isNetworkMode(value: unknown): value is NetworkMode {
  return typeof value === "string" && NETWORK_MODES.includes(value as NetworkMode);
}

// 回退语义：未知/缺省 → 默认 on（尽量不阻塞工具执行；显式 off/ask 才收紧）
export function storedNetworkMode(value: unknown): NetworkMode {
  return isNetworkMode(value) ? value : DEFAULT_NETWORK_MODE;
}

// ---- 全局可写状态（单进程内,Host/测试设置,默认 on）----
let currentNetworkMode: NetworkMode = DEFAULT_NETWORK_MODE;

/** 读取当前全局网络模式。 */
export function getNetworkMode(): NetworkMode {
  return currentNetworkMode;
}

/** 设置全局网络模式（幂等;非法值拒绝并抛错）。 */
export function setNetworkMode(mode: NetworkMode): void {
  if (!isNetworkMode(mode)) {
    throw new Error(`非法网络模式: ${JSON.stringify(mode)}（允许 on/off/ask）`);
  }
  currentNetworkMode = mode;
}