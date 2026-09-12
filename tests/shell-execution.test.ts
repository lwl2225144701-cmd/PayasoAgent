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
import { cleanupWorkspace, createWorkspace } from '../src/sandbox/sandbox-manager.js';
import { createSandboxPolicy } from '../src/sandbox/sandbox-policy.js';
import {
  createShellScratch,
  isShellScratchPath,
  SCRATCH_MAX_TMPDIR_BYTES,
  SCRATCH_SOCKET_RESERVE_BYTES,
  shellScratchRoot,
  shellScratchRoots,
  UNIX_SOCKET_PATH_LIMIT_BYTES,
} from '../src/sandbox/shell-scratch.js';
import {
  resolveShellTimeout,
  resolveShellToolTimeout,
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

// 环境门（v1.10）：这批检查依赖两个假设——
//   a) 能创建受管 scratch 根；
//   b) os.tmpdir() 是独立于受管 scratch 的外部位置（若干断言用它当"外部"样本）。
// 嵌套沙箱（agent 在自己的沙箱里跑 test:all）两条件都不成立：TMPDIR 指向外层
// scratch（本身就是受管根），且 /private/tmp 不可写。与 os-sandbox 的 E2E 门
// 一致——环境不具备能力时如实 SKIP，而不是假绿或假红。
let scratchChecksEligible = true;
try {
  createShellScratch('eligibility-probe').dispose();
  if (isShellScratchPath(os.tmpdir())) scratchChecksEligible = false;
} catch {
  scratchChecksEligible = false;
}

if (scratchChecksEligible) {
  await check(
    'shellScratchRoot 默认落在短临时根（/private/tmp/payaso-shell），不位于工作区内',
    () => {
      const root = shellScratchRoot({});
      assert.ok(root.endsWith(`${path.sep}payaso-shell`), `root=${root}`);
      assert.ok(
        !root.startsWith(fs.realpathSync.native(os.tmpdir())),
        '不应再落在 /var/folders 深层路径',
      );
      // v1.10 关键约束：根路径本身必须短，TMPDIR 才有余量（见 UNIX_SOCKET_PATH_LIMIT_BYTES）
      assert.ok(
        root.length < 60,
        `根路径必须短（实际 ${root.length} 字节），否则 TMPDIR 会逼近 AF_UNIX 108 上限`,
      );
    },
  );

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

  await check(
    'TMPDIR 长度不变量：scratch 路径 + socket 预留 < 108（tsx 不再 listen EINVAL）',
    () => {
      const scratch = createShellScratch('run-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
      try {
        const tmpdirBytes = Buffer.byteLength(scratch.path, 'utf8');
        assert.ok(
          tmpdirBytes + SCRATCH_SOCKET_RESERVE_BYTES < UNIX_SOCKET_PATH_LIMIT_BYTES,
          `TMPDIR=${tmpdirBytes} + socket 预留 ${SCRATCH_SOCKET_RESERVE_BYTES} 必须 < 108`,
        );
        assert.ok(tmpdirBytes <= SCRATCH_MAX_TMPDIR_BYTES, `TMPDIR=${tmpdirBytes} 超预算`);
      } finally {
        scratch.dispose();
      }
    },
  );

  await check('scope 不再进入路径：超长 runId 也不会影响 TMPDIR 长度', () => {
    const a = createShellScratch('x');
    const b = createShellScratch('y'.repeat(100));
    try {
      assert.equal(a.path.length, b.path.length, '路径长度不应随 scope 变化');
      assert.ok(Buffer.byteLength(b.path, 'utf8') < 60, `路径应保持短: ${b.path.length}`);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  await check('测试套件最坏 mkdtemp 前缀也放得下（os.tmpdir() = TMPDIR）', () => {
    const scratch = createShellScratch('probe');
    try {
      // run-all 里最长的套件临时前缀约 29 字符 + mkdtemp 6 位随机
      const worstCase = Buffer.byteLength(scratch.path, 'utf8') + 29 + 6;
      assert.ok(
        worstCase < UNIX_SOCKET_PATH_LIMIT_BYTES,
        `测试套件 mkdtemp 最坏情况 ${worstCase} 必须 < 108`,
      );
    } finally {
      scratch.dispose();
    }
  });

  await check('回退链：主根不可写时回退到 os.tmpdir()/payaso-shell（嵌套沙箱场景）', () => {
    const roots = shellScratchRoots({});
    const primary = roots[0];
    fs.mkdirSync(primary, { recursive: true, mode: 0o700 });
    fs.chmodSync(primary, 0o500); // 让 mkdtemp 在主根下 EPERM
    try {
      const scratch = createShellScratch('fallback-probe');
      try {
        const fallbackRoot = fs.realpathSync.native(roots[1]);
        assert.ok(
          scratch.path.startsWith(fallbackRoot + path.sep),
          `应回退到 os.tmpdir() 根: ${scratch.path}`,
        );
        assert.equal(
          isShellScratchPath(scratch.path),
          true,
          '回退后的路径仍必须被识别为受管 scratch',
        );
        // 硬约束：即使回退到 os.tmpdir()（裸环境是 /var/folders 长路径），
        // TMPDIR + socket 预留必须仍 < 108，tsx 才不会 EINVAL。
        assert.ok(
          Buffer.byteLength(scratch.path, 'utf8') + SCRATCH_SOCKET_RESERVE_BYTES <
            UNIX_SOCKET_PATH_LIMIT_BYTES,
          `回退根 TMPDIR 超预算: ${Buffer.byteLength(scratch.path, 'utf8')}`,
        );
      } finally {
        scratch.dispose();
      }
    } finally {
      fs.chmodSync(primary, 0o700); // 还原主根权限
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
} else {
  console.log(
    '  [SKIP] scratch/policy 文件系统检查：当前环境不满足可创建 scratch 根 或 os.tmpdir() 已位于受管根内（嵌套沙箱）',
  );
}
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

await check('resolveShellToolTimeout：后台未指定时使用策略上限', () => {
  const policy = { defaultMs: 5_000, maxMs: 60_000, minMs: 1_000 };
  assert.equal(resolveShellToolTimeout(undefined, false, policy), 5_000);
  assert.equal(resolveShellToolTimeout(undefined, true, policy), 60_000);
  assert.equal(resolveShellToolTimeout(30_000, true, policy), 30_000);
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

  const invalid = shellTimeoutPolicy({
    PAYASO_SHELL_TIMEOUT_MS: '-5',
    PAYASO_SHELL_TIMEOUT_MAX_MS: 'x',
  });
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

  await check('E2E：短 TMPDIR 下 tsx 可运行（回归 listen EINVAL）', async () => {
    // workspaceRoot = 真实项目，让 node_modules/.bin/tsx 可读可执行；
    // read-only 模式下 HOME/TMPDIR 仍指向可写 scratch。
    const out = await tool(
      'shell',
      {
        command: 'npx tsx -e "console.log(\"TMPDIR_OK\")"',
        timeoutMs: 120_000,
      },
      'read-only',
      process.cwd(),
    );
    assert.ok(out.includes('TMPDIR_OK'), `tsx 输出应包含 TMPDIR_OK: ${out.slice(0, 300)}`);
    assert.ok(!out.includes('EINVAL'), `不应出现 listen EINVAL: ${out.slice(0, 300)}`);
  });

  await check('后台作业：立即返回 jobId，完成后可取回输出', async () => {
    const started = await shell('printf bg-ok', 'workspace-write', readOnlyRoot, {
      background: true,
    });
    assert.ok(started.includes('[shell-background]'), `输出: ${started}`);
    const jobId = started.match(/jobId=(job-\d+)/)?.[1];
    assert.ok(jobId, `缺少 jobId: ${started}`);

    const output = await tool(
      'shellJob',
      { action: 'wait', jobId, waitMs: 2_000 },
      'workspace-write',
      readOnlyRoot,
    );
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
    const status = await tool(
      'shellJob',
      { action: 'status', jobId },
      'workspace-write',
      readOnlyRoot,
    );
    assert.ok(status.includes('[killed]'), `应已终止: ${status}`);
  });

  cleanupWorkspace(runId);
}

console.log(`\nshell-execution 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
