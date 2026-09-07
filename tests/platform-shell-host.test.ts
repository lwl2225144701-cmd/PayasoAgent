// 模块: 跨平台 Shell 载体与进程树终止测试（docs/windows-mac-compat.md §3）。
// 用法: npx tsx tests/platform-shell-host.test.ts
// 验收：载体发现三平台分支（注入 platform/env，无需真实 Windows）；
// 进程树终止守卫（pid<=0 不波及自身）；无沙箱执行（unix/wslLegacy stdin 通道）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverShellHost,
  runUncontainedShell,
  terminateProcessTree,
} from '../src/sandbox/shell-host.js';

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
    console.log(`  [FAIL] ${name}: ${message}`);
  }
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
    assert.equal(host.wslLegacy, false);
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
    assert.equal(host.wslLegacy, true);
  });

  await test('win32：PATH 命中 bash.exe → path-bash', async () => {
    const env = makeFakeEnv({ 'pathbin/bash.exe': '' });
    delete env.ProgramFiles;
    delete env['ProgramFiles(x86)'];
    delete env.SystemRoot;
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

  await test('unix：/bin/bash 存在 → system-bash', async () => {
    const host = await discoverShellHost({ platform: 'linux' });
    assert.ok(host);
    assert.equal(host.shellPath, '/bin/bash');
  });

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

  await test('runUncontainedShell：unix 分支正常执行', async () => {
    const host = await discoverShellHost({ platform: 'linux' });
    assert.ok(host);
    const result = await runUncontainedShell(host, 'echo hello-unix', {
      cwd: os.tmpdir(),
      home: os.tmpdir(),
      tmpdir: os.tmpdir(),
      platform: 'linux',
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('hello-unix'));
    assert.equal(result.denied, false);
  });

  await test('runUncontainedShell：wslLegacy 走 stdin 通道执行', async () => {
    const host = {
      platform: 'win32' as const,
      shellPath: '/bin/bash',
      source: 'wsl-bash' as const,
      wslLegacy: true,
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

  await test('runUncontainedShell：超时整树终止 → timedOut', async () => {
    const host = await discoverShellHost({ platform: 'linux' });
    assert.ok(host);
    const start = Date.now();
    const result = await runUncontainedShell(host, 'sleep 5', {
      cwd: os.tmpdir(),
      home: os.tmpdir(),
      tmpdir: os.tmpdir(),
      timeoutMs: 250,
      platform: 'linux',
    });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - start < 4000, '超时应快速整树终止，而非等 sleep 完成');
  });

  await test('runUncontainedShell：预中止 signal → AbortError', async () => {
    const host = await discoverShellHost({ platform: 'linux' });
    assert.ok(host);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runUncontainedShell(host, 'sleep 5', {
        cwd: os.tmpdir(),
        home: os.tmpdir(),
        tmpdir: os.tmpdir(),
        signal: controller.signal,
        platform: 'linux',
      }),
      (err: unknown) => (err as Error).name === 'AbortError',
    );
  });

  console.log(`\n${'='.repeat(56)}`);
  console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('验收：载体三平台/进程树终止守卫/无沙箱执行/超时整树终止 ✓');
};

void main();
