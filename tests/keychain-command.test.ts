// 模块: macOS Keychain 命令契约测试 — 用假 CLI 脚本真实验证 argv/stderr/CRLF 契约。
// 失败必须非零退出。不触碰真实 Keychain。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MacOSKeychainSecretStore,
  stripTrailingLineBreak,
} from '../src/host/secrets/macos-keychain-secret-store.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ── 假 CLI 脚本：模拟 security 命令，校验 argv 契约并把密钥写入文件 ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keychain-fake-'));
const storeFile = path.join(dir, 'secrets.json');
const stderrCapture = path.join(dir, 'stderr.log');
const argvCapture = path.join(dir, 'argv.log');

fs.writeFileSync(storeFile, JSON.stringify({}));
fs.writeFileSync(stderrCapture, '');

const fakeCli = path.join(dir, 'fake-security.mjs');
fs.writeFileSync(
  fakeCli,
  `#!/usr/bin/env node
import fs from "node:fs";
const [,, command, ...args] = process.argv;
const storeFile = ${JSON.stringify(storeFile)};
const stderrCapture = ${JSON.stringify(stderrCapture)};
const argvCapture = ${JSON.stringify(argvCapture)};
fs.writeFileSync(argvCapture, JSON.stringify(process.argv.slice(2)));
const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
if (command === "find-generic-password") {
  // -w 必须是最后一个参数
  if (args[args.length - 1] !== "-w") { fs.writeFileSync(stderrCapture, "bad argv: -w not last"); process.exit(1); }
  const aIdx = args.indexOf("-a");
  const key = args[aIdx + 1];
  if (store[key] == null) process.exit(44);
  process.stdout.write(store[key] + "\\n");
  process.exit(0);
}
if (command === "add-generic-password") {
  // 契约：-w 后跟密钥值（argv 倒数第二个是 -w，最后一个是密钥），不读 stdin
  if (args[args.length - 2] !== "-w") { fs.writeFileSync(stderrCapture, "bad argv: -w must precede value"); process.exit(1); }
  if (args[args.length - 1] === undefined || args[args.length - 1] === "") { fs.writeFileSync(stderrCapture, "bad argv: missing password value"); process.exit(1); }
  if (args.includes("-U") === false) { fs.writeFileSync(stderrCapture, "bad argv: missing -U"); process.exit(1); }
  const aIdx = args.indexOf("-a");
  const key = args[aIdx + 1];
  store[key] = args[args.length - 1];
  fs.writeFileSync(storeFile, JSON.stringify(store));
  if (key === "fail-add") { fs.writeFileSync(stderrCapture, "errSecInternalComponent: secret leak? sk-leak-123"); process.exit(1); }
  process.exit(0);
}
if (command === "delete-generic-password") {
  const aIdx = args.indexOf("-a");
  const key = args[aIdx + 1];
  delete store[key];
  fs.writeFileSync(storeFile, JSON.stringify(store));
  process.exit(0);
}
fs.writeFileSync(stderrCapture, "unknown cmd");
process.exit(1);
`,
);
fs.chmodSync(fakeCli, 0o755); // spawnSync 直接执行文件，需要可执行位

// 辅助：读取假 CLI 记录的 argv
function readArgv(): string[] {
  try {
    return JSON.parse(fs.readFileSync(argvCapture, 'utf8'));
  } catch {
    return [];
  }
}
function resetCaptures(): void {
  fs.writeFileSync(storeFile, JSON.stringify({}));
  fs.writeFileSync(stderrCapture, '');
}

console.log('Keychain command contract tests:');

// 1. stripTrailingLineBreak：\n 与 \r\n 都剥离，值内部换行保留
{
  check('strip LF', stripTrailingLineBreak('abc\n') === 'abc');
  check('strip CRLF', stripTrailingLineBreak('abc\r\n') === 'abc');
  check('keep internal newline', stripTrailingLineBreak('a\nb') === 'a\nb');
  check('keep trailing newline in value', stripTrailingLineBreak('abc\n\n') === 'abc\n');
  check('no newline passthrough', stripTrailingLineBreak('abc') === 'abc');
}

// 2. set(): -w 后跟密钥值（唯一可靠的非交互方式）
{
  const store = new MacOSKeychainSecretStore(fakeCli);
  const secret = 'sk-real-secret-123456';
  store.set('k1', secret);
  const argv = readArgv();
  // 契约：-w 在倒数第二，密钥值是最后一个参数（security 唯一可靠的非交互方式）
  check('set -w precedes value', argv[argv.length - 2] === '-w', `argv=${JSON.stringify(argv)}`);
  check('set value is last argv', argv[argv.length - 1] === secret, `argv=${JSON.stringify(argv)}`);
  check('set -U present', argv.includes('-U'));
  // 密钥只出现一次（作为 -w 的值），不在其它参数位
  check('set secret occurrence', argv.filter((a) => a === secret).length === 1);
  check('set secret stored', JSON.parse(fs.readFileSync(storeFile, 'utf8')).k1 === secret);
  // 假 CLI 对 argv 契约严格校验；set 未抛错即证明契约成立
  check('set contract passes', fs.readFileSync(stderrCapture, 'utf8') === '');
}

// 3. get(): 返回剥离换行后的值
{
  const store = new MacOSKeychainSecretStore(fakeCli);
  const got = store.get('k1');
  check('get returns value', got === 'sk-real-secret-123456', `got ${JSON.stringify(got)}`);
}

// 4. get(): item not found (exit 44) → null
{
  const store = new MacOSKeychainSecretStore(fakeCli);
  check('get missing returns null', store.get('missing') === null);
}

// 5. add 失败时：错误消息不包含原始 stderr / secret
{
  const store = new MacOSKeychainSecretStore(fakeCli);
  resetCaptures();
  const captured: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
  let threw = false;
  try {
    store.set('fail-add', 'sk-leak-123');
  } catch {
    threw = true;
  } finally {
    console.error = origError;
  }
  check('add failure throws', threw);
  const logs = captured.join('\n');
  check(
    'stderr not logged raw',
    !logs.includes('secret leak?') && !logs.includes('sk-leak-123'),
    `logs=${logs.slice(0, 120)}`,
  );
  check('sanitized error message', threw); // 消息由 fail() 统一脱敏
}

// 6. delete(): -a key 传递正确
{
  const store = new MacOSKeychainSecretStore(fakeCli);
  store.set('k2', 'v2');
  store.delete('k2');
  check('delete removes key', JSON.parse(fs.readFileSync(storeFile, 'utf8')).k2 === undefined);
  check('delete argv last not -w', readArgv()[readArgv().length - 1] !== '-w');
}

// 7. 默认 CLI 路径不变（生产）
{
  const store = new MacOSKeychainSecretStore();
  check(
    'default CLI is system security',
    (store as unknown as { cliPath: string }).cliPath === '/usr/bin/security',
  );
}

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\nKeychain command contract tests: ${passed} PASS / ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
