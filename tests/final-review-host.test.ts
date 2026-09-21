// 真实 Host/Runtime + 固定 Provider 响应：检查调用无工具、只修正答复、用量可追踪。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../src/host/run-manager.js';
import { createDefaultRunStore } from '../src/host/persistence/sqlite-store.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { setWorkspace, clearWorkspace } from '../src/host/workspace.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-host-'));
process.env.PAYASO_HOME = path.join(root, 'home');
process.env.PAYASO_DB_PATH = path.join(root, 'store.db');
process.env.SANDBOX_ROOT = path.join(root, 'sandbox');
process.env.PAYASO_FINAL_REVIEW = '1';
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'notes.md'), '上线日期未确认。');
setWorkspace(workspace);
const original = globalThis.fetch;
const manager = new RunManager(createDefaultRunStore(new MemorySecretStore()));
try {
  for (const approve of [true, false]) {
    let calls = 0;
    globalThis.fetch = (async (_url, init) => {
      const req = JSON.parse(String(init?.body));
      calls++;
      const message = calls === 1
        ? { role: 'assistant', content: '', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read', arguments: '{"path":"notes.md"}' } }] }
        : { role: 'assistant', content: calls === 2 ? '明天上线。' : JSON.stringify(calls === 3
          ? { issues: ['原文未确认日期'], revisedAnswer: '上线日期尚未确认。' }
          : { issues: approve ? [] : ['仍未完成'], revisedAnswer: null }) };
      if (calls >= 3) assert.ok(!req.tools?.length, '检查阶段不得拥有工具');
      return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200 });
    }) as typeof fetch;
    const { runId, sessionId } = manager.createInSession('总结 notes.md 的上线日期');
    const deadline = Date.now() + 10000;
    while (manager.get(runId)?.status === 'running') {
      assert.ok(Date.now() < deadline);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const run = manager.get(runId)!;
    assert.equal(run.status, approve ? 'completed' : 'failed');
    assert.equal(calls, 4);
    assert.equal(fs.readFileSync(path.join(workspace, 'notes.md'), 'utf8'), '上线日期未确认。');
    const events = manager.listRunEvents(runId)!;
    assert.equal(events.filter(e => e.type === 'llm_call' && e.purpose === 'final_review').length, 2);
    if (approve) assert.equal(run.result, '上线日期尚未确认。');
    else assert.ok(!events.some(e => e.type === 'final_answer' || e.type === 'run_completed'));
    if (!approve) {
      let inherited = '';
      globalThis.fetch = (async (_url, init) => {
        inherited = String(init?.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '收到' } }] }), { status: 200 });
      }) as typeof fetch;
      const next = manager.createInSession('继续', sessionId);
      while (manager.get(next.runId)?.status === 'running') {
        assert.ok(Date.now() < deadline);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(!inherited.includes('明天上线'), '被拒绝的草稿不能成为下一轮已完成事实');
      assert.match(inherited, /上一轮交付未通过验证/);
    }
  }
  console.log('Final review Host: 2 PASS');
} finally {
  manager.close(); clearWorkspace(); globalThis.fetch = original;
  fs.rmSync(root, { recursive: true, force: true });
}
