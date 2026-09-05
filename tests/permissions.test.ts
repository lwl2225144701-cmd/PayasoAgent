import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute, getSchemas, type ToolContext } from '../src/tools/tools.js';
import '../src/tools/filesystem.js';
import '../src/tools/runtime-tools.js';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-permissions-'));
const workspace = path.join(root, 'workspace');
const outside = path.join(root, 'outside');
fs.mkdirSync(workspace);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(workspace, 'inside.txt'), 'inside', 'utf8');
fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside', 'utf8');

const context = (permissionMode: ToolContext['permissionMode']): ToolContext => ({
  runId: 'permission-test',
  workspaceRoot: workspace,
  permissionMode,
});

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}: ${(err as Error).message}`);
  }
}

try {
  await test('permissionMode is runtime-only and absent from Tool Schema', () => {
    assert.ok(!JSON.stringify(getSchemas()).includes('permissionMode'));
  });

  await test('Read Only can read inside Workspace', async () => {
    assert.equal(await execute('read', { path: 'inside.txt' }, context('read-only')), 'inside');
  });

  await test('Read Only rejects write/create/move/delete', async () => {
    const ctx = context('read-only');
    await assert.rejects(
      () => execute('write', { path: 'new.txt', content: 'x' }, ctx),
      /Read Only/,
    );
    await assert.rejects(() => execute('createDir', { path: 'new-dir' }, ctx), /Read Only/);
    await assert.rejects(
      () => execute('moveFile', { source: 'inside.txt', target: 'moved.txt' }, ctx),
      /Read Only/,
    );
    await assert.rejects(() => execute('deleteFile', { path: 'inside.txt' }, ctx), /Read Only/);
    assert.equal(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8'), 'inside');
  });

  await test('Workspace Write modifies Workspace', async () => {
    const ctx = context('workspace-write');
    await execute('write', { path: 'written.txt', content: 'written' }, ctx);
    assert.equal(fs.readFileSync(path.join(workspace, 'written.txt'), 'utf8'), 'written');
    await execute('deleteFile', { path: 'written.txt' }, ctx);
    assert.ok(!fs.existsSync(path.join(workspace, 'written.txt')));
  });

  await test('Workspace Write rejects absolute path outside Workspace', async () => {
    const target = path.join(outside, 'blocked.txt');
    await assert.rejects(
      () => execute('write', { path: target, content: 'blocked' }, context('workspace-write')),
      /路径被拒绝/,
    );
    assert.ok(!fs.existsSync(target));
  });

  await test('Full access reads and writes absolute host paths', async () => {
    const ctx = context('full-access');
    const existing = path.join(outside, 'outside.txt');
    assert.equal(await execute('read', { path: existing }, ctx), 'outside');
    const created = path.join(outside, 'created.txt');
    await execute('write', { path: created, content: 'full' }, ctx);
    assert.equal(fs.readFileSync(created, 'utf8'), 'full');
    await execute('deleteFile', { path: created }, ctx);
    assert.ok(!fs.existsSync(created));
  });

  await test('Run persistence keeps the permission snapshot', () => {
    const store = new SqliteRunStore(':memory:', new MemorySecretStore());
    const now = new Date().toISOString();
    try {
      store.createSession({
        sessionId: 'permission-session',
        title: 'permissions',
        workspaceRoot: workspace,
        workspaceName: 'workspace',
        createdAt: now,
        updatedAt: now,
      });
      store.createRun({
        runId: 'permission-run',
        sessionId: 'permission-session',
        turnIndex: 1,
        task: 'permissions',
        status: 'running',
        workspaceRoot: workspace,
        workspaceName: 'workspace',
        permissionMode: 'full-access',
        createdAt: now,
        updatedAt: now,
      });
      assert.equal(store.getRun('permission-run')?.permissionMode, 'full-access');
    } finally {
      store.close();
    }
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nPermission tests: ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
