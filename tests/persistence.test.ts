// Phase 2 deterministic persistence acceptance: SQLite CRUD/order/isolation,
// Host restart history, interrupted recovery, Workspace binding, manual resume.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import type { StoredRun, StoredSession } from '../src/host/persistence/store.js';
import type { StreamingEvent } from '../src/host/run-events.js';
import { RunManager } from '../src/host/run-manager.js';
import { clearWorkspace, setWorkspace } from '../src/host/workspace.js';
import { checkpointPath, saveCheckpoint } from '../src/persistence/file-checkpoint-store.js';
import { createScratchpad } from '../src/runtime/scratchpad.js';
import { createState } from '../src/runtime/state.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-persistence-'));
process.env.SANDBOX_ROOT = path.join(root, 'sandbox');
const workspace = path.join(root, 'workspace-A');
fs.mkdirSync(workspace, { recursive: true });
const canonicalWorkspace = fs.realpathSync.native(workspace);

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

function storedRun(runId: string, status: StoredRun['status'] = 'running'): StoredRun {
  return {
    runId,
    sessionId: `session-${runId}`,
    turnIndex: 1,
    task: `task-${runId}`,
    status,
    permissionMode: 'workspace-write',
    workspaceRoot: canonicalWorkspace,
    workspaceName: 'workspace-A',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for Run state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('RunStore CRUD persists status/result/workspace across reopen', () => {
  const dbPath = path.join(root, 'crud.db');
  const first = new SqliteRunStore(dbPath);
  const run = storedRun('crud-run');
  first.createRun(run);
  assert.deepEqual(first.getRun(run.runId), run);
  first.updateRun({
    ...run,
    status: 'completed',
    updatedAt: '2026-08-27T00:01:00.000Z',
    result: 'done',
  });
  first.close();

  const reopened = new SqliteRunStore(dbPath);
  const restored = reopened.getRun(run.runId);
  assert.equal(restored?.status, 'completed');
  assert.equal(restored?.result, 'done');
  assert.equal(restored?.workspaceRoot, canonicalWorkspace);
  assert.equal(restored?.workspaceName, 'workspace-A');
  assert.equal(reopened.listRuns().length, 1);
  reopened.close();
});

test('legacy Run-only database is migrated one Run per Session', () => {
  const dbPath = path.join(root, 'legacy.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      result TEXT,
      error TEXT
    );
  `);
  legacy
    .prepare(`
    INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      'legacy-run',
      'legacy task',
      'completed',
      canonicalWorkspace,
      'workspace-A',
      '2026-08-27T00:00:00.000Z',
      '2026-08-27T00:01:00.000Z',
      'done',
      null,
    );
  legacy.close();

  const migrated = new SqliteRunStore(dbPath);
  assert.equal(migrated.getRun('legacy-run')?.sessionId, 'legacy-run');
  assert.equal(migrated.getRun('legacy-run')?.turnIndex, 1);
  assert.equal(migrated.getSession('legacy-run')?.title, 'legacy task');
  assert.equal(migrated.listRunsBySession('legacy-run').length, 1);
  migrated.close();
});

test("pre-v1.6 runs table CHECK (no 'stopping') is rebuilt and accepts stopping", () => {
  const dbPath = path.join(root, 'old-check.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped', 'interrupted')),
      workspace_root TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      result TEXT,
      error TEXT,
      deleted_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id),
      UNIQUE (session_id, turn_index)
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
      UNIQUE (run_id, seq)
    );
    INSERT INTO sessions VALUES ('s-old', 'old session', '${canonicalWorkspace}', 'workspace-A', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', NULL);
    INSERT INTO runs VALUES ('r-old', 's-old', 1, 'old task', 'running', '${canonicalWorkspace}', 'workspace-A', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', NULL, NULL, NULL);
    INSERT INTO events (run_id, seq, type, timestamp, payload) VALUES ('r-old', 1, 'run_started', '2026-08-27T00:00:00.000Z', '{}');
  `);
  legacy.close();

  // 旧库打开即触发重建迁移；历史行、事件与外键必须完整保留
  const store = new SqliteRunStore(dbPath);
  const old = store.getRun('r-old');
  assert.equal(old?.status, 'running');
  assert.equal(store.listEvents('r-old').length, 1);

  // 迁移后的 CHECK 允许 stopping（v1.6 状态机），且回读一致
  store.updateRun({ ...old!, status: 'stopping' });
  assert.equal(store.getRun('r-old')?.status, 'stopping');
  assert.equal(store.listEvents('r-old').length, 1);

  // 重建后再打开仍然稳定（DDL 已是新版，幂等）
  store.close();
  const reopened = new SqliteRunStore(dbPath);
  assert.equal(reopened.getRun('r-old')?.status, 'stopping');
  reopened.close();
});

test('events retain per-Run sequence and never cross Run boundaries', () => {
  const store = new SqliteRunStore(path.join(root, 'events.db'));
  store.createRun(storedRun('run-A'));
  store.createRun(storedRun('run-B'));
  const at = '2026-08-27T00:00:00.000Z';
  assert.equal(
    store.appendEvent('run-A', { type: 'run_started', runId: 'run-A', timestamp: at }),
    1,
  );
  assert.equal(
    store.appendEvent('run-A', {
      type: 'run_completed',
      runId: 'run-A',
      timestamp: at,
      result: 'A',
    }),
    2,
  );
  assert.equal(
    store.appendEvent('run-A', { type: 'run_stopped', runId: 'run-A', timestamp: at }),
    3,
  );
  assert.equal(
    store.appendEvent('run-B', { type: 'run_started', runId: 'run-B', timestamp: at }),
    1,
  );
  assert.deepEqual(
    store.listEvents('run-A').map((item) => item.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    store.listEvents('run-A').map((item) => item.event.type),
    ['run_started', 'run_completed', 'run_stopped'],
  );
  assert.deepEqual(
    store.listEvents('run-B').map((item) => item.event.type),
    ['run_started'],
  );
  store.close();
});

test('completed Run metadata/result/events survive RunManager restart', async () => {
  const dbPath = path.join(root, 'manager-restart.db');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'persisted answer' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  setWorkspace(workspace);
  let runId = '';
  try {
    const hostA = new RunManager(new SqliteRunStore(dbPath));
    runId = hostA.create('persist me');
    await waitFor(() => hostA.get(runId)?.status === 'completed');
    assert.equal(hostA.get(runId)?.result, 'persisted answer');
    hostA.close();

    clearWorkspace();
    const hostB = new RunManager(new SqliteRunStore(dbPath));
    assert.ok(hostB.list().some((run) => run.runId === runId));
    assert.equal(hostB.get(runId)?.result, 'persisted answer');
    assert.deepEqual(hostB.get(runId)?.workspace, { name: 'workspace-A' });
    assert.equal(hostB.getWorkspaceRoot(runId), canonicalWorkspace);
    assert.ok(!JSON.stringify(hostB.get(runId)).includes(canonicalWorkspace));

    const chunks: string[] = [];
    assert.equal(
      hostB.subscribe(runId, {
        write: (chunk) => chunks.push(chunk),
        end: () => {},
        closed: () => false,
      }),
      true,
    );
    assert.ok(chunks.some((chunk) => chunk.includes('event: final_answer')));
    assert.ok(chunks.some((chunk) => chunk.includes('event: run_completed')));
    let replayEnded = false;
    assert.equal(
      hostB.subscribe(
        runId,
        {
          write: () => {},
          end: () => {
            replayEnded = true;
          },
          closed: () => false,
        },
        0,
        false,
      ),
      true,
    );
    assert.equal(replayEnded, true);
    hostB.close();
  } finally {
    globalThis.fetch = originalFetch;
    clearWorkspace();
    if (runId) fs.rmSync(checkpointPath(runId), { force: true });
  }
});

test('startup marks persisted running Run interrupted without auto-resume', () => {
  const dbPath = path.join(root, 'interrupted.db');
  const seed = new SqliteRunStore(dbPath);
  seed.createRun(storedRun('interrupted-run'));
  seed.appendEvent('interrupted-run', {
    type: 'run_started',
    runId: 'interrupted-run',
    timestamp: '2026-08-27T00:00:00.000Z',
  });
  seed.close();

  const manager = new RunManager(new SqliteRunStore(dbPath));
  assert.equal(manager.get('interrupted-run')?.status, 'interrupted');
  assert.match(manager.get('interrupted-run')?.error ?? '', /Host restarted/);
  const chunks: string[] = [];
  manager.subscribe('interrupted-run', {
    write: (chunk) => chunks.push(chunk),
    end: () => {},
    closed: () => false,
  });
  assert.ok(chunks.some((chunk) => chunk.includes('event: run_interrupted')));
  assert.equal(manager.getRaw('interrupted-run'), undefined);
  manager.close();
});

test('manual resume uses persisted Workspace and existing checkpoint', async () => {
  const runId = 'resume-persisted-run';
  const task = 'resume persisted';
  const dbPath = path.join(root, 'resume.db');
  const seed = new SqliteRunStore(dbPath);
  seed.createRun({ ...storedRun(runId), task });
  seed.close();
  saveCheckpoint({
    runId,
    task,
    status: 'running',
    iteration: 0,
    scratchpad: createScratchpad(task),
    messages: [{ role: 'user', content: task }],
    state: createState(task, runId),
    workspaceRoot: canonicalWorkspace,
    sideEffects: [],
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'resumed' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  try {
    const manager = new RunManager(new SqliteRunStore(dbPath));
    assert.equal(manager.get(runId)?.status, 'interrupted');
    assert.equal(manager.resume(runId), true);
    assert.equal(manager.getWorkspaceRoot(runId), canonicalWorkspace);
    await waitFor(() => manager.get(runId)?.status === 'completed');
    assert.equal(manager.get(runId)?.result, 'resumed');
    assert.deepEqual(manager.get(runId)?.workspace, { name: 'workspace-A' });
    manager.close();
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(checkpointPath(runId), { force: true });
  }
});

test('Session follow-up receives prior stable turns and keeps original Workspace', async () => {
  const dbPath = path.join(root, 'session-continuity.db');
  const workspaceB = path.join(root, 'workspace-B');
  fs.mkdirSync(workspaceB, { recursive: true });
  const requestBodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const answer = requestBodies.length === 1 ? 'first answer' : 'second answer';
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const runIds: string[] = [];
  try {
    setWorkspace(workspace);
    const manager = new RunManager(new SqliteRunStore(dbPath));
    const first = manager.createInSession('first question');
    runIds.push(first.runId);
    await waitFor(() => manager.get(first.runId)?.status === 'completed');

    setWorkspace(workspaceB);
    const second = manager.createInSession('follow up', first.sessionId);
    runIds.push(second.runId);
    await waitFor(() => manager.get(second.runId)?.status === 'completed');

    const sentMessages = requestBodies[1]?.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(sentMessages.slice(-3), [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'follow up' },
    ]);
    assert.equal(manager.getWorkspaceRoot(second.runId), canonicalWorkspace);
    assert.deepEqual(
      manager.listSessionRuns(first.sessionId)?.map((run) => run.turnIndex),
      [1, 2],
    );
    manager.close();

    const reopened = new RunManager(new SqliteRunStore(dbPath));
    assert.equal(reopened.listSessions().length, 1);
    assert.equal(reopened.listSessionRuns(first.sessionId)?.length, 2);
    reopened.close();
  } finally {
    globalThis.fetch = originalFetch;
    clearWorkspace();
    for (const runId of runIds) fs.rmSync(checkpointPath(runId), { force: true });
  }
});

test('streaming deltas are batched, persisted, and ordered before final events', async () => {
  const dbPath = path.join(root, 'stream-events.db');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  let runId = '';
  try {
    setWorkspace(workspace);
    const manager = new RunManager(new SqliteRunStore(dbPath));
    runId = manager.create('stream please');
    await waitFor(() => manager.get(runId)?.status === 'completed');
    manager.close();

    const reopened = new SqliteRunStore(dbPath);
    const events = reopened.listEvents(runId).map((item) => item.event);
    const deltaIndex = events.findIndex((event) => event.type === 'assistant_delta');
    const finalIndex = events.findIndex((event) => event.type === 'final_answer');
    assert.ok(deltaIndex >= 0 && finalIndex > deltaIndex);
    assert.equal(
      events
        .filter((event): event is StreamingEvent => event.type === 'assistant_delta')
        .map((event) => event.delta)
        .join(''),
      'hello',
    );
    assert.equal(reopened.getRun(runId)?.result, 'hello');
    reopened.close();
  } finally {
    globalThis.fetch = originalFetch;
    clearWorkspace();
    if (runId) fs.rmSync(checkpointPath(runId), { force: true });
  }
});

test('workspace group ops: rename sessions/runs label and delete cascades runs+events', () => {
  const dbPath = path.join(root, 'workspace-ops.db');
  const store = new SqliteRunStore(dbPath);
  const workspaceB = path.join(root, 'workspace-B');
  fs.mkdirSync(workspaceB, { recursive: true });
  const canonicalB = fs.realpathSync.native(workspaceB);

  const mkSession = (sid: string, name: string, workspaceRoot: string): StoredSession => ({
    sessionId: sid,
    title: `title-${sid}`,
    workspaceRoot,
    workspaceName: name,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  });
  store.createSession(mkSession('s1', 'Workspace-A', canonicalWorkspace));
  store.createSession(mkSession('s2', 'Workspace-A', canonicalWorkspace));
  store.createSession(mkSession('s3', 'Workspace-B', canonicalB));
  store.updateSession({
    ...mkSession('s2', 'Workspace-A', canonicalWorkspace),
    createdAt: '2026-08-27T00:30:00.000Z',
    updatedAt: '2026-08-27T01:00:00.000Z',
  });
  store.createRun({
    ...storedRun('r1'),
    sessionId: 's1',
    workspaceName: 'Workspace-A',
    workspaceRoot: canonicalWorkspace,
  });
  store.createRun({
    ...storedRun('r2'),
    sessionId: 's3',
    workspaceName: 'Workspace-B',
    workspaceRoot: canonicalB,
  });
  store.appendEvent('r1', {
    type: 'run_started',
    runId: 'r1',
    timestamp: '2026-08-27T00:00:00.000Z',
  });

  // 重命名：sessions + runs 的 workspace_name 一并更新
  const renamed = store.renameSessionsWorkspace('Workspace-A', 'renamed-A');
  assert.equal(renamed, 2);
  assert.equal(store.getSession('s1')?.workspaceName, 'renamed-A');
  assert.equal(store.getSession('s2')?.workspaceName, 'renamed-A');
  assert.equal(store.getRun('r1')?.workspaceName, 'renamed-A');

  // 按名字找最新会话（用于新会话绑定工作区）
  const found = store.findSessionByWorkspaceName('renamed-A');
  assert.equal(found?.sessionId, 's2');

  // 软删除工作区：按 canonical workspaceRoot 删除
  const deleted = store.softDeleteWorkspace(canonicalWorkspace, '2026-08-27T02:00:00.000Z');
  assert.equal(deleted, 2);
  assert.equal(
    store.getSession('s1', { includeDeleted: true })?.deletedAt,
    '2026-08-27T02:00:00.000Z',
  );
  assert.equal(
    store.getSession('s2', { includeDeleted: true })?.deletedAt,
    '2026-08-27T02:00:00.000Z',
  );
  assert.equal(store.getRun('r1', { includeDeleted: true })?.deletedAt, '2026-08-27T02:00:00.000Z');
  // 软删保留 events， purge 时才物理删除
  assert.equal(store.listEvents('r1').length, 1);
  assert.equal(store.getSession('s3')?.workspaceName, 'Workspace-B');

  store.close();
});

let passed = 0;
let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    passed++;
    console.log(`  PASS  ${item.name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${item.name}: ${(err as Error).stack ?? (err as Error).message}`);
  }
}

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* best effort */
}
console.log(`\nPersistence tests: ${passed} passed / ${failed} failed`);
if (failed) process.exitCode = 1;
