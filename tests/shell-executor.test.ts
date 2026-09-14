// 套件: Shell Executor — 平台选择矩阵 + gate 语义 + Windows ACL fail-closed E2E
// 用法: npx tsx tests/shell-executor.test.ts
// 验收（跨平台沙箱改造步骤 1/2，确定性）：
//   1. selectShellExecutor：darwin / win32×gate 开关 / linux
//   2. gate 关闭的 win32 → uncontained-gated（PAYASO_SHELL_UNSANDBOXED 未设 → 拒绝文案不变）
//   3. gate 开启的 win32 → windows-acl 执行器；runner 在非 win32 环境（无 kernel32）
//      必然 exit 127 + 签名行 → executor fail-closed 抛结构化错误，命令未执行
//   4. macOS 事件形状探针：seatbelt 执行结果附 executor/enforcement 元数据

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeShellCommand, selectShellExecutor } from '../src/sandbox/shell-executor.js';
import { createShellScratch } from '../src/sandbox/shell-scratch.js';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-shell-exec-'));
process.env.SANDBOX_ROOT = TEST_ROOT;

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

const main = async (): Promise<void> => {
  await test('selectShellExecutor：darwin → macos-seatbelt（与 gate 无关）', () => {
    assert.equal(
      selectShellExecutor('darwin', { PAYASO_SHELL_WINDOWS_ACL: '1' }),
      'macos-seatbelt',
    );
    assert.equal(selectShellExecutor('darwin', {}), 'macos-seatbelt');
  });

  await test('selectShellExecutor：win32 gate 开 → windows-acl；gate 关 → uncontained-gated', () => {
    assert.equal(selectShellExecutor('win32', { PAYASO_SHELL_WINDOWS_ACL: '1' }), 'windows-acl');
    assert.equal(selectShellExecutor('win32', {}), 'uncontained-gated');
    assert.equal(
      selectShellExecutor('win32', { PAYASO_SHELL_WINDOWS_ACL: '0' }),
      'uncontained-gated',
    );
  });

  await test('selectShellExecutor：linux → uncontained-gated（Linux 沙箱另行实施）', () => {
    assert.equal(selectShellExecutor('linux', {}), 'uncontained-gated');
  });

  await test('win32 gate 关：未设 PAYASO_SHELL_UNSANDBOXED → 拒绝文案不变（fail-closed）', async () => {
    const scratch = createShellScratch('gate-off');
    try {
      await assert.rejects(
        executeShellCommand({
          command: 'echo hi',
          workspaceRoot: TEST_ROOT,
          permissionMode: 'workspace-write',
          scratch,
          timeoutMs: 5_000,
          platform: 'win32',
        }),
        /PAYASO_SHELL_UNSANDBOXED/,
      );
    } finally {
      scratch.dispose();
    }
  });

  await test('win32 gate 开：runner 失败（非 win32 无 kernel32）→ fail-closed 结构化错误，命令未执行', async () => {
    const previous = process.env.PAYASO_SHELL_WINDOWS_ACL;
    process.env.PAYASO_SHELL_WINDOWS_ACL = '1';
    const scratch = createShellScratch('gate-on');
    try {
      await assert.rejects(
        executeShellCommand({
          command: 'echo must-not-run',
          workspaceRoot: TEST_ROOT,
          permissionMode: 'workspace-write',
          scratch,
          timeoutMs: 30_000,
          platform: 'win32',
        }),
        /Windows ACL sandbox runner failed; the command was not executed/,
      );
    } finally {
      scratch.dispose();
      if (previous === undefined) delete process.env.PAYASO_SHELL_WINDOWS_ACL;
      else process.env.PAYASO_SHELL_WINDOWS_ACL = previous;
    }
  });

  await test('macOS（真实 darwin）：结果附 executor/enforcement 元数据（前提：sandbox-exec 可用）', async () => {
    const { probeSandboxAvailability } = await import('../src/sandbox/macos-sandbox.js');
    if (process.platform !== 'darwin' || !(await probeSandboxAvailability())) {
      console.log('  [SKIP] 当前环境 sandbox-exec 不可用（行为回归由 os-sandbox 套件覆盖）');
      return;
    }
    const scratch = createShellScratch('darwin-meta');
    const events: unknown[] = [];
    try {
      const result = await executeShellCommand({
        command: 'pwd',
        workspaceRoot: TEST_ROOT,
        permissionMode: 'workspace-write',
        scratch,
        timeoutMs: 15_000,
        onSandboxEvent: (event) => events.push(event),
      });
      assert.equal(result.executor, 'macos-seatbelt');
      assert.equal(result.enforcement, 'full');
      assert.equal(result.exitCode, 0);
      // macOS 事件形状锁定（os-sandbox deepEqual 探针同款）：不得携带 enforcement 等新字段
      assert.deepEqual(events, [{ type: 'shell_sandbox_started', platform: 'macos' }]);
    } finally {
      scratch.dispose();
    }
  });

  if (failed > 0) {
    console.error(`\nshell-executor 测试失败（${failed}）:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`shell-executor 测试完成：${passed} 通过 / ${failed} 失败`);
};

void main();
