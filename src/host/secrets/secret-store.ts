// 模块: SecretStore — Provider 凭证的唯一持久化位置（v1.6 SecretStore）
//
// 安全边界：
// - SQLite（settings blob）只存 provider metadata：baseUrl / models / hasApiKey；
//   raw apiKey 永不入库、永不进入 HTTP 响应、trace、日志。
// - Secret key 由 providerId 确定性派生（provider 改名不影响；providerId 不可变）。
// - 同步 API：与 node:sqlite / SettingsStore 的同步风格一致。Keychain 调用频率低
//   （保存/清除/每次 Run 启动读取一次），spawnSync 的几十毫秒延迟可接受。
//
// 平台：macOS 用 Keychain（security CLI）；其他平台返回 UnsupportedSecretStore
// （明确报错，不静默回退明文）。测试用 MemorySecretStore。

import { MacOSKeychainSecretStore } from "./macos-keychain-secret-store.js";
import { MemorySecretStore, UnsupportedSecretStore } from "./memory-secret-store.js";

export interface SecretStore {
  /** 读取 secret；不存在返回 null。Keychain 不可访问时抛出脱敏错误。 */
  get(key: string): string | null;
  /** 写入/替换 secret（幂等）。失败时抛出，调用方必须假设 secret 未写入。 */
  set(key: string, value: string): void;
  /** 删除 secret；不存在视为成功（幂等）。 */
  delete(key: string): void;
}

// Secret key：稳定引用，不使用 API Key 本身或 display name 做标识
export function providerSecretKey(providerId: string): string {
  return `model-provider:${providerId}:api-key`;
}

// 组合根（src/host/index.ts）调用一次并注入；测试替换为 MemorySecretStore
export function createSecretStore(): SecretStore {
  if (process.platform === "darwin") return new MacOSKeychainSecretStore();
  return new UnsupportedSecretStore();
}

export { MacOSKeychainSecretStore, MemorySecretStore, UnsupportedSecretStore };
