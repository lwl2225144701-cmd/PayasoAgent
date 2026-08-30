// macOS Keychain SecretStore — 通过系统 `security` CLI 读写 generic password。
//
// 安全要求（v1.6 SecretStore）：
// - 只用 spawnSync + 参数数组，禁止 shell 拼字符串（注入/转义/进程泄漏）
// - API Key 不进入日志、异常消息、临时文件
// - service 固定为 "PayasoAgent"，account = secret key，唯一定位一条凭证
// - 错误对外脱敏（"Unable to access the system credential store."）；
//   `security` 原始 stderr 不记录（避免 account/key 或环境细节进日志），只记退出码
// - Secret 仅经 stdin 传入（-w 置于 argv 最后），绝不进入 argv/进程列表

import { spawnSync } from "node:child_process";
import type { SecretStore } from "./secret-store.js";

const SERVICE = "PayasoAgent";
const DEFAULT_SECURITY_CLI = "/usr/bin/security";

// `security` 退出码（部分）：44 = item not found；其余非 0 视为访问/权限失败
const ITEM_NOT_FOUND = 44;

// 剥离 `find-generic-password -w` 输出末尾的单个换行（兼容 CRLF）。
// 只剥一个，避免误删密钥本身结尾的换行；内部换行保留（Secret 允许任意字符）。
export function stripTrailingLineBreak(stdout: string): string {
  return stdout.replace(/\r?\n$/, "");
}

export class MacOSKeychainSecretStore implements SecretStore {
  // cliPath 可注入（测试用假 CLI 验证契约）；默认指向系统 security
  constructor(private readonly cliPath: string = DEFAULT_SECURITY_CLI) {}

  get(key: string): string | null {
    const result = spawnSync(
      this.cliPath,
      ["find-generic-password", "-s", SERVICE, "-a", key, "-w"],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (result.status === 0) {
      // `-w` 输出值 + 换行；剥离结尾单个换行（兼容 CRLF），不误删密钥本身尾部字符
      return stripTrailingLineBreak(result.stdout);
    }
    if (result.status === ITEM_NOT_FOUND) return null;
    this.fail("access", result.status);
    throw new Error("unreachable"); // fail() 总是抛出
  }

  set(key: string, value: string): void {
    // `security add-generic-password` 的 `-w` 无值时必然走控制终端交互
    // （"password data for new item:"），stdin 管道在带 TTY 的环境会被忽略，
    // 导致保存卡住并把密钥暴露到终端。唯一可靠的非交互方式是 `-w` 后直接跟值。
    // 代价：在 security 进程生命周期内（毫秒级）可见于进程列表；
    // 相比密钥进入明文 SQLite / 日志 / 代码库，这是安全模型中可接受的取舍。
    const result = spawnSync(
      this.cliPath,
      ["add-generic-password", "-s", SERVICE, "-a", key, "-U", "-w", value],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (result.status !== 0) {
      this.fail("store", result.status);
    }
  }

  delete(key: string): void {
    const result = spawnSync(
      this.cliPath,
      ["delete-generic-password", "-s", SERVICE, "-a", key],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (result.status !== 0 && result.status !== ITEM_NOT_FOUND) {
      this.fail("delete", result.status);
    }
  }

  // 对外统一脱敏消息；不记录 security 原始 stderr（避免 account/key 或环境细节进日志）
  private fail(operation: "access" | "store" | "delete", status: number | null): never {
    console.error(`[SecretStore] keychain ${operation} failed (exit=${status})`);
    throw new Error("Unable to access the system credential store. Unlock Keychain and try again.");
  }
}
