// macOS OS-level shell sandbox tests.
// These tests intentionally use absolute paths and shell indirection. They do
// not rely on the removed command-string blacklist; the filesystem outcome is
// the assertion.
//
// Capability-conditional: sandbox-exec is deprecated and on some macOS
// releases (e.g. macOS 26) it cannot apply any profile. When the primitive is
// unavailable, the shell tool must refuse to run (fail-closed) — we verify the
// refusal path instead of the containment matrix.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute, type ToolContext, type ToolSandboxEvent } from '../src/tools/tools.js';
import '../src/tools/runtime-tools.js';
import type { PermissionMode } from '../src/permission-mode.js';
import { probeSandboxAvailability } from '../src/sandbox/macos-sandbox.js';
import { cleanupWorkspace, createWorkspace } from '../src/sandbox/sandbox-manager.js';

if (process.platform !== 'darwin') {
  console.log('OS sandbox tests skipped: macOS only');
  process.exit(0);
}

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-os-sandbox-'));
process.env.SANDBOX_ROOT = TEST_ROOT;
const RUN = 'os-sandbox-test';
const root = createWorkspace(RUN);
const work = path.join(root, 'work');
const outside = path.join(TEST_ROOT, 'outside.txt');
const tmpOutside = path.join(os.tmpdir(), 'payaso-os-sandbox-' + process.pid + '.txt');

function shQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function shell(
  command: string,
  events?: ToolSandboxEvent[],
  permissionMode: PermissionMode = 'workspace-write',
): Promise<string> {
  return execute(
    'shell',
    { command },
    {
      runId: RUN,
      workspaceRoot: work,
      permissionMode,
      onSandboxEvent: events ? (event) => events.push(event) : undefined,
    },
  );
}

async function expectDenied(
  command: string,
  events?: ToolSandboxEvent[],
  permissionMode: PermissionMode = 'workspace-write',
): Promise<void> {
  await assert.rejects(
    () => shell(command, events, permissionMode),
    (err: unknown) =>
      err instanceof Error &&
      err.message === 'Shell operation denied by workspace sandbox.' &&
      !err.message.includes(TEST_ROOT) &&
      !err.message.includes(os.homedir()),
  );
}

// Containment matrix: only valid when the OS sandbox primitive actually works.
async function runMatrix(): Promise<void> {
  // Workspace operations: cwd, read, create, write, modify, and delete.
  const startEvents: ToolSandboxEvent[] = [];
  const pwd = await shell('pwd', startEvents);
  assert.match(pwd, /shell-exit-0/);
  assert.ok(pwd.includes(path.sep + 'work'), 'unexpected cwd output: ' + pwd);
  assert.deepEqual(startEvents, [{ type: 'shell_sandbox_started', platform: 'macos' }]);

  await shell('printf initial > inside.txt && mkdir nested && printf child > nested/file.txt');
  assert.equal(fs.readFileSync(path.join(work, 'inside.txt'), 'utf8'), 'initial');
  assert.equal(fs.readFileSync(path.join(work, 'nested', 'file.txt'), 'utf8'), 'child');

  await shell('printf modified > inside.txt && cat inside.txt');
  assert.equal(fs.readFileSync(path.join(work, 'inside.txt'), 'utf8'), 'modified');

  // A program created inside the workspace is executable; its child shell is
  // still confined to the same workspace policy.
  await shell(
    "printf '#!/bin/sh\\nprintf script > script-result.txt\\n' > script.sh && chmod +x script.sh && ./script.sh",
  );
  assert.equal(fs.readFileSync(path.join(work, 'script-result.txt'), 'utf8'), 'script');

  await shell('rm nested/file.txt inside.txt && rmdir nested');
  await shell('rm script.sh script-result.txt');
  assert.ok(!fs.existsSync(path.join(work, 'inside.txt')));
  assert.ok(!fs.existsSync(path.join(work, 'nested')));

  // Workspace sibling: absolute path write/delete must be denied by the OS.
  fs.writeFileSync(outside, 'keep', 'utf8');
  const deniedEvents: ToolSandboxEvent[] = [];
  await expectDenied('printf hacked > ' + shQuote(outside), deniedEvents);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  await expectDenied('cat ' + shQuote(outside));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  await expectDenied('rm -f ' + shQuote(outside));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.ok(deniedEvents.some((event) => event.type === 'shell_sandbox_denied'));

  // /tmp is intentionally not a writable root in this policy.
  fs.rmSync(tmpOutside, { force: true });
  await expectDenied('printf tmp > ' + shQuote(tmpOutside));
  assert.ok(!fs.existsSync(tmpOutside));

  // A child shell inherits the same OS sandbox; string indirection cannot escape.
  await expectDenied('sh -c ' + shQuote('printf child > ' + shQuote(outside)));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');

  // Read Only keeps Workspace readable but denies every write, including shell
  // redirection and writes from child processes.
  fs.writeFileSync(path.join(work, 'readonly.txt'), 'readable', 'utf8');
  const readOnlyResult = await shell('cat readonly.txt', undefined, 'read-only');
  assert.ok(readOnlyResult.includes('readable'));
  await expectDenied('printf changed > readonly.txt', undefined, 'read-only');
  await expectDenied(
    'sh -c ' + shQuote('printf child > child-readonly.txt'),
    undefined,
    'read-only',
  );
  assert.equal(fs.readFileSync(path.join(work, 'readonly.txt'), 'utf8'), 'readable');
  assert.ok(!fs.existsSync(path.join(work, 'child-readonly.txt')));

  // Full access lifts the filesystem boundary for the process tree while the
  // independent network policy remains deny (covered by shell-network.test.ts).
  const fullRead = await shell('cat ' + shQuote(outside), undefined, 'full-access');
  assert.ok(fullRead.includes('keep'));
  await shell(
    'sh -c ' + shQuote('printf full-child > ' + shQuote(outside)),
    undefined,
    'full-access',
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'full-child');
  fs.writeFileSync(outside, 'keep', 'utf8');

  console.log('macOS OS sandbox tests: PASS');
  console.log('  workspace read/write/create/delete: PASS');
  console.log('  workspace-external absolute read/write/delete: DENIED');
  console.log('  /tmp write: DENIED');
  console.log('  child shell inheritance: DENIED');
  console.log('  read-only workspace writes: DENIED');
  console.log('  full-access host filesystem: ALLOWED');
}

try {
  if (!(await probeSandboxAvailability())) {
    // Fail-closed: shell must refuse rather than run unsandboxed.
    let refused = false;
    try {
      await shell('pwd');
    } catch (err) {
      refused = err instanceof Error && /unavailable/i.test(err.message);
    }
    assert.ok(
      refused,
      'shell 应在 sandbox-exec 不可用时拒绝执行（fail-closed，绝不跑无沙箱 shell）',
    );
    console.log('macOS OS sandbox tests: SKIPPED — sandbox-exec 无法应用（该 macOS/受限环境）');
    console.log('  fail-closed check: shell refused, no unsandboxed run: PASS');
  } else {
    await runMatrix();
  }
} finally {
  fs.rmSync(tmpOutside, { force: true });
  cleanupWorkspace(RUN);
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
}
