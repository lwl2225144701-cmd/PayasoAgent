// Runtime capability endpoint must expose only the path-free startup snapshot.

import assert from 'node:assert/strict';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import { RunManager } from '../src/host/run-manager.js';
import { createHostServer } from '../src/host/server.js';

const manager = new RunManager(new SqliteRunStore(':memory:'));
const server = createHostServer(manager);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

try {
  const response = await fetch(`http://127.0.0.1:${port}/runtime/capabilities`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    capabilities?: {
      platform?: string;
      discovery?: string;
      tools?: Record<string, { status?: string; source?: string; reason?: string }>;
    };
    shellIsolation?: {
      executor?: string;
      enforcement?: string;
      writeIsolation?: string;
      readIsolation?: string;
      networkIsolation?: string;
    };
  };
  assert.ok(body.capabilities);
  assert.ok(body.capabilities.platform === 'macos' || body.capabilities.platform === 'unsupported');
  assert.equal(body.capabilities.discovery, 'startup');
  assert.ok(body.capabilities.tools);

  // Shell 隔离能力（诚实分级）：字段齐全且枚举合法；与本进程平台一致。
  assert.ok(body.shellIsolation);
  assert.ok(
    body.shellIsolation.executor === 'macos-seatbelt'
      || body.shellIsolation.executor === 'windows-acl'
      || body.shellIsolation.executor === 'uncontained-gated',
  );
  assert.ok(['full', 'partial', 'none'].includes(String(body.shellIsolation.enforcement)));
  assert.ok(['full', 'partial', 'none'].includes(String(body.shellIsolation.writeIsolation)));
  assert.ok(['full', 'none'].includes(String(body.shellIsolation.readIsolation)));
  assert.ok(['os-level', 'none'].includes(String(body.shellIsolation.networkIsolation)));
  // macOS 本机：seatbelt + full；gate 环境变量未设时绝不虚报 partial
  if (process.platform === 'darwin') {
    assert.equal(body.shellIsolation.executor, 'macos-seatbelt');
    assert.equal(body.shellIsolation.enforcement, 'full');
  }

  // No private manifest fields or absolute host paths may cross the endpoint.
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /readableRoots|executableRoots|safePath|workspaceRoot/);
  assert.doesNotMatch(serialized, /\/(?:Users|private|opt|usr)\//);

  const refresh = await fetch(`http://127.0.0.1:${port}/runtime/capabilities/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(refresh.status, 200);
  const refreshed = (await refresh.json()) as { refreshed?: boolean; capabilities?: unknown };
  assert.equal(refreshed.refreshed, true);
  assert.ok(refreshed.capabilities);
  const refreshedSerialized = JSON.stringify(refreshed);
  assert.doesNotMatch(refreshedSerialized, /readableRoots|executableRoots|safePath|workspaceRoot/);
  assert.doesNotMatch(refreshedSerialized, /\/(?:Users|private|opt|usr)\//);
} finally {
  await manager.close();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

console.log('Runtime capabilities endpoint tests: PASS');
