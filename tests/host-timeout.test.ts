// Deterministic Host resource-fuse test (no real network / LLM).
// A hanging model request must be aborted by the Host timeout and finalized
// as failed, rather than leaving an unbounded Runtime Run alive forever.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import { RunManager } from '../src/host/run-manager.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { checkpointPath } from '../src/persistence/file-checkpoint-store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-host-timeout-'));
process.env.SANDBOX_ROOT = root;
const previousTimeout = process.env.AGENT_RUN_TIMEOUT_MS;
process.env.AGENT_RUN_TIMEOUT_MS = '20';

const originalFetch = globalThis.fetch;
const store = new SqliteRunStore(':memory:', new MemorySecretStore());
const manager = new RunManager(store);
let createdRunId: string | undefined;
const provider = store.addModelProvider({
  name: 'timeout-provider',
  baseUrl: 'https://provider.example/v1',
  apiKey: 'sk-timeout',
  models: ['timeout-model'],
});

let fetchCalls = 0;
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

async function waitForTerminal(runId: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const status = manager.get(runId)?.status;
    if (status === 'completed' || status === 'failed' || status === 'stopped') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Host timeout test did not finalize: ${manager.get(runId)?.status}`);
}

try {
  const { runId } = manager.createInSession('hanging model request', undefined, {
    providerId: provider.id,
    model: 'timeout-model',
  });
  createdRunId = runId;
  await waitForTerminal(runId);
  const run = manager.get(runId);
  assert.equal(fetchCalls, 1);
  assert.equal(run?.status, 'failed');
  assert.match(run?.error ?? '', /Run exceeded host time limit of 20ms/);
  assert.ok(store.listEvents(runId).some((item) => item.event.type === 'run_failed'));
} finally {
  await manager.close();
  globalThis.fetch = originalFetch;
  if (createdRunId) fs.rmSync(checkpointPath(createdRunId), { force: true });
  if (previousTimeout === undefined) delete process.env.AGENT_RUN_TIMEOUT_MS;
  else process.env.AGENT_RUN_TIMEOUT_MS = previousTimeout;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Host timeout tests: PASS');
