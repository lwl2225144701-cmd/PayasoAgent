// 使用固定模型响应验证真实 Host 生命周期；不调用外部 LLM。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultRunStore, SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { RunManager } from '../src/host/run-manager.js';
import { setWorkspace, clearWorkspace } from '../src/host/workspace.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'constraints-host-'));
process.env.PAYASO_HOME = path.join(root, 'home');
process.env.SANDBOX_ROOT = path.join(root, 'sandbox');
process.env.PAYASO_DB_PATH = path.join(root, 'runs.db');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'source.md'), '可信原文\n第二行');
setWorkspace(workspace);
const originalFetch = globalThis.fetch;
const store = createDefaultRunStore(new MemorySecretStore());
const manager = new RunManager(store);
const constraints = { evidence: { files: ['source.md'], items: ['要求'] } };
let answer = '';
let request = '';
globalThis.fetch = (async (_url, init) => {
  request = String(init?.body);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }), { status: 200 });
}) as typeof fetch;
async function finished(runId: string) {
  const deadline = Date.now() + 10000;
  while (manager.get(runId)?.status === 'running') {
    assert.ok(Date.now() < deadline, 'Host 未结束');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return manager.get(runId)!;
}
try {
  const before = store.listSessions().length;
  assert.throws(() => manager.createInSession('无效', undefined, {
    constraints: { writeScope: ['../outside'] },
  }));
  assert.equal(store.listSessions().length, before);
  console.log('[PASS] 无效约束不遗留会话');

  answer = '[{"item":0,"citations":[{"source":0,"start":1,"end":1}]}]';
  const good = manager.createInSession('摘录要求', undefined, { constraints, permissionMode: 'full-access' });
  const completed = await finished(good.runId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.permissionMode, 'read-only');
  assert.match(completed.result!, /可信原文/);
  const published = JSON.stringify(store.listEvents(good.runId));
  assert.ok(!published.includes('\\"citations\\"'));
  assert.ok(!store.listEvents(good.runId).some(e => e.event.type === 'final_answer'));
  assert.match(request, /source\.md/);
  console.log('[PASS] Host 固定只读、投影原文，公开事件不泄漏原始答案');

  answer = 'UNVERIFIED_INVENTED_FACT';
  const bad = manager.createInSession('再次摘录', good.sessionId, { constraints });
  const failed = await finished(bad.runId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result, undefined);
  assert.ok(!JSON.stringify(store.listEvents(bad.runId)).includes(answer));
  console.log('[PASS] 自由补写答复被拒绝，未发布未经核验内容');

  answer = '普通答复';
  const next = manager.createInSession('继续', good.sessionId);
  assert.equal((await finished(next.runId)).status, 'completed');
  assert.ok(!request.includes('UNVERIFIED_INVENTED_FACT'));
  assert.match(request, /可信原文/);
  console.log('[PASS] 后续会话继承核验结果，不继承被拒绝的模型答案');

  const scope = ['allowed.txt'];
  const saved = manager.createInSession('保存约束', undefined, { startAgent: false, constraints: { writeScope: scope } });
  scope.push('outside.txt');
  assert.deepEqual(store.getRun(saved.runId)?.constraints?.writeScope, ['allowed.txt']);
  manager.close();
  const reopened = new SqliteRunStore(process.env.PAYASO_DB_PATH, new MemorySecretStore());
  try {
    assert.deepEqual(reopened.getRun(saved.runId)?.constraints?.writeScope, ['allowed.txt']);
    assert.equal(reopened.getRun(good.runId)?.constraints?.evidence?.sources[0].sha256.length, 64);
  } finally { reopened.close(); }
  console.log('[PASS] 约束独立快照和来源版本在重开数据库后保留');
  console.log('汇总: 5 PASS / 0 FAIL');
} finally {
  manager.close();
  globalThis.fetch = originalFetch;
  clearWorkspace();
  fs.rmSync(root, { recursive: true, force: true });
}
