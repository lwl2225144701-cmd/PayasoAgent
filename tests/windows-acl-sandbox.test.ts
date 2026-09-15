// Windows ACL 契约回归：执行状态与命令输出分离、可撤销授权、权限模式。
import assert from 'node:assert/strict';
import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWindowsAclRunnerArgv,
  runWindowsAclShell,
} from '../src/sandbox/windows-acl-sandbox.js';

// ACL 沙箱只接受原生 PE 载体（MSYS2/WSL 在 WRITE_RESTRICTED 下必然在 DLL 初始化阶段死亡）。
const host = {
  platform: 'win32' as const,
  shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  source: 'powershell' as const,
  carrier: 'powershell' as const,
  runtime: 'native' as const,
};
function fakeSpawn(code: number, stderr: string, report?: object): typeof spawn {
  return (() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 0,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from(stderr));
      if (report) child.emit('message', { type: 'acl-result', ...report });
      child.emit('close', code);
    });
    return child as unknown as ChildProcess;
  }) as typeof spawn;
}
async function result(code: number, stderr: string, report?: object) {
  return runWindowsAclShell(host, 'echo test', {
    workspaceRoot: '.',
    scratchPath: '.',
    spawnImpl: fakeSpawn(code, stderr, report),
  });
}

const input = {
  nodeExecutable: 'node',
  workspaceRoot: 'C:\\工作区',
  scratchPath: 'C:\\temp',
};
assert.throws(
  () =>
    buildWindowsAclRunnerArgv({
      ...input,
      permissionMode: 'full-access',
      invocation: ['powershell.exe', '-Command', 'echo hi'],
    }),
  /Full access/,
);
for (const permissionMode of ['read-only', 'workspace-write'] as const) {
  for (const invocation of [
    // posix 载体：argv 尾段 = [exe, '-c', command]
    ['C:\\Program Files\\Git\\bin\\bash.exe', '-c', 'echo hi'],
    // 原生 PE 载体：PowerShell 的 -Command 全长写法
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'echo hi'],
  ]) {
    const argv = buildWindowsAclRunnerArgv({ ...input, permissionMode, invocation });
    assert.equal(argv[argv.indexOf('--mode') + 1], permissionMode);
    // argv 尾段必须**原样**回放载体调用形状（含 exe 与全部参数），不再硬编码 bash/-c
    assert.deepEqual(argv.slice(argv.indexOf('--') + 1), invocation);
  }
}
// fail-closed：MSYS2 / WSL 载体必须在 spawn 之前被拒绝，并给出准确的机制诊断。
for (const [runtime, source, path] of [
  ['msys2', 'git-bash', 'D:\\Git\\Git\\bin\\bash.exe'],
  ['wsl', 'wsl-bash', 'C:\\Windows\\System32\\bash.exe'],
] as const) {
  await assert.rejects(
    () =>
      runWindowsAclShell(
        { platform: 'win32', shellPath: path, source, carrier: 'posix', runtime },
        'echo test',
        { workspaceRoot: '.', scratchPath: '.' },
      ),
    (err: unknown) => {
      const message = (err as Error).message;
      // 必须点明真实机制，而不是误导用户去"安装 Git for Windows"
      return /cannot use the discovered shell carrier/.test(message) && !/Git for Windows/.test(message);
    },
  );
}
const completed = await result(127, 'payaso-win-acl: cleanup: revoke failed', {
  execution: 'completed',
  cleanupErrors: ['revoke failed'],
});
assert.equal(completed.execution, 'completed');
assert.equal(completed.runnerFailure, undefined);
assert.equal(completed.exitCode, 127);
assert.deepEqual(completed.cleanupErrors, ['revoke failed']);
assert.equal((await result(127, 'payaso-win-acl: fake startup failure')).execution, 'unknown');
assert.equal((await result(0, '')).execution, 'unknown');
assert.equal(
  (await result(127, '', { execution: 'not_started', error: 'init failed', cleanupErrors: [] }))
    .execution,
  'not_started',
);
assert.equal(
  (await result(127, '', { execution: 'unknown', error: 'wait failed', cleanupErrors: [] }))
    .execution,
  'unknown',
);

// 加载真实 runner 的生命周期函数，替换 Win32 端口；不加载 FFI，也不执行 main。
const runnerUrl = new URL('../src/sandbox/win-acl-runner.mjs', import.meta.url).href;
const { executeWithSandbox } = await import(runnerUrl);
async function lifecycle(failure?: 'grant' | 'init' | 'spawn' | 'wait' | 'cleanup') {
  const events: string[] = [];
  let options: Record<string, unknown> = {};
  const api = {
    tempWriteSid: () => 'scratch-sid',
    workspaceWriteSid: () => 'workspace-sid',
    AclWriteGrant: {
      create: () => ({
        add: (_path: string, standing: boolean) => {
          assert.equal(standing, false);
          events.push('grant');
          if (failure === 'grant') throw new Error('grant failed after apply');
        },
        dispose: () => {
          events.push('revoke');
          if (failure === 'cleanup') throw new Error('revoke failed');
        },
      }),
    },
    AclSandbox: class {
      constructor(value: Record<string, unknown>) {
        options = value;
      }
      async init() {
        if (failure === 'init') throw new Error('init failed');
      }
      spawn() {
        events.push('spawn');
        if (failure === 'spawn') throw new Error('spawn failed');
        return {
          wait: async () => {
            events.push('wait');
            if (failure === 'wait') throw new Error('wait failed');
            return { exitCode: 127 };
          },
        };
      }
      dispose() {
        events.push('dispose');
      }
    },
  };
  const report = await executeWithSandbox(
    { mode: 'read-only', scratch: 'scratch', workspace: 'workspace', command: 'bash', args: [] },
    api,
    () => {},
  );
  return { report, events, options };
}
const normal = await lifecycle();
assert.equal(normal.report.execution, 'completed');
assert.equal(normal.report.exitCode, 127);
assert.deepEqual(normal.events, ['grant', 'spawn', 'wait', 'dispose', 'revoke']);
assert.equal(normal.options.manageDacls, false);
assert.deepEqual(normal.options.writableDirs, ['scratch']);
assert.equal(normal.options.writeSid, 'scratch-sid');
for (const stage of ['grant', 'init'] as const) {
  const r = await lifecycle(stage);
  assert.equal(r.report.execution, 'not_started');
  assert.ok(r.events.includes('revoke'));
  assert.ok(!r.events.includes('spawn'));
}
for (const stage of ['spawn', 'wait'] as const) {
  const r = await lifecycle(stage);
  assert.equal(r.report.execution, 'unknown');
  assert.ok(!r.events.includes('revoke'));
}
const cleanup = await lifecycle('cleanup');
assert.equal(cleanup.report.execution, 'completed');
assert.equal(cleanup.report.exitCode, 127);
assert.deepEqual(cleanup.report.cleanupErrors, ['revoke failed']);
console.log('windows-acl-sandbox：执行阶段、IPC、授权生命周期与 Full access 回归通过');

// 真实 Node 子进程验证 IPC 不受 stderr 签名和自然 127 干扰。
const fixtureDir = mkdtempSync(join(tmpdir(), 'payaso-acl-ipc-'));
try {
  const runnerPath = join(fixtureDir, 'runner.mjs');
  writeFileSync(
    runnerPath,
    `process.stderr.write('payaso-win-acl: fake startup failure\\n');
process.send({ type: 'acl-result', execution: 'completed', cleanupErrors: ['cleanup failed'] }, () => { process.exitCode = 127; });`,
  );
  const r = await runWindowsAclShell(host, 'unused', {
    workspaceRoot: fixtureDir,
    scratchPath: fixtureDir,
    runnerPath,
    timeoutMs: 5000,
  });
  assert.equal(r.execution, 'completed');
  assert.equal(r.exitCode, 127);
  assert.equal(r.runnerFailure, undefined);
  assert.deepEqual(r.cleanupErrors, ['cleanup failed']);
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

// 超时路径回归（真机 D1 用例暴露的缺陷）：timeoutTimer 终止的是 **runner 本身**
// （child.pid），而 runner 正是唯一能发出完成报告的 IPC 通道 ⇒ report 必然缺失。
// 这属于**预期路径**而非失败：必须返回 timedOut=true，而不是退回 execution='unknown'，
// 否则上层 shell-executor 会把它升级成"执行结果未知，命令可能已运行"的异常。
const timeoutDir = mkdtempSync(join(tmpdir(), 'payaso-acl-timeout-'));
try {
  const hangRunner = join(timeoutDir, 'hang-runner.mjs');
  // 既不发 acl-result 报告，也不自行退出；3s 兜底自退，避免 taskkill 不可用时测试挂死。
  writeFileSync(hangRunner, 'setTimeout(() => process.exit(9), 3000);\n');
  const timed = await runWindowsAclShell(host, 'unused', {
    workspaceRoot: timeoutDir,
    scratchPath: timeoutDir,
    runnerPath: hangRunner,
    timeoutMs: 1200,
  });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.execution, 'completed');
  assert.equal(timed.runnerFailure, undefined);
  assert.deepEqual(timed.cleanupErrors, []);
} finally {
  rmSync(timeoutDir, { recursive: true, force: true });
}
console.log('windows-acl-sandbox：超时路径返回 timedOut=true（不再误报 execution=unknown）');
