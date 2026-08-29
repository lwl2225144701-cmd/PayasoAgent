// macOS Keychain SecretStore — 通过系统 `security` CLI 读写 generic password。
//
// 安全要求（v1.6 SecretStore）：
// - 只用 spawnSync + 参数数组，禁止 shell 拼字符串（注入/转义/进程泄漏）
// - API Key 不进入日志、异常消息、临时文件
// - service 固定为 "PayasoAgent"，account = secret key，唯一定位一条凭证
// - 错误对外脱敏（"Unable to access the system credential store."），
//   `security` 的原始 stderr 只进本地 console（含退出码，不含密钥）

import { spawnSync } from "node:child_process";
import type { SecretStore } from "./secret-store.js";

const SERVICE = "PayasoAgent";
const SECURITY_CLI = "/usr/bin/security";

// `security` 退出码（部分）：44 = item not found；其余非 0 视为访问/权限失败
const ITEM_NOT_FOUND = 44;

export class MacOSKeychainSecretStore implements SecretStore {
  get(key: string): string | null {
    const result = spawnSync(
      SECURITY_CLI,
      ["find-generic-password", "-s", SERVICE, "-a", key, "-w"],
      { encoding: "utf8" },
    );
    if (result.status === 0) {
      // `-w` 输出值 + 换行；只剥掉结尾单个换行，避免误删密钥本身的尾部字符
      return result.stdout.replace(/\n$/, "");
    }
    if (result.status === ITEM_NOT_FOUND) return null;
    this.fail("access", result.status, result.stderr);
    throw new Error("unreachable"); // fail() 总是抛出
  }

  set(key: string, value: string): void {
    // `-U`：已存在则更新（upsert），set 天然幂等
    const result = spawnSync(
      SECURITY_CLI,
      ["add-generic-password", "-s", SERVICE, "-a", key, "-w", value, "-U"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      this.fail("store", result.status, result.stderr);
    }
  }

  delete(key: string): void {
    const result = spawnSync(
      SECURITY_CLI,
      ["delete-generic-password", "-s", SERVICE, "-a", key],
      { encoding: "utf8" },
    );
    if (result.status !== 0 && result.status !== ITEM_NOT_FOUND) {
      this.fail("delete", result.status, result.stderr);
    }
  }

  // 对外统一脱敏消息；原始 stderr（不含密钥）仅记本地日志供排障
  private fail(operation: "access" | "store" | "delete", status: number | null, stderr: string): never {
    console.error(`[SecretStore] keychain ${operation} failed (exit=${status}): ${String(stderr).slice(0, 200)}`);
    throw new Error("Unable to access the system credential store. Unlock Keychain and try again.");
  }
}
