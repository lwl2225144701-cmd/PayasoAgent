// Runtime capability endpoint must expose only the path-free startup snapshot.

import assert from "node:assert/strict";
import { createHostServer } from "../src/host/server.js";
import { RunManager } from "../src/host/run-manager.js";
import { SqliteRunStore } from "../src/host/persistence/sqlite-store.js";

const manager = new RunManager(new SqliteRunStore(":memory:"));
const server = createHostServer(manager);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

try {
  const response = await fetch(`http://127.0.0.1:${port}/runtime/capabilities`);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    capabilities?: {
      platform?: string;
      discovery?: string;
      tools?: Record<string, { status?: string; source?: string; reason?: string }>;
    };
  };
  assert.ok(body.capabilities);
  assert.ok(body.capabilities.platform === "macos" || body.capabilities.platform === "unsupported");
  assert.equal(body.capabilities.discovery, "startup");
  assert.ok(body.capabilities.tools);

  // No private manifest fields or absolute host paths may cross the endpoint.
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /readableRoots|executableRoots|safePath|workspaceRoot/);
  assert.doesNotMatch(serialized, /\/(?:Users|private|opt|usr)\//);

  const refresh = await fetch(`http://127.0.0.1:${port}/runtime/capabilities/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(refresh.status, 200);
  const refreshed = await refresh.json() as { refreshed?: boolean; capabilities?: unknown };
  assert.equal(refreshed.refreshed, true);
  assert.ok(refreshed.capabilities);
  const refreshedSerialized = JSON.stringify(refreshed);
  assert.doesNotMatch(refreshedSerialized, /readableRoots|executableRoots|safePath|workspaceRoot/);
  assert.doesNotMatch(refreshedSerialized, /\/(?:Users|private|opt|usr)\//);
} finally {
  await manager.close();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

console.log("Runtime capabilities endpoint tests: PASS");
