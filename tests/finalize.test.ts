// Deterministic atomic run finalization tests (v1.6):
// terminal Run status + terminal event 必须在同一 SQLite 事务内提交；
// 重复 finish 幂等；持久化失败不广播终态；SSE 严格在 durable commit 之后。
// 故障注入使用 SQLite TRIGGER（RAISE ABORT），不污染生产代码、非 flaky。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDefaultRunStore, SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import type { SseSink } from '../src/host/run-manager.js';
import { RunManager } from '../src/host/run-manager.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { canonicalizeWorkspaceRoot, createWorkspace } from '../src/sandbox/sandbox-manager.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-finalize-'));
process.env.SANDBOX_ROOT = ROOT;
fs.mkdirSync(ROOT, { recursive: true });

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const originalFetch = globalThis.fetch;

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
  });
}
function sinkOf(chunks: string[]): SseSink {
  return { write: (c) => chunks.push(c), end: () => {}, closed: () => false };
}
function terminalCount(chunks: string[], type: string): number {
  return chunks.filter((c) => c.includes(`event: ${type}`)).length;
}
function seedWorkspace(runId: string): string {
  return canonicalizeWorkspaceRoot(createWorkspace(runId));
}

try {
  // ---- Case 1 + 11 + 12: completed 原子成功 + 重建读取一致 + 非终态事件不受影响 ----
  {
    const dbPath = path.join(ROOT, 'completed.db');
    process.env.PAYASO_DB_PATH = dbPath;
    const store = createDefaultRunStore(new MemorySecretStore());
    const manager = new RunManager(store);
    seedWorkspace('fz-c1');
    globalThis.fetch = (async () => okResponse('final-answer')) as typeof fetch;

    const runId = manager.create('c1');
    await waitFor(() => manager.get(runId)?.status === 'completed');

    const persisted = store.getRun(runId);
    const events = store.listEvents(runId).map((e) => e.event);
    check('Case1: status persisted as completed', persisted?.status === 'completed');
    check(
      'Case1: exactly one run_completed event',
      events.filter((e) => e.type === 'run_completed').length === 1,
    );
    check(
      'Case12: non-terminal events preserved (run_started/llm_call/context_usage)',
      events.some((e) => e.type === 'run_started') &&
        events.some((e) => e.type === 'llm_call') &&
        events.some((e) => e.type === 'context_usage'),
    );
    check(
      'Case12: exactly one terminal event among them',
      events.filter((e) => ['run_completed', 'run_failed', 'run_stopped'].includes(e.type))
        .length === 1,
    );

    // Case 11: 重建 Store 后历史一致（terminal status ⇔ terminal event 同时存在）
    manager.close();
    const reopened = new SqliteRunStore(dbPath, new MemorySecretStore());
    check('Case11: reload keeps terminal status', reopened.getRun(runId)?.status === 'completed');
    check(
      'Case11: reload keeps terminal event',
      reopened.listEvents(runId).some((e) => e.event.type === 'run_completed'),
    );
    reopened.close();
    cleanupDb(dbPath);
  }

  // ---- Case 2: failed 原子成功 ----
  {
    const dbPath = path.join(ROOT, 'failed.db');
    process.env.PAYASO_DB_PATH = dbPath;
    const store = createDefaultRunStore(new MemorySecretStore());
    const manager = new RunManager(store);
    seedWorkspace('fz-c2');
    globalThis.fetch = (async () => {
      throw new Error('injected-failure');
    }) as typeof fetch;

    const runId = manager.create('c2');
    await waitFor(() => manager.get(runId)?.status === 'failed');

    check('Case2: status persisted as failed', store.getRun(runId)?.status === 'failed');
    check(
      'Case2: exactly one run_failed event',
      store.listEvents(runId).filter((e) => e.event.type === 'run_failed').length === 1,
    );
    manager.close();
    cleanupDb(dbPath);
  }

  // ---- Case 3 + 8: stopping → stopped 原子成功；stop 竞态/重复 stop 幂等 ----
  {
    const dbPath = path.join(ROOT, 'stopped.db');
    process.env.PAYASO_DB_PATH = dbPath;
    const store = createDefaultRunStore(new MemorySecretStore());
    const manager = new RunManager(store);
    seedWorkspace('fz-c3');
    const chunks: string[] = [];
    globalThis.fetch = (async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      })) as typeof fetch;

    const runId = manager.create('c3');
    manager.subscribe(runId, sinkOf(chunks));
    await waitFor(() => manager.get(runId)?.status === 'running');

    assert.equal(manager.stop(runId), true);
    assert.equal(manager.get(runId)?.status, 'stopping');
    manager.stop(runId); // 竞态：立刻再次 stop（幂等）
    await waitFor(() => manager.get(runId)?.status === 'stopped');

    check('Case3: status persisted as stopped', store.getRun(runId)?.status === 'stopped');
    check(
      'Case3: exactly one run_stopped event',
      store.listEvents(runId).filter((e) => e.event.type === 'run_stopped').length === 1,
    );
    check(
      'Case3: run_stopping 与 run_stopped 分离（stopping 非终态混写）',
      store.listEvents(runId).filter((e) => e.event.type === 'run_stopping').length === 1,
    );
    check(
      'Case8: SSE 只广播一次 run_stopped（重复 stop 不重复发布）',
      terminalCount(chunks, 'run_stopped') === 1,
      `chunks=${chunks.filter((c) => c.includes('event: run_')).length}`,
    );
    check(
      'Case8: 无 completed/failed 混入',
      terminalCount(chunks, 'run_completed') === 0 && terminalCount(chunks, 'run_failed') === 0,
    );
    manager.close();
    cleanupDb(dbPath);
  }

  // ---- Case 6 + 7: 已终态后重复/冲突 finish → no-op ----
  {
    const dbPath = path.join(ROOT, 'idempotent.db');
    process.env.PAYASO_DB_PATH = dbPath;
    const store = createDefaultRunStore(new MemorySecretStore());
    const manager = new RunManager(store);
    seedWorkspace('fz-c6');
    const chunks: string[] = [];
    globalThis.fetch = (async () => okResponse('done')) as typeof fetch;

    const runId = manager.create('c6');
    manager.subscribe(runId, sinkOf(chunks));
    await waitFor(() => manager.get(runId)?.status === 'completed');

    manager.stop(runId); // Case 7: completed 之后 stop（冲突终态）→ 必须被拒绝
    manager.stop(runId); // Case 6: 重复调用
    await new Promise((r) => setTimeout(r, 100));

    check('Case7: completed 不可被覆盖为 stopped', manager.get(runId)?.status === 'completed');
    check(
      'Case7: 不产生 run_stopped',
      store.listEvents(runId).filter((e) => e.event.type === 'run_stopped').length === 0,
    );
    check(
      'Case6: 终态事件仍恰好一次',
      store.listEvents(runId).filter((e) => e.event.type === 'run_completed').length === 1,
    );
    check('Case6: SSE 终态广播仍恰好一次', terminalCount(chunks, 'run_completed') === 1);
    manager.close();
    cleanupDb(dbPath);
  }

  // ---- Case 9: SSE 严格发生在 durable commit 之后 ----
  {
    const dbPath = path.join(ROOT, 'ordering.db');
    process.env.PAYASO_DB_PATH = dbPath;
    const store = createDefaultRunStore(new MemorySecretStore());
    const manager = new RunManager(store);
    seedWorkspace('fz-c9');
    let statusAtBroadcast: string | null = null;
    globalThis.fetch = (async () => okResponse('ordered')) as typeof fetch;

    const runId = manager.create('c9');
    const chunks9: string[] = [];
    manager.subscribe(runId, {
      write: (chunk) => {
        // 收到终态 SSE 的瞬间同步读库：此时事务必须已经 COMMIT
        if (chunk.includes('event: run_completed')) {
          statusAtBroadcast = store.getRun(runId)?.status ?? null;
        }
        chunks9.push(chunk);
      },
      end: () => {},
      closed: () => false,
    });
    await waitFor(() => manager.get(runId)?.status === 'completed');

    check(
      'Case9: at SSE broadcast time the DB commit already happened',
      statusAtBroadcast === 'completed',
      `got ${statusAtBroadcast}`,
    );
    check(
      'Case9: run_completed SSE delivered exactly once',
      terminalCount(chunks9, 'run_completed') === 1,
    );
    manager.close();
    cleanupDb(dbPath);
  }

  // ---- Case 4 + 5 + 10: 事务失败注入（SQLite TRIGGER）→ rollback / 不广播 ----
  {
    const dbPath = path.join(ROOT, 'injected.db');
    process.env.PAYASO_DB_PATH = dbPath;
    const store = createDefaultRunStore(new MemorySecretStore());
    const manager = new RunManager(store);
    seedWorkspace('fz-c10');
    const chunks: string[] = [];

    globalThis.fetch = (async () => okResponse('will-fail-to-persist')) as typeof fetch;
    const runId = manager.create('c10');
    manager.subscribe(runId, sinkOf(chunks));
    await waitFor(() => manager.get(runId)?.status === 'running');

    // 故障注入：阻止 terminal 事件插入（Case 4）—— 事务必须整体 ROLLBACK
    const inj = new DatabaseSync(dbPath);
    inj.exec(`
      CREATE TRIGGER block_terminal_event
      BEFORE INSERT ON events WHEN NEW.type LIKE 'run_%'
      BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;
    `);
    inj.close();

    // 等 agent 完成 LLM 调用并触发 finalize（会被 trigger 拒绝）
    await waitFor(() => {
      const n = (
        new DatabaseSync(dbPath)
          .prepare("SELECT COUNT(*) AS n FROM events WHERE type='llm_call'")
          .get() as { n: number }
      ).n;
      return n > 0;
    });
    await new Promise((r) => setTimeout(r, 400)); // finalize 尝试已完成（失败，已记日志）

    check(
      'Case10: terminal SSE NOT broadcast when finalization fails',
      terminalCount(chunks, 'run_completed') === 0,
    );
    check(
      'Case10: in-memory status stays non-terminal (no fake completion)',
      manager.get(runId)?.status === 'running',
      `status=${manager.get(runId)?.status}`,
    );
    const afterFail = new DatabaseSync(dbPath)
      .prepare('SELECT status FROM runs WHERE run_id = ?')
      .get(runId) as { status: string };
    check(
      'Case4: rolled back — Run row remains previous state',
      afterFail.status === 'running',
      afterFail.status,
    );
    const evCount = new DatabaseSync(dbPath)
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE type LIKE 'run_%' AND type != 'run_started' AND type != 'run_stopping'",
      )
      .get() as { n: number };
    check('Case4: no terminal event inserted', evCount.n === 0, `n=${evCount.n}`);

    // 解除注入 → 经由同一条原子接口重试终态（store 层直接验证事务恢复正常）
    new DatabaseSync(dbPath).exec('DROP TRIGGER IF EXISTS block_terminal_event');
    store.finalizeRun(
      {
        ...store.getRun(runId)!,
        status: 'completed',
        updatedAt: new Date().toISOString(),
        result: 'late-finalize',
      },
      { type: 'run_completed', runId, timestamp: new Date().toISOString() },
    );
    check(
      'Case4: after fault removed, finalization succeeds atomically',
      store.getRun(runId)?.status === 'completed' &&
        store.listEvents(runId).filter((e) => e.event.type === 'run_completed').length === 1,
    );
    manager.close();
    cleanupDb(dbPath);

    // Case 5: UPDATE 失败 → 事件不插入
    const db5 = path.join(ROOT, 'injected-update.db');
    process.env.PAYASO_DB_PATH = db5;
    const store5 = new SqliteRunStore(db5, new MemorySecretStore());
    const sessionId = 's-finalize-5';
    store5.createSession({
      sessionId,
      title: 't',
      workspaceRoot: '/tmp/x',
      workspaceName: 'w',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    store5.createRun({
      runId: 'r-finalize-5',
      sessionId,
      turnIndex: 1,
      task: 't',
      status: 'running',
      workspaceRoot: '/tmp/x',
      workspaceName: 'w',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    const inj5 = new DatabaseSync(db5);
    inj5.exec(`
      CREATE TRIGGER block_run_update
      BEFORE UPDATE ON runs WHEN NEW.status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'injected update failure'); END;
    `);
    inj5.close();
    assert.throws(() =>
      store5.finalizeRun(
        {
          runId: 'r-finalize-5',
          sessionId,
          turnIndex: 1,
          task: 't',
          status: 'completed',
          workspaceRoot: '/tmp/x',
          workspaceName: 'w',
          createdAt: '2026-08-30T00:00:00.000Z',
          updatedAt: '2026-08-30T00:01:00.000Z',
          result: 'r',
        },
        { type: 'run_completed', runId: 'r-finalize-5', timestamp: '2026-08-30T00:01:00.000Z' },
      ),
    );
    check(
      'Case5: run update failure → no terminal event inserted',
      (new DatabaseSync(db5).prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number })
        .n === 0,
    );
    check(
      'Case5: run status unchanged',
      (
        new DatabaseSync(db5)
          .prepare("SELECT status FROM runs WHERE run_id='r-finalize-5'")
          .get() as { status: string }
      ).status === 'running',
    );
    store5.close();
    cleanupDb(dbPath);
    cleanupDb(db5);
  }

  function cleanupDb(dbPath: string): void {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\nFinalize tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
