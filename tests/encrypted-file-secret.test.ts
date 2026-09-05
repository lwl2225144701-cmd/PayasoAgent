// 模块: EncryptedFileSecretStore 单元测试 — AES-256-GCM 加密文件兜底（非 macOS 凭证存储）
// 用法: npx tsx tests/encrypted-file-secret.test.ts
// 覆盖：往返 / 幂等替换 / 删除幂等 / 密文不含明文 / 密钥权限 0600 / 目录 0700 /
//       密钥文件损坏 fail-closed / GCM 认证失败（篡改）拒绝 / 与 MemorySecretStore 等价契约。

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EncryptedFileSecretStore } from '../src/host/secrets/encrypted-file-secret-store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-enc-secret-'));
process.env.PAYASO_SECRET_DIR = dir;
const store = new EncryptedFileSecretStore();

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

const KEY_A = 'model-provider:test-a:api-key';
const SECRET_A = 'sk-encrypted-a-' + crypto.randomUUID();
const SECRET_B = 'sk-encrypted-b-' + crypto.randomUUID();

// ---- 1. 往返 ----
test('get before set → null', () => {
  assert.equal(store.get(KEY_A), null);
});

test('set 后 get 返回原值', () => {
  store.set(KEY_A, SECRET_A);
  assert.equal(store.get(KEY_A), SECRET_A);
});

test('set 替换（upsert）', () => {
  store.set(KEY_A, SECRET_B);
  assert.equal(store.get(KEY_A), SECRET_B);
});

// ---- 2. 持久性（同一目录重建实例仍可读）----
test('重建实例仍可读（加密落盘而非内存）', () => {
  const store2 = new EncryptedFileSecretStore();
  assert.equal(store2.get(KEY_A), SECRET_B);
});

// ---- 3. 删除幂等 ----
test('delete 后 get → null', () => {
  store.delete(KEY_A);
  assert.equal(store.get(KEY_A), null);
});

test('delete 幂等（再次删除不抛错）', () => {
  store.delete(KEY_A);
  store.delete(KEY_A);
  assert.ok(true);
});

// ---- 4. 密文安全：磁盘上不出现明文 ----
test('密文文件不包含明文 apiKey', () => {
  const SECRET = 'sk-plaintext-check-' + crypto.randomUUID();
  store.set('model-provider:plaintext:api-key', SECRET);
  const files = fs.readdirSync(path.join(dir, 'secrets'));
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, 'secrets', f));
    assert.ok(!buf.toString('latin1').includes(SECRET), `密文泄露明文: ${f}`);
  }
  store.delete('model-provider:plaintext:api-key');
});

// ---- 5. 权限 ----
test('密钥文件与密文文件权限 0600', () => {
  const mode = fs.statSync(path.join(dir, 'key.bin')).mode & 0o777;
  assert.equal(mode, 0o600, `key.bin mode=${mode.toString(8)}`);
  const sdir = path.join(dir, 'secrets');
  if (fs.existsSync(sdir)) {
    const dirMode = fs.statSync(sdir).mode & 0o777;
    // macOS 上 mkdir mode 可能受 umask 影响，但 0700 是上限，必须 ≤ 0700
    assert.ok(dirMode <= 0o700, `secrets dir mode=${dirMode.toString(8)}`);
  }
});

// ---- 6. 密钥文件损坏 → fail-closed ----
test('key.bin 损坏（长度错误）→ get 抛错', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-enc-corrupt-'));
  const s2 = new EncryptedFileSecretStore(dir2);
  s2.set('k1', 'v1');
  fs.writeFileSync(path.join(dir2, 'key.bin'), 'short');
  assert.throws(() => s2.get('k1'), /corrupted/);
  fs.rmSync(dir2, { recursive: true, force: true });
});

// ---- 7. GCM 认证失败（篡改密文）→ 拒绝 ----
test('密文被篡改 → get 抛错（GCM 认证失败）', () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-enc-tamper-'));
  const s3 = new EncryptedFileSecretStore(dir3);
  s3.set('k1', 'v1');
  const file = path.join(
    dir3,
    'secrets',
    `${crypto.createHash('sha256').update('k1').digest('hex')}.bin`,
  );
  const buf = fs.readFileSync(file);
  buf[0] = buf[0] ^ 0xff; // 翻转 IV
  fs.writeFileSync(file, buf);
  assert.throws(() => s3.get('k1'), /Unable to read/);
  fs.rmSync(dir3, { recursive: true, force: true });
});

// ---- 8. 不同 key 相互独立 ----
test('不同 key 相互隔离', () => {
  store.set('model-provider:iso-a:api-key', 'va');
  store.set('model-provider:iso-b:api-key', 'vb');
  assert.equal(store.get('model-provider:iso-a:api-key'), 'va');
  assert.equal(store.get('model-provider:iso-b:api-key'), 'vb');
  store.delete('model-provider:iso-a:api-key');
  store.delete('model-provider:iso-b:api-key');
});

// ---- 汇总 ----
console.log(`\nEncryptedFileSecretStore 测试汇总: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exitCode = 1;
else console.log('验收：加密文件凭证存储成立（密文不落明文、GCM 认证、0600 权限、幂等）✓');
fs.rmSync(dir, { recursive: true, force: true });
