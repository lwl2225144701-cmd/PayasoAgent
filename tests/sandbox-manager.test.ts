// 模块: SandboxManager 单元测试 — 纯路径安全验证（无 LLM、无 Runtime 依赖，秒级完成）
// 用法: npx tsx tests/sandbox-manager.test.ts   （或 npm run test:sandbox）
// 验收：正常 workspace 路径 → PASS；所有逃逸尝试（../、绝对路径、恶意 runId、symlink）→ BLOCKED

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertInsideWorkspace,
  cleanupWorkspace,
  createWorkspace,
  resolvePath,
} from '../src/sandbox/sandbox-manager.js';

// 用临时目录作为 SANDBOX_ROOT，避免污染项目仓库（模块内为惰性读取，运行期设置生效）
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-sandbox-test-'));
process.env.SANDBOX_ROOT = TEST_ROOT;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    const msg = (err as Error).message;
    failures.push(`${name} — ${msg}`);
    console.log(`  [FAIL] ${name} — ${msg}`);
  }
}

// 必须抛错才通过
function expectThrow(fn: () => unknown): void {
  assert.throws(fn);
}

console.log(`SandboxManager 单元测试（SANDBOX_ROOT=${TEST_ROOT}）\n`);

// ---- 1. 正常路径 ----
test('createWorkspace 创建 input/work/output', () => {
  const root = createWorkspace('run-001');
  for (const sub of ['input', 'work', 'output']) {
    assert.ok(fs.existsSync(path.join(root, sub)), `缺少 ${sub}`);
  }
});

test('createWorkspace 已存在时可安全复用', () => {
  const a = createWorkspace('run-001');
  const b = createWorkspace('run-001');
  assert.equal(a, b);
  assert.ok(fs.existsSync(path.join(b, 'work')));
});

test('resolvePath 正常路径 work/test.txt', () => {
  const root = createWorkspace('run-001');
  const p = resolvePath('run-001', 'work/test.txt');
  assert.ok(p.startsWith(root + path.sep));
  assert.ok(p.endsWith(path.join('work', 'test.txt')));
});

test('assertInsideWorkspace 允许不存在文件（父路径在 sandbox 内）', () => {
  const root = createWorkspace('run-001');
  assert.doesNotThrow(() =>
    assertInsideWorkspace('run-001', path.join(root, 'work', 'not-exist.txt')),
  );
});

// ---- 2. 路径穿越 ----
test('resolvePath 拒绝 ../package.json', () => {
  expectThrow(() => resolvePath('run-001', '../package.json'));
});

test('resolvePath 拒绝 ../../etc/passwd', () => {
  expectThrow(() => resolvePath('run-001', '../../etc/passwd'));
});

test('resolvePath 拒绝深层穿越 work/../../../x', () => {
  expectThrow(() => resolvePath('run-001', 'work/../../../x'));
});

// ---- 3. 绝对路径 ----
test('resolvePath 拒绝 /etc/passwd', () => {
  expectThrow(() => resolvePath('run-001', '/etc/passwd'));
});

// ---- 4. 恶意 runId ----
test('runId 拒绝 ../xxx（create/resolve/cleanup 三处）', () => {
  expectThrow(() => createWorkspace('../xxx'));
  expectThrow(() => resolvePath('../xxx', 'work/a.txt'));
  expectThrow(() => cleanupWorkspace('../xxx'));
});

test('runId 拒绝绝对路径与分隔符', () => {
  expectThrow(() => createWorkspace('/etc'));
  expectThrow(() => createWorkspace('a/b'));
  expectThrow(() => createWorkspace('..\\evil'));
});

// ---- 5. workspace 外路径 ----
test('assertInsideWorkspace 拒绝 workspace 外文件', () => {
  const outside = path.join(TEST_ROOT, '..', 'outside.txt');
  fs.writeFileSync(outside, 'x');
  try {
    expectThrow(() => assertInsideWorkspace('run-001', outside));
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('assertInsideWorkspace 拒绝项目根目录文件（package.json）', () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  expectThrow(() => assertInsideWorkspace('run-001', path.join(projectRoot, 'package.json')));
});

// ---- 6. symlink 逃逸 ----
test('assertInsideWorkspace 拒绝 symlink 指向 workspace 外（目标存在）', () => {
  const root = createWorkspace('run-sym');
  const outside = path.join(TEST_ROOT, '..', 'outside-target.txt');
  fs.writeFileSync(outside, 'secret');
  const link = path.join(root, 'work', 'evil-link');
  fs.symlinkSync(outside, link);
  try {
    const resolved = resolvePath('run-sym', 'work/evil-link');
    expectThrow(() => assertInsideWorkspace('run-sym', resolved));
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('assertInsideWorkspace 拒绝 symlink 父目录逃逸（目标不存在）', () => {
  const root = createWorkspace('run-sym2');
  const outsideDir = path.join(TEST_ROOT, '..', 'outside-dir');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.symlinkSync(outsideDir, path.join(root, 'work', 'linkdir'));
  try {
    const p = path.join(root, 'work', 'linkdir', 'new.txt'); // 文件不存在
    expectThrow(() => assertInsideWorkspace('run-sym2', p));
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('assertInsideWorkspace 拒绝 workspace 根本身是 symlink', () => {
  const realTarget = path.join(TEST_ROOT, 'root-symlink-target');
  const linkedRoot = path.join(TEST_ROOT, 'workspaces', 'root-sym');
  fs.mkdirSync(realTarget, { recursive: true });
  fs.rmSync(linkedRoot, { recursive: true, force: true });
  fs.symlinkSync(realTarget, linkedRoot);
  try {
    expectThrow(() => assertInsideWorkspace('root-sym', path.join(linkedRoot, 'new.txt')));
  } finally {
    fs.rmSync(linkedRoot, { recursive: true, force: true });
    fs.rmSync(realTarget, { recursive: true, force: true });
  }
});

// ---- 7. cleanup ----
test('cleanupWorkspace 只删除当前 runId 工作区', () => {
  createWorkspace('run-clean');
  const keepRoot = createWorkspace('run-keep');
  cleanupWorkspace('run-clean');
  assert.ok(!fs.existsSync(path.join(TEST_ROOT, 'workspaces', 'run-clean')), '被删 run 应不存在');
  assert.ok(fs.existsSync(keepRoot), '其他 run 应保留');
  assert.ok(fs.existsSync(path.join(TEST_ROOT, 'workspaces')), 'workspaces 父目录应保留');
});

test('cleanupWorkspace 后 createWorkspace 可重建', () => {
  createWorkspace('run-rebuild');
  cleanupWorkspace('run-rebuild');
  const root = createWorkspace('run-rebuild');
  assert.ok(fs.existsSync(path.join(root, 'output')));
});

// ---- 汇总 ----
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
console.log(`\n${'='.repeat(56)}`);
console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) {
  failures.forEach((f) => {
    console.log(`  FAIL ${f}`);
  });
  process.exit(1);
}
console.log('验收：正常路径 PASS，所有逃逸尝试 BLOCKED ✓');
