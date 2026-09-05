// 跨平台兜底 SecretStore — AES-256-GCM 加密文件存储（非 macOS 平台）。
//
// 背景（v1.6 审计后）：macOS 用系统 Keychain（security CLI）存放 Provider 凭证；
// 其他平台原实现直接返回 UnsupportedSecretStore（保存即 400），把整个"添加自定义提供方"
// 功能在 Windows/Linux 上废掉了。本实现给非 macOS 平台一个同等级安全边界的存储：
//
// 安全要求（与 Keychain 实现对齐）：
// - 绝不落明文：每个 secret 用 AES-256-GCM 认证加密后落盘（IV + AuthTag + Ciphertext）
// - 密钥与密文分离：16 字节机器密钥存 <dir>/key.bin（0600），密文存 <dir>/secrets/<sha256(key)>.bin
// - API Key 不进入日志、异常消息、临时文件、HTTP 响应、SQLite
// - 失败对外脱敏（"Unable to read provider credential"），不泄露内部细节
// - 原子写入（tmp + rename），避免进程中断产生半文件
//
// 位置：默认 ~/.payaso-agent/（可被 PAYASO_SECRET_DIR 覆盖，测试用临时目录）。
// 权限：目录 0700，密钥/密文文件 0600。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SecretStore } from './secret-store.js';

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM 推荐 96-bit
const TAG_BYTES = 16; // GCM auth tag
const KEY_FILE = 'key.bin';
const SECRETS_DIR = 'secrets';

export function defaultEncryptedSecretDir(): string {
  const env = process.env.PAYASO_SECRET_DIR;
  if (env) return path.resolve(env);
  return path.join(os.homedir(), '.payaso-agent');
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function atomicWrite(target: string, data: Buffer, mode: number): void {
  const tmp = `${target}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 忽略清理失败 */
    }
    throw err;
  }
}

export class EncryptedFileSecretStore implements SecretStore {
  constructor(private readonly dir: string = defaultEncryptedSecretDir()) {}

  private keyPath(): string {
    return path.join(this.dir, KEY_FILE);
  }

  private secretPath(secretKey: string): string {
    return path.join(this.dir, SECRETS_DIR, `${sha256Hex(secretKey)}.bin`);
  }

  // 读取机器密钥；不存在时生成并原子落盘（0600）。
  // 密钥文件损坏（长度错误）→ 抛错；此时所有密文不可解，属 fail-closed。
  private readOrCreateKey(): Buffer {
    const keyPath = this.keyPath();
    try {
      const key = fs.readFileSync(keyPath);
      if (key.length !== KEY_BYTES) {
        throw new Error(
          `[SecretStore] encryption key corrupted (length=${key.length}, expected=${KEY_BYTES})`,
        );
      }
      return key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const key = crypto.randomBytes(KEY_BYTES);
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      atomicWrite(keyPath, key, 0o600);
      return key;
    }
  }

  get(key: string): string | null {
    const file = this.secretPath(key);
    if (!fs.existsSync(file)) return null;
    const blob = fs.readFileSync(file);
    if (blob.length < IV_BYTES + TAG_BYTES) {
      throw new Error('Unable to read provider credential (corrupted entry).');
    }
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
    const cryptoKey = this.readOrCreateKey();
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', cryptoKey, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plain.toString('utf8');
    } catch {
      // 密钥文件被替换 / 密文被篡改 / IV 或 tag 损坏 → 认证失败（GCM 保证）
      throw new Error('Unable to read provider credential (corrupted or wrong encryption key).');
    }
  }

  set(key: string, value: string): void {
    const cryptoKey = this.readOrCreateKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', cryptoKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    const file = this.secretPath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWrite(file, blob, 0o600);
  }

  delete(key: string): void {
    // 不存在视为成功（幂等）
    fs.rmSync(this.secretPath(key), { force: true });
  }
}
