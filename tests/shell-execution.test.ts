// 套件: Shell Execution Environment — scratch 目录 + 超时策略 + read-only 可执行性
// 用法: npx tsx tests/shell-execution.test.ts
// 回归目标（v1.8）：
//   1. Read Only 模式下 shell 仍可用：HOME/TMPDIR 指向受管 scratch（工作区保持只读）
//   2. 工作区写入在 Read Only 下仍被拒绝（边界没有被放宽）
//   3. scratch 只在受管根目录内创建、0700、用完即删
//   4. 超时可被模型请求并被 host 策略收敛（默认/上下限/env 覆盖）
//
// 能力条件：sandbox-exec 在部分 macOS 版本不可用；不可用时跳过 E2E 部分（fail-closed
// 拒绝路径由 os-sandbox 套件覆盖），纯函数与策略部分始终执行。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeSandboxAvailability } from '../src/sandbox/macos-sandbox.js';
import { createSandboxPolicy } from '../src/sandbox/sandbox-policy.js';
import { cleanupWorkspace, createWorkspace } from '../src/sandbox/sandbox-manager.js';
import {
  createShellScratch,
  isShellScratchPath,
  shellScratchRoot,
} from '../src/sandbox/shell-scratch.js';
import {
  resolveShellTimeout,
  SHELL_TIMEOUT_DEFAULT_MS,
  SHELL_TIMEOUT_MAX_MS,
  SHELL_TIMEOUT_MIN_MS,
  shellTimeoutPolicy,
} from '../src/sandbox/shell-timeout.js';
import { normalizeToolResult, type ToolContext } from '../src/tools/tools.js';
import '../src/tools/runtime-tools.js';
import { execute as executeRaw } from '../src/tools/tools.js';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-shell-exec-'));
process.env.SANDBOX_ROOT = TEST_ROOT;

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

async function tool(
  name: string,
  args: Record<string, unknown>,
  permissionMode: 'read-only' | 'workspace-write' | 'full-access',
  root: string,
): Promise<string> {
  const context: ToolContext = {
    runId: 'shell-exec-test',
    workspaceRoot: root,
    permissionMode,
  };
  return normalizeToolResult(await executeRaw(name, args, context)).text;
}

async function shell(
  command: string,
  permissionMode: 'read-only' | 'workspace-write' | 'full-access',
  root: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  return tool('shell', { command, ...args }, permissionMode, root);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 1. scratch 模块（纯函数/文件系统契约）----

await check('shellScratchRoot 默认在 OS 临时目录下，且不位于工作区内', () => {
  const root = shellScratchRoot({});
  assert.ok(root.startsWith(fs.realpathSync.native(os.tmpdir())), `root=${root}`);
  assert.ok(root.endsWith('payaso-shell'), `root=${root}`);
});

await check('shellScratchRoot 支持 PAYASO_SHELL_SCRATCH_ROOT 覆盖', () => {
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-custom-scratch-'));
  const root = shellScratchRoot({ PAYASO_SHELL_SCRATCH_ROOT: custom });
  assert.equal(root, fs.realpathSync.native(custom));
  fs.rmSync(custom, { recursive: true, force: true });
});

await check('isShellScratchPath：受管根内为真，外部为假', () => {
  const scratch = createShellScratch('probe');
  try {
    assert.equal(isShellScratchPath(scratch.path), true);
    assert.equal(isShellScratchPath(shellScratchRoot({})), true);
    assert.equal(isShellScratchPath(os.tmpdir()), false);
    assert.equal(isShellScratchPath('/etc'), false);
  } finally {
    scratch.dispose();
  }
});

await check('createShellScratch：0700、唯一、dispose 后删除', () => {
  const a = createShellScratch('unit');
  const b = createShellScratch('unit');
  try {
    assert.notEqual(a.path, b.path, '两次调用必须唯一');
    const mode = fs.statSync(a.path).mode & 0o777;
    assert.equal(mode, 0o700, `mode=${mode.toString(8)}`);
    assert.ok(isShellScratchPath(a.path));
  } finally {
    a.dispose();
    b.dispose();
  }
  assert.equal(fs.existsSync(a.path), false, 'dispose 后必须删除');
  assert.equal(fs.existsSync(b.path), false);
});

await check('createShellScratch：scope 含路径分隔符也不会逃逸受管根', () => {
  const scratch = createShellScratch('../../etc/evil');
  try {
    assert.ok(isShellScratchPath(scratch.path), `逃逸: ${scratch.path}`);
  } finally {
    scratch.dispose();
  }
});

// ---- 2. sandbox policy：scratch 是工作区外唯一可写根 ----

await check('read-only + scratchRoots：scratch 可写、工作区不可写', () => {
  const workspace = fs.mkdtempSync(path.join(TEST_ROOT, 'ws-policy-'));
  const scratch = createShellScratch('policy');
  try {
    const policy = createSandboxPolicy(workspace, {
      permissionMode: 'read-only',
      scratchRoots: [scratch.path],
    });
    assert.deepEqual(policy.scratchRoots, [fs.realpathSync.native(scratch.path)]);
    assert.ok(policy.writableRoots.includes(fs.realpathSync.native(scratch.path)));
    assert.ok(
      !policy.writableRoots.includes(fs.realpathSync.native(workspace)),
      'read-only 下工作区必须不可写',
    );
    assert.ok(policy.readableRoots.includes(fs.realpathSync.native(scratch.path)));
  } finally {
    scratch.dispose();
  }
});

await check('scratchRoots 落在受管根之外 → 策略构造失败（fail-closed）', () => {
  const workspace = fs.mkdtempSync(path.join(TEST_ROOT, 'ws-policy-bad-'));
  assert.throws(
    () => createSandboxPolicy(workspace, { scratchRoots: [os.tmpdir()] }),
    /managed shell scratch root/,
  );
});

// ---- 3. 超时策略 ----

await check('resolveShellTimeout：未请求 → 策略默认值', () => {
  const policy = { defaultMs: 5_000, maxMs: 60_000, minMs: 1_000 };
  assert.equal(resolveShellTimeout(undefined, policy), 5_000);
  assert.equal(resolveShellTimeout('abc', policy), 5_000);
  assert.equal(resolveShellTimeout(-1, policy), 5_000);
});

await check('resolveShellTimeout：请求被收敛到 [min,max]', () => {
  const policy = { defaultMs: 5_000, maxMs: 60_000, minMs: 1_000 };
  assert.equal(resolveShellTimeout(30_000, policy), 30_000);
  assert.equal(resolveShellTimeout(999_999, policy), 60_000);
  assert.equal(resolveShellTimeout(1, policy), 1_000);
  assert.equal(resolveShellTimeout(1_500.9, policy), 1_500);
});

await check('shellTimeoutPolicy：env 覆盖 + 非法值回落 + default 不超过 max', () => {
  const defaults = shellTimeoutPolicy({});
  assert.equal(defaults.defaultMs, SHELL_TIMEOUT_DEFAULT_MS);
  assert.equal(defaults.maxMs, SHELL_TIMEOUT_MAX_MS);
  assert.equal(defaults.minMs, SHELL_TIMEOUT_MIN_MS);

  const overridden = shellTimeoutPolicy({
    PAYASO_SHELL_TIMEOUT_MS: '45000',
    PAYASO_SHELL_TIMEOUT_MAX_MS: '90000',
  });
  assert.equal(overridden.defaultMs, 45_000);
  assert.equal(overridden.maxMs, 90_000);

  const clamped = shellTimeoutPolicy({
    PAYASO_SHELL_TIMEOUT_MS: '999999',
    PAYASO_SHELL_TIMEOUT_MAX_MS: '60000',
  });
  assert.equal(clamped.defaultMs, 60_000, 'default 不得超过 max');

  const invalid = shellTimeoutPolicy({ PAYASO_SHELL_TIMEOUT_MS: '-5', PAYASO_SHELL_TIMEOUT_MAX_MS: 'x' });
  assert.equal(invalid.defaultMs, SHELL_TIMEOUT_DEFAULT_MS);
  assert.equal(invalid.maxMs, SHELL_TIMEOUT_MAX_MS);

  // 配置低于下限时同样收敛（default 不得突破 min）
  const belowFloor = shellTimeoutPolicy({ PAYASO_SHELL_TIMEOUT_MS: '500' });
  assert.equal(belowFloor.defaultMs, SHELL_TIMEOUT_MIN_MS);
  const maxBelowFloor = shellTimeoutPolicy({ PAYASO_SHELL_TIMEOUT_MAX_MS: '200' });
  assert.equal(maxBelowFloor.maxMs, SHELL_TIMEOUT_MIN_MS);
  assert.ok(maxBelowFloor.defaultMs >= SHELL_TIMEOUT_MIN_MS);
});

// ---- 4. E2E：Read Only 下 shell 真正可用（需要 seatbelt）----

if (process.platform !== 'darwin') {
  console.log('\n  [SKIP] E2E：非 macOS');
} else if (!(await probeSandboxAvailability())) {
  console.log('\n  [SKIP] E2E：sandbox-exec 不可用（fail-closed 路径由 os-sandbox 套件覆盖）');
} else {
  const runId = 'shell-exec-e2e';
  const workspace = createWorkspace(runId);
  const readOnlyRoot = path.join(workspace, 'work');
  fs.mkdirSync(readOnlyRoot, { recursive: true });

  await check('read-only：HOME/TMPDIR 可写（npm/git 等缓存不再被拒）', async () => {
    const out = await shell(
      'printf cached > "$HOME/cache.txt" && printf tmp > "$TMPDIR/tmp.txt" && echo OK && cat "$HOME/cache.txt"',
      'read-only',
      readOnlyRoot,
    );
    assert.ok(out.includes('OK'), `输出: ${out}`);
    assert.ok(out.includes('cached'), `输出: ${out}`);
  });

  await check('read-only：工作区写入仍被拒绝（边界未放宽）', async () => {
    await assert.rejects(
      () => shell('echo nope > blocked.txt && echo SHOULD_NOT_HAPPEN', 'read-only', readOnlyRoot),
      /denied by the workspace sandbox/,
      '工作区写入必须被沙箱拒绝',
    );
    assert.equal(
      fs.existsSync(path.join(readOnlyRoot, 'blocked.txt')),
      false,
      '被拒绝的命令不得产生写入',
    );
  });

  await check('scratch 用完即删：调用结束后受管根内不残留目录', async () => {
    const root = shellScratchRoot({});
    const before = fs.existsSync(root) ? fs.readdirSync(root).length : 0;
    await shell('echo ok', 'workspace-write', readOnlyRoot);
    const after = fs.existsSync(root) ? fs.readdirSync(root).length : 0;
    assert.equal(after, before, `scratch 残留: ${fs.readdirSync(root).join(',')}`);
  });

  await check('timeoutMs 被接受并生效：sleep 3 在 1s 超时下返回 [shell-timeout]', async () => {
    const out = await shell('sleep 3', 'workspace-write', readOnlyRoot, { timeoutMs: 1_000 });
    assert.ok(out.includes('[shell-timeout]'), `输出: ${out.slice(0, 200)}`);
  });

  await check('timeoutMs 充足时命令正常完成', async () => {
    const out = await shell('sleep 1 && echo DONE', 'workspace-write', readOnlyRoot, {
      timeoutMs: 30_000,
    });
    assert.ok(out.includes('DONE'), `输出: ${out}`);
  });

  await check('后台作业：立即返回 jobId，完成后可取回输出', async () => {
    const started = await shell('printf bg-ok', 'workspace-write', readOnlyRoot, {
      background: true,
    });
    assert.ok(started.includes('[shell-background]'), `输出: ${started}`);
    const jobId = started.match(/jobId=(job-\d+)/)?.[1];
    assert.ok(jobId, `缺少 jobId: ${started}`);

    let output = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      output = await tool('shellJob', { action: 'output', jobId }, 'workspace-write', readOnlyRoot);
      if (!output.includes('仍在运行')) break;
      await sleep(50);
    }
    assert.ok(output.includes('bg-ok'), `后台输出缺失: ${output}`);
  });

  await check('后台作业：kill 终止长命令', async () => {
    const started = await shell('sleep 30', 'workspace-write', readOnlyRoot, {
      background: true,
    });
    const jobId = started.match(/jobId=(job-\d+)/)?.[1];
    assert.ok(jobId, `缺少 jobId: ${started}`);
    const killed = await tool(
      'shellJob',
      { action: 'kill', jobId },
      'workspace-write',
      readOnlyRoot,
    );
    assert.ok(killed.includes('已请求终止'), killed);
    await sleep(200);
    const status = await tool('shellJob', { action: 'status', jobId }, 'workspace-write', readOnlyRoot);
    assert.ok(status.includes('[killed]'), `应已终止: ${status}`);
  });

  cleanupWorkspace(runId);
}

console.log(`\nshell-execution 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
