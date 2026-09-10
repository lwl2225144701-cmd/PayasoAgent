// 模块: Run 事件快照端点（GET /runs/:id/events/snapshot）
// 覆盖：已终态 Run 的一次性事件取回 —— 内容、顺序、与 SSE 回放的一致性，
//       以及未知 Run / 未知子路径的 404 行为。
// 不依赖 LLM：直接向隔离的 SQLite 存储写入 Run + 事件，再走真实 HTTP。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostEvent } from '../src/host/run-events.js';
import { createHostServer, RunManager } from '../src/host/server.js';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import type { StoredRun, StoredSession } from '../src/host/persistence/store.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-run-events-'));
process.env.SANDBOX_ROOT = ROOT;
process.env.PAYASO_DB_PATH = path.join(ROOT, 'payaso.db');

const AT = '2026-09-10T00:00:00.000Z';
const SESSION_ID = 'session-snapshot';
const RUN_ID = 'run-snapshot';

const store = new SqliteRunStore(process.env.PAYASO_DB_PATH);
const session: StoredSession = {
  sessionId: SESSION_ID,
  title: '快照会话',
  workspaceRoot: ROOT,
  workspaceName: 'snapshot-ws',
  createdAt: AT,
  updatedAt: AT,
};
store.createSession(session);

const run: StoredRun = {
  runId: RUN_ID,
  sessionId: SESSION_ID,
  turnIndex: 1,
  task: '取回事件',
  status: 'completed',
  workspaceRoot: ROOT,
  workspaceName: 'snapshot-ws',
  permissionMode: 'workspace-write',
  createdAt: AT,
  updatedAt: AT,
  result: '最终答案',
};
store.createRun(run);

// 事件必须按 seq 落库；这里刻意混入流式增量，验证快照会保留全部事件而不做 SSE 式合并
// （合并是前端 mergeStreamingEvents 的职责，端点只负责忠实回放）。
const seeded: HostEvent[] = [
  { type: 'run_started', runId: RUN_ID, timestamp: AT, task: '取回事件' },
  { type: 'assistant_delta', runId: RUN_ID, timestamp: AT, messageId: 'm1', delta: '你' },
  { type: 'assistant_delta', runId: RUN_ID, timestamp: AT, messageId: 'm1', delta: '好' },
  { type: 'run_completed', runId: RUN_ID, timestamp: AT, result: '最终答案' },
] as HostEvent[];
for (const event of seeded) store.appendEvent(RUN_ID, event);

const manager = new RunManager(store);
const server = createHostServer(manager);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

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

try {
  // ---- 快照端点 ----
  const snapshotResp = await fetch(`${base}/runs/${RUN_ID}/events/snapshot`);
  const snapshotBody = (await snapshotResp.json()) as { events: HostEvent[] };
  check('GET /events/snapshot 返回 200', snapshotResp.status === 200);
  check(
    '快照返回全部事件且保持 seq 顺序',
    Array.isArray(snapshotBody.events) &&
      snapshotBody.events.length === seeded.length &&
      snapshotBody.events.every((ev, i) => ev.type === seeded[i]?.type),
    JSON.stringify(snapshotBody.events?.map((e) => e.type)),
  );
  check(
    '快照含终态事件（前端据此判定 Run 已结束）',
    snapshotBody.events?.some((ev) => ev.type === 'run_completed'),
  );
  check(
    '快照不做流式合并（内容原样，合并留给前端）',
    snapshotBody.events?.filter((ev) => ev.type === 'assistant_delta').length === 2,
  );

  // ---- 与 SSE 回放的一致性：两条取回路径必须给出同一份事件 ----
  const sseResp = await fetch(`${base}/runs/${RUN_ID}/events?live=0`);
  const sseText = await sseResp.text();
  check(
    'SSE 端点未被新子路径遮蔽（仍为 text/event-stream）',
    (sseResp.headers.get('content-type') ?? '').includes('text/event-stream'),
    sseResp.headers.get('content-type') ?? '',
  );
  const sseTypes = [...sseText.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  check(
    '快照与 SSE 回放事件序列一致',
    JSON.stringify(sseTypes) === JSON.stringify(seeded.map((ev) => ev.type)),
    JSON.stringify(sseTypes),
  );

  // ---- 边界：未知 Run / 未知子路径 ----
  const missing = await fetch(`${base}/runs/no-such-run/events/snapshot`);
  check('未知 Run → 404', missing.status === 404);

  const unknownSub = await fetch(`${base}/runs/${RUN_ID}/events/unknown`);
  check('events 下的未知子路径 → 404', unknownSub.status === 404);

  // ---- 会话删除后不再暴露事件（与 manager.get 同一套可见性判定） ----
  store.deleteSession(SESSION_ID);
  const afterDelete = await fetch(`${base}/runs/${RUN_ID}/events/snapshot`);
  check('会话已删除 → 快照 404', afterDelete.status === 404, String(afterDelete.status));
} finally {
  server.close();
  await manager.close();
}

console.log(`\nRun events snapshot tests: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exit(1);
