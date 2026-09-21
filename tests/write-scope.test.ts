// 文件范围硬约束验收（quality-hard-boundaries-plan 步骤 2）
// 用法: npx tsx tests/write-scope.test.ts
// 覆盖：
//   1. scopedPath / assertWriteScope 单元行为（绝对路径、..、软链接、父目录）
//   2. 工具层：write/edit/deleteFile 越界拒绝；受限任务禁止 createDir；空范围全禁
//   3. Shell 绕过攻击（macOS，以磁盘为准）：重定向、子进程、node 内联、软链接逃逸
//      —— 受限任务 Shell 强制只读，验收不看模型是否听话，只看磁盘未被修改。
//      受管 scratch（HOME/TMPDIR）仍可写，属方案允许的缓存目录。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupWorkspace, createWorkspace } from '../src/sandbox/sandbox-manager.js';
import { assertWriteScope, scopedPath } from '../src/sandbox/write-scope.js';
import {
  execute as executeRaw,
  normalizeToolResult,
  type ToolContext,
  type ToolSandboxEvent,
} from '../src/tools/tools.js';

async function execute(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  return normalizeToolResult(await executeRaw(name, args, context)).text;
}

import '../src/tools/filesystem.js';
import '../src/tools/runtime-tools.js';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-write-scope-'));
process.env.SANDBOX_ROOT = TEST_ROOT;
const RUN = 'write-scope-test';
const root = createWorkspace(RUN);
const work = path.join(root, 'work');
const outside = path.join(TEST_ROOT, 'outside.txt');
fs.writeFileSync(outside, 'keep', 'utf8');

// 预置：允许范围内的文件 + 范围外的文件 + 指向范围外的软链接
fs.writeFileSync(path.join(work, 'allowed.txt'), 'original', 'utf8');
fs.writeFileSync(path.join(work, 'forbidden.txt'), 'keep', 'utf8');
fs.symlinkSync(outside, path.join(work, 'evil-link'));
fs.writeFileSync(path.join(root, 'output', 'forbidden.txt'), 'keep', 'utf8');

const SCOPE = ['work/allowed.txt'];
const scopedCtx: ToolContext = {
  runId: RUN,
  workspaceRoot: root,
  permissionMode: 'workspace-write',
  writeScope: SCOPE,
};
const unscopedCtx: ToolContext = {
  runId: RUN,
  workspaceRoot: root,
  permissionMode: 'workspace-write',
};

interface Case {
  name: string;
  fn: () => void | Promise<void>;
}
const tests: Case[] = [];
let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

function assertRejected(err: unknown): boolean {
  assert.ok(err instanceof Error, '期望被拒绝，实际成功');
  assert.match(err.message, /范围|不允许|拒绝/);
  return true;
}

// ---- 1. scopedPath / assertWriteScope 单元行为 ----
test('scopedPath：拒绝绝对路径、反斜杠、..、.、空段、控制字符', () => {
  for (const bad of [
    '/etc/passwd',
    'work\\x.txt',
    '../outside.txt',
    'work/../forbidden.txt',
    './work/allowed.txt',
    'work//allowed.txt',
    'work/\u0000x',
    '',
  ]) {
    assert.throws(() => scopedPath(root, bad), `应拒绝: ${bad}`);
  }
});

test('scopedPath：允许范围内存在的文件；不存在的文件仅末段可缺且父目录必须存在', () => {
  // 返回的是 realpath（macOS 临时目录带 /private 前缀）
  assert.equal(
    scopedPath(root, 'work/allowed.txt'),
    fs.realpathSync(path.join(work, 'allowed.txt')),
  );
  const fresh = scopedPath(root, 'work/new-file.txt');
  assert.equal(fresh, `${fs.realpathSync(work)}/new-file.txt`);
  assert.throws(() => scopedPath(root, 'work/missing-dir/x.txt'));
});

test('scopedPath：软链接与目录条目被拒绝', () => {
  assert.throws(() => scopedPath(root, 'work/evil-link'));
  assert.throws(() => scopedPath(root, 'work'));
});

test('assertWriteScope：undefined 不限；不在清单拒绝；工作区内绝对路径归一后仍校验', () => {
  assert.doesNotThrow(() => assertWriteScope(root, 'work/allowed.txt', undefined));
  assert.throws(() => assertWriteScope(root, 'work/forbidden.txt', SCOPE), assertRejected);
  assert.doesNotThrow(() => assertWriteScope(root, path.join(work, 'allowed.txt'), SCOPE));
  assert.throws(
    () => assertWriteScope(root, path.join(work, 'forbidden.txt'), SCOPE),
    assertRejected,
  );
});

// ---- 2. 工具层：write / edit / deleteFile / createDir ----
test('write：范围内文件可写', async () => {
  const out = await execute('write', { path: 'work/allowed.txt', content: 'updated' }, scopedCtx);
  assert.match(out, /写入成功/);
  assert.equal(fs.readFileSync(path.join(work, 'allowed.txt'), 'utf8'), 'updated');
});

test('write：范围外文件拒绝，磁盘未变；范围外新文件不得创建', async () => {
  await assert.rejects(
    () => execute('write', { path: 'work/forbidden.txt', content: 'hacked' }, scopedCtx),
    assertRejected,
  );
  assert.equal(fs.readFileSync(path.join(work, 'forbidden.txt'), 'utf8'), 'keep');
  await assert.rejects(
    () => execute('write', { path: 'output/new.txt', content: 'hacked' }, scopedCtx),
    assertRejected,
  );
  assert.ok(!fs.existsSync(path.join(root, 'output', 'new.txt')));
});

test('edit：范围外文件拒绝；范围内文件可编辑', async () => {
  await assert.rejects(
    () =>
      execute(
        'edit',
        { path: 'work/forbidden.txt', edits: [{ oldText: 'keep', newText: 'hacked' }] },
        scopedCtx,
      ),
    assertRejected,
  );
  assert.equal(fs.readFileSync(path.join(work, 'forbidden.txt'), 'utf8'), 'keep');
  const out = await execute(
    'edit',
    { path: 'work/allowed.txt', edits: [{ oldText: 'updated', newText: 'edited' }] },
    scopedCtx,
  );
  assert.match(out, /编辑成功|写入成功/);
});

test('deleteFile / moveFile：范围外拒绝', async () => {
  await assert.rejects(
    () => execute('deleteFile', { path: 'work/forbidden.txt' }, scopedCtx),
    assertRejected,
  );
  assert.ok(fs.existsSync(path.join(work, 'forbidden.txt')));
  await assert.rejects(
    () => execute('moveFile', { source: 'work/allowed.txt', target: 'work/moved.txt' }, scopedCtx),
    assertRejected,
  );
  assert.ok(!fs.existsSync(path.join(work, 'moved.txt')));
});

test('createDir：受限任务一律拒绝（不区分路径是否在范围内）', async () => {
  await assert.rejects(
    () => execute('createDir', { path: 'work/newdir' }, scopedCtx),
    (err: unknown) => err instanceof Error && /受限任务不能创建目录/.test(err.message),
  );
});

test('空范围 writeScope=[]：一切写入被禁（evidence 只读复用此机制）', async () => {
  const emptyCtx: ToolContext = { ...scopedCtx, writeScope: [] };
  await assert.rejects(
    () => execute('write', { path: 'work/allowed.txt', content: 'x' }, emptyCtx),
    assertRejected,
  );
  assert.equal(fs.readFileSync(path.join(work, 'allowed.txt'), 'utf8'), 'edited');
});

test('软链接即使写在范围内也被拒绝（不允许 symlink 条目）', async () => {
  await assert.rejects(
    () => execute('write', { path: 'work/evil-link', content: 'x' }, unscopedCtx),
    (err: unknown) => err instanceof Error,
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

// ---- 3. Shell 绕过攻击（macOS 沙箱；以磁盘为准）----
// 受限任务（writeScope 已定义）的 shell 被强制 read-only：workspace 整体不可写。
// 沙箱原语可用 → 验包含矩阵；不可用 → shell 必须 fail-closed 拒绝执行
// （绝不无沙箱运行），磁盘同样保证不变，两种路径都算验收通过。

async function scopedShell(command: string, events?: ToolSandboxEvent[]): Promise<string> {
  return execute(
    'shell',
    { command, timeoutMs: 30_000 },
    { ...scopedCtx, onSandboxEvent: events ? (e) => events.push(e) : undefined },
  );
}

function isSandboxUnavailable(err: unknown): boolean {
  return err instanceof Error && /Shell tool unavailable|cannot be applied/i.test(err.message);
}

async function expectShellDenied(command: string, events?: ToolSandboxEvent[]): Promise<void> {
  await assert.rejects(
    () => scopedShell(command, events),
    (err: unknown) =>
      err instanceof Error &&
      (err.message.startsWith('Shell operation denied by the workspace sandbox') ||
        isSandboxUnavailable(err)) &&
      !err.message.includes(TEST_ROOT) &&
      !err.message.includes(os.homedir()),
  );
}

if (process.platform === 'darwin') {
  test('受限任务 shell：写攻击（重定向/子进程/node/软链接）一律被拒，磁盘为准', async () => {
    const probe = await scopedShell('cat work/allowed.txt').then(
      (out) => ({ available: true as const, out }),
      (err: unknown) => ({ available: false as const, err }),
    );

    if (!probe.available) {
      // fail-closed：沙箱原语不可用，shell 必须整体拒绝，不做任何无沙箱执行
      assert.ok(
        isSandboxUnavailable(probe.err),
        `沙箱不可用时 shell 应拒绝执行，实际错误: ${String(probe.err)}`,
      );
      console.log('    [fail-closed] sandbox-exec 不可用：shell 拒绝执行，磁盘天然不变');
    } else {
      assert.ok(probe.out.includes('edited'), `应能读取范围内文件: ${probe.out}`);
      const events: ToolSandboxEvent[] = [];
      await expectShellDenied('printf hacked > work/forbidden.txt', events);
      assert.ok(
        events.some((e) => e.type === 'shell_sandbox_denied'),
        '应产生沙箱拒绝事件',
      );
      await expectShellDenied(`sh -c 'printf child > work/child-escape.txt'`);
      await expectShellDenied(`node -e "require('fs').writeFileSync('work/node-escape.txt','x')"`);
      await expectShellDenied('printf hacked > work/evil-link');
      const scratch = await scopedShell(
        'printf cache > "$HOME/scratch-cache.txt" && cat "$HOME/scratch-cache.txt"',
      );
      assert.ok(scratch.includes('cache'), `受管 scratch 应可写: ${scratch}`);
      console.log(
        '    [containment] 包含矩阵实测：重定向/子进程/node/软链接全部拒绝，scratch 可写',
      );
    }

    // 两种路径共通的磁盘终态断言
    assert.equal(fs.readFileSync(path.join(work, 'forbidden.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
    for (const never of [
      'work/new-via-shell.txt',
      'work/child-escape.txt',
      'work/node-escape.txt',
    ]) {
      assert.ok(!fs.existsSync(path.join(root, never)), `不应存在: ${never}`);
    }
  });
}

// ---- 汇总 ----
async function main(): Promise<void> {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failed++;
      const msg = (err as Error).message;
      failures.push(`${t.name} — ${msg}`);
      console.log(`  [FAIL] ${t.name} — ${msg}`);
    }
  }
  cleanupWorkspace(RUN);
  fs.rmSync(outside, { force: true });
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  console.log(`\n${'='.repeat(56)}`);
  console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('验收：范围约束单元/工具层拒绝正确；Shell 重定向/子进程/软链接绕过均以磁盘为准 ✓');
}

main();
