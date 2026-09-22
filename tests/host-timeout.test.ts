// Deterministic Host timeout test (no real network / LLM).
// 两个不变量：
//   1. 挂死的模型请求由 LLM 层连接超时兜底并落 failed，而不是留下无界 Run。
//      （docs/plans/long-task-timeout-plan.md 步骤 2：超时由阻塞层负责。）
//   2. Host 不再有固定总运行时限：旧 AGENT_RUN_TIMEOUT_MS 保险丝已删除，
//      运行时间超过该值的正常 Run 必须完整跑完、正常 completed。
//      （步骤 6；这也是"活跃 Run 超过旧时限仍可执行"的确定性代理验证。）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import { RunManager } from '../src/host/run-manager.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { checkpointPath } from '../src/persistence/file-checkpoint-store.js';
import { register, type ToolContext } from '../src/tools/tools.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-host-timeout-'));
process.env.SANDBOX_ROOT = root;
// 低于 LLM 超时策略下限（1s）的值会被收敛——既验证 fail-closed 下限，也保证用例快速。
const previousConnect = process.env.PAYASO_LLM_CONNECT_TIMEOUT_MS;
process.env.PAYASO_LLM_CONNECT_TIMEOUT_MS = '500';
const previousRunTimeout = process.env.AGENT_RUN_TIMEOUT_MS;

// 慢工具：真实占用 200ms —— 远超旧保险丝（20ms），用于证明它不再截断 Run。
register({
  name: 'host-timeout-slow-probe',
  description: 'deterministic slow probe for Host timeout tests',
  effect: 'read',
  parameters: { type: 'object', properties: {} },
  execute: async (_args: Record<string, unknown>, _context: ToolContext) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return 'slow-ok';
  },
});

const originalFetch = globalThis.fetch;
const store = new SqliteRunStore(':memory:', new MemorySecretStore());
const manager = new RunManager(store);
const createdRunIds: string[] = [];
const provider = store.addModelProvider({
  name: 'timeout-provider',
  baseUrl: 'https://provider.example/v1',
  apiKey: 'sk-timeout',
  models: ['timeout-model'],
});

let fetchCalls = 0;
function jsonResponse(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function waitForTerminal(runId: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const status = manager.get(runId)?.status;
    if (status === 'completed' || status === 'failed' || status === 'stopped') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Host timeout test did not finalize: ${manager.get(runId)?.status}`);
}

try {
  // ---- 1. 连接挂死 → LLM 层连接超时兜底，Run 落 failed（不重试） ----
  globalThis.fetch = (async (_input, init) => {
    fetchCalls++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    });
  }) as typeof fetch;
  {
    const { runId } = manager.createInSession('hanging model request', undefined, {
      providerId: provider.id,
      model: 'timeout-model',
    });
    createdRunIds.push(runId);
    await waitForTerminal(runId);
    const run = manager.get(runId);
    assert.equal(fetchCalls, 1);
    assert.equal(run?.status, 'failed');
    assert.match(run?.error ?? '', /LLM request timed out/);
    assert.ok(store.listEvents(runId).some((item) => item.event.type === 'run_failed'));
  }

  // ---- 2. 旧 AGENT_RUN_TIMEOUT_MS 保险丝已删除：超过它的 Run 正常完成 ----
  {
    process.env.AGENT_RUN_TIMEOUT_MS = '20';
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? jsonResponse({
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'slow-1',
                type: 'function',
                function: { name: 'host-timeout-slow-probe', arguments: '{}' },
              },
            ],
          })
        : jsonResponse({ role: 'assistant', content: 'long-run-done' });
    }) as typeof fetch;

    const started = Date.now();
    const { runId } = manager.createInSession('run longer than the legacy fuse', undefined, {
      providerId: provider.id,
      model: 'timeout-model',
    });
    createdRunIds.push(runId);
    await waitForTerminal(runId);
    const elapsed = Date.now() - started;
    const run = manager.get(runId);
    assert.equal(run?.status, 'completed', `Run 不应被已删除的旧保险丝截断: ${run?.error ?? ''}`);
    assert.ok(elapsed >= 200, `Run 必须真实跑过 200ms 工具耗时: ${elapsed}ms`);
    assert.equal(calls, 2, '工具轮 + 最终答案');
    assert.ok(store.listEvents(runId).some((item) => item.event.type === 'run_completed'));
  }
} finally {
  await manager.close();
  globalThis.fetch = originalFetch;
  for (const id of createdRunIds) fs.rmSync(checkpointPath(id), { force: true });
  if (previousConnect === undefined) delete process.env.PAYASO_LLM_CONNECT_TIMEOUT_MS;
  else process.env.PAYASO_LLM_CONNECT_TIMEOUT_MS = previousConnect;
  if (previousRunTimeout === undefined) delete process.env.AGENT_RUN_TIMEOUT_MS;
  else process.env.AGENT_RUN_TIMEOUT_MS = previousRunTimeout;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Host timeout tests: PASS');
