import assert from 'node:assert/strict';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import { RunManager } from '../src/host/run-manager.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';

const store = new SqliteRunStore(':memory:', new MemorySecretStore());
const manager = new RunManager(store);

try {
  const provider = store.addModelProvider({
    name: 'Selection Test Provider',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'sk-selection-test',
    models: ['model-a', 'model-b'],
    modelCapabilities: { 'model-b': { contextWindow: 128_000 } },
  });

  const selected = manager.createInSession('uses model b', undefined, {
    startAgent: false,
    providerId: provider.id,
    model: 'model-b',
  });
  const run = manager.get(selected.runId);
  assert.equal(run?.providerId, provider.id);
  assert.equal(run?.model, 'model-b');

  assert.throws(
    () =>
      manager.createInSession('rejects unknown model', undefined, {
        startAgent: false,
        providerId: provider.id,
        model: 'model-missing',
      }),
    /not in provider catalog/,
  );
  assert.equal(store.listSessions().length, 1);
  console.log('Model selection tests: 3 passed / 0 failed');
} finally {
  store.close();
}
