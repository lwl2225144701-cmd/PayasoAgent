// MemorySecretStore：仅测试 / 依赖注入使用，不做任何持久化。
// UnsupportedSecretStore：非 macOS 平台的明确失败实现 —— 绝不静默回退明文存储。

import type { SecretStore } from "./secret-store.js";

export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();

  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

export class UnsupportedSecretStore implements SecretStore {
  get(_key: string): string | null {
    // 无凭证可读 → 调用方（RunManager）得到 null 后 fail-closed，
    // 错误路径清晰（"credentials unavailable"），不伪造成功也不崩溃整个 Host。
    return null;
  }

  set(_key: string, _value: string): void {
    throw new Error("System credential store is not supported on this platform; cannot store provider credentials.");
  }

  delete(_key: string): void {
    throw new Error("System credential store is not supported on this platform.");
  }
}
