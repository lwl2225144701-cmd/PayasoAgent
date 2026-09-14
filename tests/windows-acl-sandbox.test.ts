// 套件: Windows ACL Shell 执行器 — runner argv 契约 + 失败识别 + 假 spawn 执行
// 用法: npx tsx tests/windows-acl-sandbox.test.ts
// 验收（跨平台沙箱改造步骤 2，全部确定性、无需真实 Windows）：
//   1. buildWindowsAclRunnerArgv：三权限模式的 argv 逐项断言
//   2. isWindowsAclRunnerFailure：exit 127 + 签名行双条件（防命令自打印签名误判）
//   3. runWindowsAclShell：注入假 spawn —— runner 失败路径 / 正常路径 / 自然 127

import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  buildWindowsAclRunnerArgv,
  isWindowsAclRunnerFailure,
  runWindowsAclShell,
  WINDOWS_ACL_RUNNER_FAILURE_EXIT,
  WINDOWS_ACL_RUNNER_SIGNATURE,
} from '../src/sandbox/windows-acl-sandbox.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`  [FAIL] ${name} — ${message}`);
  }
}

const HOST = {
  platform: 'win32' as const,
  shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  source: 'git-bash' as const,
  wslLegacy: false,
};

const main = async (): Promise<void> => {
  await test('argv：read-only 模式（workspace 不授权，仅 scratch 可写）', () => {
    const argv = buildWindowsAclRunnerArgv({
      nodeExecutable: '/node/bin/node',
      runnerPath: '/runner/win-acl-runner.mjs',
      workspaceRoot: 'C:\\ws',
      scratchPath: 'C:\\scratch\\s-abc123',
      permissionMode: 'read-only',
      bashPath: HOST.shellPath,
      command: 'npm test',
    });
    assert.deepEqual(argv, [
      '/node/bin/node',
      '/runner/win-acl-runner.mjs',
      '--workspace',
      'C:\\ws',
      '--scratch',
      'C:\\scratch\\s-abc123',
      '--mode',
      'read-only',
      '--',
      HOST.shellPath,
      '-c',
      'npm test',
    ]);
  });

  await test('argv：workspace-write 与 full-access 都映射为 workspace-write', () => {
    for (const permissionMode of ['workspace-write', 'full-access'] as const) {
      const argv = buildWindowsAclRunnerArgv({
        nodeExecutable: 'node',
        workspaceRoot: 'C:\\ws',
        scratchPath: 'C:\\scratch\\s-x',
        permissionMode,
        bashPath: 'bash.exe',
        command: 'echo hi',
      });
      const modeIndex = argv.indexOf('--mode');
      assert.equal(argv[modeIndex + 1], 'workspace-write');
      // argv[0]/argv[1] 缺省为 process.execPath 与内置 runner 路径
      assert.ok(argv[1].endsWith('win-acl-runner.mjs'));
    }
  });

  await test('失败识别：exit 127 + 签名行 → runner 失败', () => {
    assert.equal(
      isWindowsAclRunnerFailure(
        127,
        `noise\n${WINDOWS_ACL_RUNNER_SIGNATURE}: SetConsoleCtrlHandler failed (Win32 5)`,
      ),
      true,
    );
  });

  await test('失败识别：exit 127 但无签名行 → 不是 runner 失败（命令自然退出 127）', () => {
    assert.equal(isWindowsAclRunnerFailure(127, 'bash: not-a-command: command not found'), false);
  });

  await test('失败识别：有签名行但 exit ≠ 127 → 不是 runner 失败（子进程已执行，清理失败不覆盖退出码）', () => {
    assert.equal(
      isWindowsAclRunnerFailure(0, `${WINDOWS_ACL_RUNNER_SIGNATURE}: cleanup: boom`),
      false,
    );
    assert.equal(
      isWindowsAclRunnerFailure(
        WINDOWS_ACL_RUNNER_FAILURE_EXIT - 1,
        `${WINDOWS_ACL_RUNNER_SIGNATURE}: x`,
      ),
      false,
    );
  });

  await test('runWindowsAclShell：假 spawn 模拟 runner 失败（127 + 签名）→ runnerFailure 携带签名行', async () => {
    const spawnImpl = fakeSpawn({
      exitCode: 127,
      stderr: `${WINDOWS_ACL_RUNNER_SIGNATURE}: cannot load kernel32\n`,
    });
    const result = await runWindowsAclShell(HOST, 'echo hi', {
      workspaceRoot: 'C:\\ws',
      scratchPath: 'C:\\scratch\\s-x',
      timeoutMs: 5_000,
      spawnImpl,
    });
    assert.equal(result.runnerFailure, `${WINDOWS_ACL_RUNNER_SIGNATURE}: cannot load kernel32`);
    assert.equal(result.exitCode, 127);
    assert.equal(result.denied, false);
  });

  await test('runWindowsAclShell：假 spawn 正常路径 → 无 runnerFailure，输出与退出码透传', async () => {
    const spawnImpl = fakeSpawn({ exitCode: 0, stdout: 'all good\n' });
    const outputs: string[] = [];
    const result = await runWindowsAclShell(HOST, 'echo hi', {
      workspaceRoot: 'C:\\ws',
      scratchPath: 'C:\\scratch\\s-x',
      timeoutMs: 5_000,
      onOutput: (text) => outputs.push(text),
      spawnImpl,
    });
    assert.equal(result.runnerFailure, undefined);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'all good\n');
    assert.equal(result.timedOut, false);
    assert.ok(outputs.includes('all good\n'));
  });

  await test('runWindowsAclShell：命令自然退出 127（无签名）→ 不误判为 runner 失败', async () => {
    const spawnImpl = fakeSpawn({ exitCode: 127, stderr: 'bash: nope: command not found\n' });
    const result = await runWindowsAclShell(HOST, 'nope', {
      workspaceRoot: 'C:\\ws',
      scratchPath: 'C:\\scratch\\s-x',
      timeoutMs: 5_000,
      spawnImpl,
    });
    assert.equal(result.runnerFailure, undefined);
    assert.equal(result.exitCode, 127);
  });

  if (failed > 0) {
    console.error(`\nwindows-acl-sandbox 测试失败（${failed}）:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`windows-acl-sandbox 测试完成：${passed} 通过 / ${failed} 失败`);
};

/**
 * 构造假 spawn：spawn 返回伪 ChildProcess，并在微任务里自动触发 stdout/stderr
 * 数据与 close 事件（runWindowsAclShell 的监听在 Promise executor 内同步挂好，
 * 微任务时已就绪；外部手动触发会造成 await 死锁）。
 */
function fakeSpawn(behavior: {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}): typeof import('node:child_process').spawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = 0; // 不触发真实进程树终止
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (behavior.stdout !== undefined) child.stdout.emit('data', Buffer.from(behavior.stdout));
      if (behavior.stderr !== undefined) child.stderr.emit('data', Buffer.from(behavior.stderr));
      child.emit('close', behavior.exitCode);
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
}

void main();
