// 模块: SecretStore — Provider 凭证的唯一持久化位置（v1.6 SecretStore）
//
// 安全边界：
// - SQLite（settings blob）只存 provider metadata：baseUrl / models / hasApiKey；
//   raw apiKey 永不入库、永不进入 HTTP 响应、trace、日志。
// - Secret key 由 providerId 确定性派生（provider 改名不影响；providerId 不可变）。
// - 同步 API：与 node:sqlite / SettingsStore 的同步风格一致。Keychain 调用频率低
//   （保存/清除/每次 Run 启动读取一次），spawnSync 的几十毫秒延迟可接受。
//
// 平台：macOS 用系统 Keychain（security CLI）；其他平台用 AES-256-GCM 加密文件兜底
// （EncryptedFileSecretStore，密钥/密文分离、0600 权限、绝不落明文），保证
// "添加自定义提供方"在 Windows/Linux 上同样可用，同时不弱化凭证安全边界。
// UnsupportedSecretStore 保留为显式禁用实现（测试/特殊用途），不再作为默认路由。
// 测试用 MemorySecretStore。

import { EncryptedFileSecretStore } from './encrypted-file-secret-store.js';
import { MacOSKeychainSecretStore } from './macos-keychain-secret-store.js';
import { MemorySecretStore, UnsupportedSecretStore } from './memory-secret-store.js';

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
  if (process.platform === 'darwin') return new MacOSKeychainSecretStore();
  // 非 macOS（Windows/Linux/其他）：加密文件兜底，不再直接禁用
  return new EncryptedFileSecretStore();
}

export {
  EncryptedFileSecretStore,
  MacOSKeychainSecretStore,
  MemorySecretStore,
  UnsupportedSecretStore,
};
