// macOS Keychain SecretStore 集成测试 — 单独运行（不进 run-all，避免常规
// 测试轮询触碰用户钥匙串）：npx tsx tests/keychain.test.ts
// 使用随机 account（payaso-agent-test-<uuid>），测试结束清理；security CLI
// 不可用时如实 SKIP。MemorySecretStore 的确定性单元测试在 settings 套件中，
// 始终执行、不依赖本测试。

import { spawnSync } from 'node:child_process';
import { MacOSKeychainSecretStore } from '../src/host/secrets/macos-keychain-secret-store.js';

let passed = 0,
  failed = 0,
  skipped = false;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const probe = spawnSync('/usr/bin/security', ['help'], { encoding: 'utf8' });
if (process.platform !== 'darwin' || probe.error || probe.status !== 0) {
  console.log('  [SKIP] security CLI unavailable — Keychain integration test skipped');
  process.exit(0);
}

const store = new MacOSKeychainSecretStore();
// 随机 account：绝不触碰正式的 model-provider:* 条目；finally 清理
const account = `payaso-agent-test-${crypto.randomUUID()}`;
const SECRET_A = `sk-keychain-integration-a-${crypto.randomUUID()}`;
const SECRET_B = `sk-keychain-integration-b-${crypto.randomUUID()}`;

try {
  check('get before set → null', store.get(account) === null);

  store.set(account, SECRET_A);
  check('get after set → value', store.get(account) === SECRET_A);

  store.set(account, SECRET_B); // upsert（-U）幂等替换
  check('set again replaces value', store.get(account) === SECRET_B);

  store.delete(account);
  check('get after delete → null', store.get(account) === null);

  store.delete(account); // 幂等：再次删除不抛错
  check('delete is idempotent', true);
} finally {
  try {
    store.delete(account);
  } catch {
    /* best effort cleanup */
  }
}

console.log(
  `\nKeychain integration tests: ${passed} PASS / ${failed} FAIL${skipped ? ' (skipped)' : ''}`,
);
if (failed) process.exit(1);
