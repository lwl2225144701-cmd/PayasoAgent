// 模块: 跨平台 Shell 载体与进程树终止测试（docs/sandbox/windows-mac-compat.md §3）。
// 用法: npx tsx tests/platform-shell-host.test.ts
// 验收：载体发现三平台分支（注入 platform/env，无需真实 Windows）；
// 进程树终止守卫（pid<=0 不波及自身）；无沙箱执行（unix/wslLegacy stdin 通道）。
//
// 本机适配（2026-09-14）：本套件在 Windows 跑测机上也会执行。
// - 载体**发现**逻辑全部走注入 platform/env，三平台分支与宿主无关 → 恒可测。
// - 需要"真的有一个 POSIX bash"的用例（/bin/bash 发现、WSL stdin 执行）在 Windows
//   上不可能通过 → 显式 skip（打印 SKIP，不计入 FAIL），而不是让套件长期带红。
// - 需要"真的能执行命令"的用例改为**按本机载体**执行：Windows 上用 discoverNativeShellHost
//   拿到的 PowerShell（这正是 ACL 沙箱实际用的载体），POSIX 上用 bash。
//   这样执行路径在发布平台上是真被覆盖的，而非只覆盖 macOS。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShellHost } from '../src/sandbox/shell-host.js';
import {
  buildShellInvocation,
  describeAclIncompatibleCarrier,
  describeShellLanguage,
  discoverNativeShellHost,
  discoverShellHost,
  isAclCompatibleCarrier,
  runUncontainedShell,
  terminateProcessTree,
  usesStdinCommand,
} from '../src/sandbox/shell-host.js';

let passed = 0;
let failed = 0;
let skipped = 0;
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
    console.log(`  [FAIL] ${name}: ${message}`);
  }
}

/** 本机不具备该前置条件 → 记 SKIP 而非 FAIL，避免套件在无关平台上长期带红。 */
function skip(condition: boolean, name: string, reason: string): boolean {
  if (condition) {
    skipped++;
    console.log(`  [SKIP] ${name} —— ${reason}`);
    return true;
  }
  return false;
}

/** 本机是否存在真实的 POSIX bash（Windows 跑测机上通常没有）。 */
const HAS_POSIX_BASH = process.platform !== 'win32' && fs.existsSync('/bin/bash');

/**
 * 取本机**真实**可用的载体用于执行类用例：Windows 用原生 PE（PowerShell），
 * 其他平台用 discoverShellHost。用真实 env，不注入。
 */
async function resolveHostForCurrentMachine(): Promise<ShellHost> {
  const host =
    process.platform === 'win32'
      ? await discoverNativeShellHost({ platform: 'win32' })
      : await discoverShellHost({ platform: process.platform });
  assert.ok(host, `本机未找到可用 shell 载体（platform=${process.platform}）`);
  return host;
}

/** 按载体语言给一条"长命令"，用于超时/中止用例。 */
function longRunningCommand(host: ShellHost): string {
  return host.carrier === 'posix' ? 'sleep 5' : 'Start-Sleep -Seconds 5';
}

function makeFakeEnv(files: Record<string, string>): Record<string, string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-shell-host-'));
  for (const [rel, target] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, target);
  }
  return {
    ...process.env,
    PAYASO_SHELL_FAKE_ROOT: root,
    ProgramFiles: path.join(root, 'pf'),
    'ProgramFiles(x86)': path.join(root, 'pfx86'),
    SystemRoot: path.join(root, 'system'),
    PATH: path.join(root, 'pathbin'),
  };
}

const main = async (): Promise<void> => {
  await test('win32：%ProgramFiles%\\Git\\bin\\bash.exe → git-bash', async () => {
    const env = makeFakeEnv({ 'pf/Git/bin/bash.exe': '' });
    const host = await discoverShellHost({ platform: 'win32', env });
    assert.ok(host);
    assert.equal(host.source, 'git-bash');
    assert.equal(host.runtime, 'msys2');
    assert.equal(host.carrier, 'posix');
    assert.ok(host.shellPath.endsWith(`Git${path.sep}bin${path.sep}bash.exe`));
  });

  await test('win32：%ProgramFiles(x86)% 兜底 → git-bash', async () => {
    const env = makeFakeEnv({ 'pfx86/Git/bin/bash.exe': '' });
    const host = await discoverShellHost({ platform: 'win32', env });
    assert.ok(host);
    assert.equal(host.source, 'git-bash');
  });

  await test('win32：老 WSL System32\\bash.exe → wslLegacy', async () => {
    const env = makeFakeEnv({ 'system/System32/bash.exe': '' });
    const host = await discoverShellHost({ platform: 'win32', env });
    assert.ok(host);
    assert.equal(host.source, 'wsl-bash');
    assert.equal(host.runtime, 'wsl');
    assert.equal(usesStdinCommand(host), true);
  });

  await test('win32：PATH 命中 bash.exe → path-bash（优先于 legacy WSL）', async () => {
    // 同时准备 legacy WSL 与 PATH bash：PATH 必须先命中。
    // 这是 2026-09-14 真机验收的修订点 —— 原顺序让 WSL 抢占，装了 Git 也永远选不到。
    const env = makeFakeEnv({ 'pathbin/bash.exe': '', 'system/System32/bash.exe': '' });
    delete env.ProgramFiles;
    delete env['ProgramFiles(x86)'];
    const host = await discoverShellHost({ platform: 'win32', env });
    assert.ok(host);
    assert.equal(host.source, 'path-bash');
  });

  await test('win32：全无 → null（调用方引导装 Git for Windows）', async () => {
    const env = makeFakeEnv({});
    delete env.ProgramFiles;
    delete env['ProgramFiles(x86)'];
    delete env.SystemRoot;
    env.PATH = path.join(os.tmpdir(), 'payaso-shell-host-nonexistent-xyz');
    const host = await discoverShellHost({ platform: 'win32', env });
    assert.equal(host, null);
  });

  await test('win32：原生 PE 载体发现 → PowerShell（ACL 沙箱专用）', async () => {
    const env = makeFakeEnv({
      'system/System32/WindowsPowerShell/v1.0/powershell.exe': '',
    });
    const host = await discoverNativeShellHost({ platform: 'win32', env });
    assert.ok(host);
    assert.equal(host.source, 'powershell');
    assert.equal(host.carrier, 'powershell');
    assert.equal(host.runtime, 'native');
    assert.equal(isAclCompatibleCarrier(host), true);
  });

  await test('win32：PowerShell 缺失 → cmd.exe 兜底（仍是原生 PE）', async () => {
    const env = makeFakeEnv({ 'system/System32/cmd.exe': '' });
    const host = await discoverNativeShellHost({ platform: 'win32', env });
    assert.ok(host);
    assert.equal(host.source, 'cmd');
    assert.equal(host.carrier, 'cmd');
    assert.equal(isAclCompatibleCarrier(host), true);
  });

  await test('win32：两者皆无 → null（ACL 必须 fail-closed，不回落 bash）', async () => {
    const env = makeFakeEnv({ 'pf/Git/bin/bash.exe': '' });
    const host = await discoverNativeShellHost({ platform: 'win32', env });
    assert.equal(host, null);
  });

  await test('ACL 载体兼容性：MSYS2/WSL 判为不兼容且诊断为准确机制', async () => {
    const msys2 = {
      platform: 'win32' as const,
      shellPath: 'D:\\Git\\Git\\bin\\bash.exe',
      source: 'git-bash' as const,
      carrier: 'posix' as const,
      runtime: 'msys2' as const,
    };
    assert.equal(isAclCompatibleCarrier(msys2), false);
    const message = describeAclIncompatibleCarrier(msys2);
    assert.match(message, /WRITE_RESTRICTED/);
    assert.match(message, /0xC0000142/);
    // 不得把用户引向"安装 Git for Windows"这种无效修复
    assert.doesNotMatch(message, /Git for Windows/);

    const wsl = { ...msys2, shellPath: 'C:\\Windows\\System32\\bash.exe', source: 'wsl-bash' as const, runtime: 'wsl' as const };
    assert.equal(isAclCompatibleCarrier(wsl), false);
    assert.match(describeAclIncompatibleCarrier(wsl), /E_ACCESSDENIED/);
  });

  await test('调用形状：posix/-c、wsl/-s、powershell/-Command、cmd=/c', () => {
    const base = { platform: 'win32' as const, shellPath: 'sh' };
    assert.deepEqual(
      buildShellInvocation({ ...base, source: 'git-bash', carrier: 'posix', runtime: 'msys2' }, 'echo hi'),
      ['sh', '-c', 'echo hi'],
    );
    assert.deepEqual(
      buildShellInvocation({ ...base, source: 'wsl-bash', carrier: 'posix', runtime: 'wsl' }, 'echo hi'),
      ['sh', '-s'],
    );
    assert.deepEqual(
      buildShellInvocation({ ...base, source: 'powershell', carrier: 'powershell', runtime: 'native' }, 'echo hi'),
      ['sh', '-NoProfile', '-NonInteractive', '-Command', 'echo hi'],
    );
    assert.deepEqual(
      buildShellInvocation({ ...base, source: 'cmd', carrier: 'cmd', runtime: 'native' }, 'echo hi'),
      ['sh', '/d', '/s', '/c', 'echo hi'],
    );
  });

  await test('shell 语言提示：随平台与 ACL gate 变化（写进环境上下文）', () => {
    assert.match(describeShellLanguage('darwin', {}), /bash/);
    assert.match(describeShellLanguage('win32', { PAYASO_SHELL_WINDOWS_ACL: '1' }), /PowerShell/);
    assert.match(describeShellLanguage('win32', {}), /bash/);
  });

  if (
    !skip(
      !HAS_POSIX_BASH,
      'unix：/bin/bash 存在 → system-bash',
      `本机无 /bin/bash（platform=${process.platform}），unix 分支无法真测`,
    )
  ) {
    await test('unix：/bin/bash 存在 → system-bash', async () => {
      const host = await discoverShellHost({ platform: 'linux' });
      assert.ok(host);
      assert.equal(host.shellPath, '/bin/bash');
    });
  }

  await test('terminateProcessTree：pid<=0 守卫（不波及自身）', () => {
    assert.doesNotThrow(() => terminateProcessTree(0, { platform: 'linux' }));
    assert.doesNotThrow(() => terminateProcessTree(-1, { platform: 'linux' }));
  });

  await test('terminateProcessTree：unix 分支无效 pid 不抛', () => {
    assert.doesNotThrow(() => terminateProcessTree(9_999_999, { platform: 'linux' }));
  });

  await test('terminateProcessTree：win32 分支 taskkill spawn 不阻塞不抛', () => {
    // 本机非 win32，taskkill 会 emit error——被 error 监听吞掉，调用方无感知
    assert.doesNotThrow(() => terminateProcessTree(12345, { platform: 'win32' }));
  });

  // ---- 执行类用例：按**本机真实载体**跑，确保发布平台（Windows）也被覆盖 ----

  await test('runUncontainedShell：本机载体正常执行（win32→PowerShell / posix→bash）', async () => {
    const host = await resolveHostForCurrentMachine();
    const result = await runUncontainedShell(host, 'echo hello-native', {
      cwd: os.tmpdir(),
      home: os.tmpdir(),
      tmpdir: os.tmpdir(),
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('hello-native'), `stdout=${JSON.stringify(result.stdout)}`);
    assert.equal(result.denied, false);
  });

  await test('runUncontainedShell：超时整树终止 → timedOut', async () => {
    const host = await resolveHostForCurrentMachine();
    const start = Date.now();
    const result = await runUncontainedShell(host, longRunningCommand(host), {
      cwd: os.tmpdir(),
      home: os.tmpdir(),
      tmpdir: os.tmpdir(),
      timeoutMs: 1_500,
    });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - start < 15_000, '超时应整树终止，而非等长命令自然结束');
  });

  await test('runUncontainedShell：预中止 signal → AbortError', async () => {
    const host = await resolveHostForCurrentMachine();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runUncontainedShell(host, longRunningCommand(host), {
        cwd: os.tmpdir(),
        home: os.tmpdir(),
        tmpdir: os.tmpdir(),
        signal: controller.signal,
      }),
      (err: unknown) => (err as Error).name === 'AbortError',
    );
  });

  if (
    !skip(
      !HAS_POSIX_BASH,
      'runUncontainedShell：wslLegacy 走 stdin 通道执行',
      `需要真实 POSIX bash 以验证 stdin 通道（platform=${process.platform}）`,
    )
  ) {
    await test('runUncontainedShell：wslLegacy 走 stdin 通道执行', async () => {
      const host = {
        platform: 'win32' as const,
        shellPath: '/bin/bash',
        source: 'wsl-bash' as const,
        carrier: 'posix' as const,
        runtime: 'wsl' as const,
      };
      const result = await runUncontainedShell(host, 'echo hello-stdin', {
        cwd: os.tmpdir(),
        home: os.tmpdir(),
        tmpdir: os.tmpdir(),
        platform: 'linux',
      });
      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.includes('hello-stdin'));
    });
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`汇总: ${passed} PASS / ${failed} FAIL / ${skipped} SKIP`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('验收：载体三平台/进程树终止守卫/无沙箱执行/超时整树终止 ✓');
};

void main();
