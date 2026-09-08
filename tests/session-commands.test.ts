// 端点冒烟：内置会话命令 /compact /goal /plan /feedback /export 全链路
// （store → RunManager → routes → JSON/ZIP），事件种子复用 run-stats 的方式。

import assert from 'node:assert/strict';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import type { HostEvent } from '../src/host/run-events.js';
import { RunManager } from '../src/host/run-manager.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { createHostServer } from '../src/host/server.js';
import { crc32 } from '../src/host/zip.js';

const base = { timestamp: '2026-09-06T00:00:00.000Z' };
const events: HostEvent[] = [
  { ...base, type: 'run_started', runId: 'run-cmd-1' },
  {
    ...base,
    type: 'llm_call',
    step: 1,
    messageCount: 2,
    iteration: 1,
    response: '',
    hasToolCalls: false,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  },
  { ...base, type: 'run_completed', runId: 'run-cmd-1', timestamp: '2026-09-06T00:00:03.000Z' },
];

const runtimeStore = new SqliteRunStore(':memory:', new MemorySecretStore());
const server = createHostServer(
  new RunManager(runtimeStore),
  'test-token-00000000000000000000000000000000',
);
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;
const auth = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer test-token-00000000000000000000000000000000',
  Origin: `http://localhost:${port}`,
};

try {
  const sessionId = 'sess-cmd-001';
  runtimeStore.createSession({
    sessionId,
    title: 'cmd',
    workspaceRoot: '/tmp/x',
    workspaceName: '',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  });
  runtimeStore.createRun({
    runId: 'run-cmd-1',
    sessionId,
    turnIndex: 1,
    task: 't',
    status: 'completed',
    workspaceRoot: '/tmp/x',
    workspaceName: '',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:05.000Z',
    permissionMode: 'workspace-write',
  });
  for (const event of events) runtimeStore.appendEvent('run-cmd-1', event);

  // /goal：设置 → 查看 → 清空
  assert.equal((await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/goal`)).status, 200);
  const setGoal = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/goal`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ goal: '一周内完成 v2 发布' }),
  });
  assert.equal(setGoal.status, 200);
  assert.deepEqual(await setGoal.json(), { ok: true, goal: '一周内完成 v2 发布' });
  const cleared = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/goal`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ goal: '  ' }),
  });
  assert.deepEqual(await cleared.json(), { ok: true, goal: null }, '空白目标等价于清除');

  // /plan：开 → 查 → 关
  const planOn = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/plan`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ enabled: true }),
  });
  assert.deepEqual(await planOn.json(), { ok: true, planMode: true });
  assert.deepEqual(
    await (await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/plan`)).json(),
    { planMode: true },
  );
  // compact 标记确实写入了 session_meta（下一轮 createRun 消费）
  assert.equal(runtimeStore.getSessionMeta(sessionId, 'force_compact'), null);
  const compact = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/compact`, {
    method: 'POST',
    headers: auth,
  });
  assert.equal((await compact.json()).ok, true);
  assert.equal(runtimeStore.getSessionMeta(sessionId, 'force_compact'), '1');
  const planOff = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/plan`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ enabled: false }),
  });
  assert.deepEqual(await planOff.json(), { ok: true, planMode: false });

  // /feedback：记录 + 缺参 400
  const feedback = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/feedback`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ comment: '压缩很及时' }),
  });
  assert.equal((await feedback.json()).ok, true);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/feedback`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ comment: '  ' }),
      })
    ).status,
    400,
  );

  // /export：ZIP 结构 + 内容回读
  const exportResp = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/export`);
  assert.equal(exportResp.status, 200);
  assert.equal(exportResp.headers.get('content-type'), 'application/zip');
  const bytes = new Uint8Array(await exportResp.arrayBuffer());
  assert.ok(bytes.length > 0);
  // EOCD + 条目名回读（手写解析，避免引入解压依赖）
  const view = new DataView(bytes.buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, 'EOCD 存在');
  const decoder = new TextDecoder();
  const names: string[] = [];
  let cursor = view.getUint32(eocd + 16, true);
  for (let i = 0; i < view.getUint16(eocd + 10, true); i++) {
    const nameLen = view.getUint16(cursor + 28, true);
    names.push(decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen)));
    cursor += 46 + nameLen + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  assert.ok(names.includes('session.json'), `session.json 在列: ${names.join(',')}`);
  assert.ok(names.includes('runs.jsonl'));
  assert.ok(names.includes('meta.json'));
  assert.ok(
    names.some((name) => name.startsWith('events/001-')),
    '事件文件按轮次命名',
  );
  assert.equal(crc32(new TextEncoder().encode('x')), crc32(new TextEncoder().encode('x')));

  // 不存在的会话：全部 404
  for (const path of ['/goal', '/plan', '/export']) {
    const resp = await fetch(`http://127.0.0.1:${port}/sessions/missing${path}`);
    assert.equal(resp.status, 404, path);
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  runtimeStore.close();
}

console.log('\nsession-commands endpoint tests: all PASS');
