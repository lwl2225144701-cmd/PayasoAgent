// Phase 2 deterministic persistence acceptance: SQLite CRUD/order/isolation,
// Host restart history, interrupted recovery, Workspace binding, manual resume.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager } from "../src/host/run-manager.js";
import { SqliteRunStore } from "../src/host/persistence/sqlite-store.js";
import type { StoredRun } from "../src/host/persistence/store.js";
import { clearWorkspace, setWorkspace } from "../src/host/workspace.js";
import { checkpointPath, saveCheckpoint } from "../src/runtime/checkpoint.js";
import { createScratchpad } from "../src/runtime/scratchpad.js";
import { createState } from "../src/runtime/state.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-persistence-"));
process.env.SANDBOX_ROOT = path.join(root, "sandbox");
const workspace = path.join(root, "workspace-A");
fs.mkdirSync(workspace, { recursive: true });
const canonicalWorkspace = fs.realpathSync.native(workspace);

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, fn }); }

function storedRun(runId: string, status: StoredRun["status"] = "running"): StoredRun {
  return {
    runId,
    task: `task-${runId}`,
    status,
    workspaceRoot: canonicalWorkspace,
    workspaceName: "workspace-A",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for Run state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("RunStore CRUD persists status/result/workspace across reopen", () => {
  const dbPath = path.join(root, "crud.db");
  const first = new SqliteRunStore(dbPath);
  const run = storedRun("crud-run");
  first.createRun(run);
  assert.deepEqual(first.getRun(run.runId), run);
  first.updateRun({
    ...run,
    status: "completed",
    updatedAt: "2026-08-27T00:01:00.000Z",
    result: "done",
  });
  first.close();

  const reopened = new SqliteRunStore(dbPath);
  const restored = reopened.getRun(run.runId);
  assert.equal(restored?.status, "completed");
  assert.equal(restored?.result, "done");
  assert.equal(restored?.workspaceRoot, canonicalWorkspace);
  assert.equal(restored?.workspaceName, "workspace-A");
  assert.equal(reopened.listRuns().length, 1);
  reopened.close();
});

test("events retain per-Run sequence and never cross Run boundaries", () => {
  const store = new SqliteRunStore(path.join(root, "events.db"));
  store.createRun(storedRun("run-A"));
  store.createRun(storedRun("run-B"));
  const at = "2026-08-27T00:00:00.000Z";
  assert.equal(store.appendEvent("run-A", { type: "run_started", runId: "run-A", timestamp: at }), 1);
  assert.equal(store.appendEvent("run-A", { type: "run_completed", runId: "run-A", timestamp: at, result: "A" }), 2);
  assert.equal(store.appendEvent("run-A", { type: "run_stopped", runId: "run-A", timestamp: at }), 3);
  assert.equal(store.appendEvent("run-B", { type: "run_started", runId: "run-B", timestamp: at }), 1);
  assert.deepEqual(store.listEvents("run-A").map((item) => item.seq), [1, 2, 3]);
  assert.deepEqual(store.listEvents("run-A").map((item) => item.event.type), [
    "run_started", "run_completed", "run_stopped",
  ]);
  assert.deepEqual(store.listEvents("run-B").map((item) => item.event.type), ["run_started"]);
  store.close();
});

test("completed Run metadata/result/events survive RunManager restart", async () => {
  const dbPath = path.join(root, "manager-restart.db");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "persisted answer" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  setWorkspace(workspace);
  let runId = "";
  try {
    const hostA = new RunManager(new SqliteRunStore(dbPath));
    runId = hostA.create("persist me");
    await waitFor(() => hostA.get(runId)?.status === "completed");
    assert.equal(hostA.get(runId)?.result, "persisted answer");
    hostA.close();

    clearWorkspace();
    const hostB = new RunManager(new SqliteRunStore(dbPath));
    assert.ok(hostB.list().some((run) => run.runId === runId));
    assert.equal(hostB.get(runId)?.result, "persisted answer");
    assert.deepEqual(hostB.get(runId)?.workspace, { name: "workspace-A" });
    assert.equal(hostB.getWorkspaceRoot(runId), canonicalWorkspace);
    assert.ok(!JSON.stringify(hostB.get(runId)).includes(canonicalWorkspace));

    const chunks: string[] = [];
    assert.equal(hostB.subscribe(runId, {
      write: (chunk) => chunks.push(chunk),
      end: () => {},
      closed: () => false,
    }), true);
    assert.ok(chunks.some((chunk) => chunk.includes("event: final_answer")));
    assert.ok(chunks.some((chunk) => chunk.includes("event: run_completed")));
    hostB.close();
  } finally {
    globalThis.fetch = originalFetch;
    clearWorkspace();
    if (runId) fs.rmSync(checkpointPath(runId), { force: true });
  }
});

test("startup marks persisted running Run interrupted without auto-resume", () => {
  const dbPath = path.join(root, "interrupted.db");
  const seed = new SqliteRunStore(dbPath);
  seed.createRun(storedRun("interrupted-run"));
  seed.appendEvent("interrupted-run", {
    type: "run_started",
    runId: "interrupted-run",
    timestamp: "2026-08-27T00:00:00.000Z",
  });
  seed.close();

  const manager = new RunManager(new SqliteRunStore(dbPath));
  assert.equal(manager.get("interrupted-run")?.status, "interrupted");
  assert.match(manager.get("interrupted-run")?.error ?? "", /Host restarted/);
  const chunks: string[] = [];
  manager.subscribe("interrupted-run", {
    write: (chunk) => chunks.push(chunk),
    end: () => {},
    closed: () => false,
  });
  assert.ok(chunks.some((chunk) => chunk.includes("event: run_interrupted")));
  assert.equal(manager.getRaw("interrupted-run"), undefined);
  manager.close();
});

test("manual resume uses persisted Workspace and existing checkpoint", async () => {
  const runId = "resume-persisted-run";
  const task = "resume persisted";
  const dbPath = path.join(root, "resume.db");
  const seed = new SqliteRunStore(dbPath);
  seed.createRun({ ...storedRun(runId), task });
  seed.close();
  saveCheckpoint({
    runId,
    task,
    status: "running",
    iteration: 0,
    scratchpad: createScratchpad(task),
    messages: [{ role: "user", content: task }],
    state: createState(task, runId),
    workspaceRoot: canonicalWorkspace,
    sideEffects: [],
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "resumed" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const manager = new RunManager(new SqliteRunStore(dbPath));
    assert.equal(manager.get(runId)?.status, "interrupted");
    assert.equal(manager.resume(runId), true);
    assert.equal(manager.getWorkspaceRoot(runId), canonicalWorkspace);
    await waitFor(() => manager.get(runId)?.status === "completed");
    assert.equal(manager.get(runId)?.result, "resumed");
    assert.deepEqual(manager.get(runId)?.workspace, { name: "workspace-A" });
    manager.close();
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(checkpointPath(runId), { force: true });
  }
});

let passed = 0;
let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    passed++;
    console.log(`  PASS  ${item.name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${item.name}: ${(err as Error).stack ?? (err as Error).message}`);
  }
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\nPersistence tests: ${passed} passed / ${failed} failed`);
if (failed) process.exitCode = 1;
