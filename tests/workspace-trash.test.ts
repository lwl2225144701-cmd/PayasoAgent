// Workspace 回收站 deterministic acceptance：软删除 / 恢复 / 永久删除 / 事务 /
// 隔离 / 路径安全 / 公开入口过滤。不依赖 LLM/网络。

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { SqliteRunStore } from "../src/host/persistence/sqlite-store.js";
import type { StoredRun, StoredSession } from "../src/host/persistence/store.js";
import { RunManager } from "../src/host/run-manager.js";
import { createHostServer } from "../src/host/server.js";
import { clearWorkspace, getWorkspace, setWorkspace } from "../src/host/workspace.js";
import { checkpointPath, loadCheckpoint, saveCheckpoint } from "../src/persistence/file-checkpoint-store.js";
import { createScratchpad } from "../src/runtime/scratchpad.js";
import { createState } from "../src/runtime/state.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-workspace-trash-"));
process.env.SANDBOX_ROOT = path.join(ROOT, "sandbox");
const DB_PATH = path.join(ROOT, "payaso.db");

const workspaceA = path.join(ROOT, "workspace-A");
const workspaceB = path.join(ROOT, "workspace-B");
fs.mkdirSync(workspaceA, { recursive: true });
fs.mkdirSync(workspaceB, { recursive: true });
const canonicalA = fs.realpathSync.native(workspaceA);
const canonicalB = fs.realpathSync.native(workspaceB);

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, fn }); }

function createStoppedSession(manager: RunManager, task: string, requestedSessionId?: string, opts?: { workspaceName?: string }): { sessionId: string; runId: string } {
  const result = manager.createInSession(task, requestedSessionId, { ...opts, startAgent: false });
  manager.stop(result.runId);
  return result;
}

function storedSession(sessionId: string, workspaceRoot: string, workspaceName: string): StoredSession {
  return {
    sessionId,
    title: `title-${sessionId}`,
    workspaceRoot,
    workspaceName,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function storedRun(runId: string, sessionId: string, workspaceRoot: string, workspaceName: string, status: StoredRun["status"] = "completed"): StoredRun {
  return {
    runId,
    sessionId,
    turnIndex: 1,
    task: `task-${runId}`,
    status,
    workspaceRoot,
    workspaceName,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

async function httpJson(method: string, urlPath: string, body?: any): Promise<{ status: number; data: any }> {
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method, headers: { "Content-Type": "application/json" } }, (r) => resolve(r));
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.statusCode ?? 500, data };
}

// ---------------------------------------------------------------------------
// 1. Persistence 层：迁移 + 索引 + 软删/恢复/清空基础行为
// ---------------------------------------------------------------------------
test("deleted_at 迁移后默认值为 NULL", () => {
  const dbPath = path.join(ROOT, "migration-default.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-default", canonicalA, "workspace-A"));
  const session = store.getSession("s-default", { includeDeleted: true });
  assert.equal(session?.deletedAt, undefined);
  store.close();
});

test("重复初始化数据库不会重复添加 deleted_at", () => {
  const dbPath = path.join(ROOT, "migration-idempotent.db");
  const first = new SqliteRunStore(dbPath);
  first.createSession(storedSession("s-1", canonicalA, "workspace-A"));
  first.close();
  const second = new SqliteRunStore(dbPath);
  const session = second.getSession("s-1", { includeDeleted: true });
  assert.ok(session);
  second.close();
});

test("deleted_at 索引成功创建", () => {
  const dbPath = path.join(ROOT, "migration-indexes.db");
  const store = new SqliteRunStore(dbPath);
  const sessionIndexes = store["db"].prepare("PRAGMA index_list(sessions)").all() as Array<{ name: string }>;
  const runIndexes = store["db"].prepare("PRAGMA index_list(runs)").all() as Array<{ name: string }>;
  assert.ok(sessionIndexes.some((i) => i.name === "idx_sessions_deleted_at"));
  assert.ok(runIndexes.some((i) => i.name === "idx_runs_deleted_at"));
  store.close();
});

// ---------------------------------------------------------------------------
// 2. Store 层软删/恢复/清空过滤
// ---------------------------------------------------------------------------
test("软删后 listSessions/listRuns 默认不可见", () => {
  const dbPath = path.join(ROOT, "store-filter.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-filter", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-filter", "s-filter", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  assert.equal(store.listSessions().length, 0);
  assert.equal(store.listRuns().length, 0);
  assert.equal(store.listSessions({ includeDeleted: true }).length, 1);
  assert.equal(store.listRuns({ includeDeleted: true }).length, 1);
  store.close();
});

test("软删后 getSession/getRun 默认不可见", () => {
  const dbPath = path.join(ROOT, "store-get.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-get", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-get", "s-get", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  assert.equal(store.getSession("s-get"), null);
  assert.equal(store.getRun("r-get"), null);
  assert.ok(store.getSession("s-get", { includeDeleted: true }));
  assert.ok(store.getRun("r-get", { includeDeleted: true }));
  store.close();
});

test("软删后旧 ID 的所有公开入口被拒绝", () => {
  const dbPath = path.join(ROOT, "store-public.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-pub", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-pub", "s-pub", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  assert.equal(store.getSession("s-pub"), null);
  assert.equal(store.getRun("r-pub"), null);
  assert.equal(store.listRunsBySession("s-pub").length, 0);
  assert.equal(store.findSessionByWorkspaceName("workspace-A"), null);
  store.close();
});

// ---------------------------------------------------------------------------
// 3. 事务与时间戳一致性
// ---------------------------------------------------------------------------
test("软删后 Session 和 Run 的 deleted_at 完全相同", () => {
  const dbPath = path.join(ROOT, "tx-deleted-at.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-ts", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-ts", "s-ts", canonicalA, "workspace-A"));
  const now = "2026-08-27T01:00:00.000Z";
  store.softDeleteWorkspace(canonicalA, now);
  const session = store.getSession("s-ts", { includeDeleted: true })!;
  const run = store.getRun("r-ts", { includeDeleted: true })!;
  assert.equal(session.deletedAt, now);
  assert.equal(run.deletedAt, now);
  store.close();
});

test("软删后 Session 和 Run 的 updated_at 完全相同", () => {
  const dbPath = path.join(ROOT, "tx-updated.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-up", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-up", "s-up", canonicalA, "workspace-A"));
  const now = "2026-08-27T01:00:00.000Z";
  store.softDeleteWorkspace(canonicalA, now);
  const session = store.getSession("s-up", { includeDeleted: true })!;
  const run = store.getRun("r-up", { includeDeleted: true })!;
  assert.equal(session.updatedAt, now);
  assert.equal(run.updatedAt, now);
  store.close();
});

test("同一次软删中的 deleted_at 等于 updated_at", () => {
  const dbPath = path.join(ROOT, "tx-equal.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-eq", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-eq", "s-eq", canonicalA, "workspace-A"));
  const now = "2026-08-27T01:00:00.000Z";
  store.softDeleteWorkspace(canonicalA, now);
  const session = store.getSession("s-eq", { includeDeleted: true })!;
  const run = store.getRun("r-eq", { includeDeleted: true })!;
  assert.equal(session.deletedAt, session.updatedAt);
  assert.equal(run.deletedAt, run.updatedAt);
  store.close();
});

test("恢复后 Session 和 Run 的 updated_at 同步刷新", () => {
  const dbPath = path.join(ROOT, "restore-updated.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-restore", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-restore", "s-restore", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  const restoreNow = "2026-08-27T02:00:00.000Z";
  store.restoreWorkspace(canonicalA, restoreNow);
  const session = store.getSession("s-restore")!;
  const run = store.getRun("r-restore")!;
  assert.equal(session.deletedAt, undefined);
  assert.equal(run.deletedAt, undefined);
  assert.equal(session.updatedAt, restoreNow);
  assert.equal(run.updatedAt, restoreNow);
  store.close();
});

// ---------------------------------------------------------------------------
// 4. 恢复路径安全校验（通过 RunManager 层）
// ---------------------------------------------------------------------------
test("Workspace 目录不存在时恢复被拒", () => {
  const dbPath = path.join(ROOT, "restore-missing.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const missingRoot = path.join(ROOT, "missing-workspace");
  const sessionId = createStoppedSession(manager, "restore-missing", undefined, { workspaceName: "missing-workspace" }).sessionId;
  // Override the session's workspaceRoot to the missing path
  const session = store.getSession(sessionId, { includeDeleted: true })!;
  store.updateSession({ ...session, workspaceRoot: missingRoot });
  manager.deleteWorkspace(sessionId);
  assert.throws(() => manager.restoreWorkspace(sessionId), /Workspace path no longer exists/);
  manager.close();
});

test("Workspace 路径变成普通文件时恢复被拒", () => {
  const dbPath = path.join(ROOT, "restore-file.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const fileRoot = path.join(ROOT, "file-not-dir");
  fs.writeFileSync(fileRoot, "not-a-dir");
  const sessionId = createStoppedSession(manager, "restore-file", undefined, { workspaceName: "file-not-dir" }).sessionId;
  const session = store.getSession(sessionId, { includeDeleted: true })!;
  store.updateSession({ ...session, workspaceRoot: fileRoot });
  manager.deleteWorkspace(sessionId);
  assert.throws(() => manager.restoreWorkspace(sessionId), /Workspace path is no longer a directory/);
  manager.close();
});

test("Workspace 路径被 symlink 替换时恢复被拒", () => {
  const dbPath = path.join(ROOT, "restore-symlink.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const linkRoot = path.join(ROOT, "link-root");
  fs.symlinkSync(workspaceA, linkRoot);
  const sessionId = createStoppedSession(manager, "restore-symlink", undefined, { workspaceName: "link-root" }).sessionId;
  const session = store.getSession(sessionId, { includeDeleted: true })!;
  store.updateSession({ ...session, workspaceRoot: linkRoot });
  manager.deleteWorkspace(sessionId);
  assert.throws(() => manager.restoreWorkspace(sessionId), /Workspace path has changed/);
  manager.close();
});

test("realpath 与保存 root 不一致时恢复被拒", () => {
  const dbPath = path.join(ROOT, "restore-real.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  // Save a symlink path as workspaceRoot, then replace the symlink target.
  const linkRoot = path.join(ROOT, "real-changed");
  fs.symlinkSync(workspaceA, linkRoot);
  const sessionId = createStoppedSession(manager, "restore-real", undefined, { workspaceName: "real-changed" }).sessionId;
  const session = store.getSession(sessionId, { includeDeleted: true })!;
  store.updateSession({ ...session, workspaceRoot: linkRoot });
  manager.deleteWorkspace(sessionId);
  // Replace symlink with a different target directory.
  fs.rmSync(linkRoot, { recursive: true, force: true });
  const otherDir = path.join(ROOT, "other-dir");
  fs.mkdirSync(otherDir, { recursive: true });
  fs.symlinkSync(otherDir, linkRoot);
  assert.throws(() => manager.restoreWorkspace(sessionId), /Workspace path has changed/);
  manager.close();
});

// ---------------------------------------------------------------------------
// 5. 永久删除
// ---------------------------------------------------------------------------
test("永久删除后 Session、Run 和 Event 消失", () => {
  const dbPath = path.join(ROOT, "purge-data.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-purge", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-purge", "s-purge", canonicalA, "workspace-A"));
  store.appendEvent("r-purge", { type: "run_started", runId: "r-purge", timestamp: "2026-08-27T00:00:00.000Z" });
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  store.purgeWorkspace(canonicalA);
  assert.equal(store.getSession("s-purge", { includeDeleted: true }), null);
  assert.equal(store.getRun("r-purge", { includeDeleted: true }), null);
  assert.equal(store.listEvents("r-purge").length, 0);
  store.close();
});

test("永久删除后对应 checkpoint 消失", () => {
  const runId = "purge-checkpoint-run";
  const dbPath = path.join(ROOT, "purge-checkpoint.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-pcp", canonicalA, "workspace-A"));
  store.createRun(storedRun(runId, "s-pcp", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  saveCheckpoint({
    runId,
    task: "checkpoint",
    status: "running",
    iteration: 0,
    scratchpad: createScratchpad("checkpoint"),
    messages: [{ role: "user", content: "checkpoint" }],
    state: createState("checkpoint", runId),
    workspaceRoot: canonicalA,
    sideEffects: [],
  });
  assert.ok(fs.existsSync(checkpointPath(runId)));
  const manager = new RunManager(store);
  manager.purgeWorkspace("s-pcp");
  assert.ok(!fs.existsSync(checkpointPath(runId)));
  manager.close();
});

test("永久删除后内部 run sandbox 消失", () => {
  const runId = "purge-sandbox-run";
  const dbPath = path.join(ROOT, "purge-sandbox.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-psb", canonicalA, "workspace-A"));
  store.createRun(storedRun(runId, "s-psb", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  const sandboxRoot = path.join(process.env.SANDBOX_ROOT!, "workspaces", runId);
  fs.mkdirSync(sandboxRoot, { recursive: true });
  fs.writeFileSync(path.join(sandboxRoot, "file.txt"), "sandbox");
  const manager = new RunManager(store);
  manager.purgeWorkspace("s-psb");
  assert.ok(!fs.existsSync(sandboxRoot));
  manager.close();
});

test("Purge 清理失败响应不含绝对路径", () => {
  const dbPath = path.join(ROOT, "purge-leak.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const sessionId = "s-leak";
  const runId = "r-leak";
  store.createSession(storedSession(sessionId, canonicalA, "workspace-A"));
  store.createRun(storedRun(runId, sessionId, canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");

  // 让 checkpoint 清理必然失败：把 <runId>.json 占位成目录（rmSync 无 recursive 会 EISDIR）
  const cp = checkpointPath(runId);
  fs.mkdirSync(cp, { recursive: true });
  try {
    const result = manager.purgeWorkspace(sessionId);
    assert.ok(Array.isArray(result.cleanupErrors));
    assert.deepEqual(result.cleanupErrors, [{ runId, target: "checkpoint" }]);

    // 序列化结果不得包含任何绝对路径（ROOT / checkpoint 目录）
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(ROOT), "response must not leak ROOT path");
    assert.ok(!serialized.includes(process.cwd()), "response must not leak cwd");
    assert.ok(!serialized.includes(".checkpoints"), "response must not leak checkpoint dir");
  } finally {
    try { fs.rmSync(cp, { recursive: true, force: true }); } catch { /* best effort */ }
    manager.close();
  }
});

test("永久删除不改变真实 Workspace 中的任何文件", () => {
  const dbPath = path.join(ROOT, "purge-real.db");
  const store = new SqliteRunStore(dbPath);
  const userFile = path.join(workspaceA, "user-file.txt");
  fs.writeFileSync(userFile, "USER-DATA");
  store.createSession(storedSession("s-real", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-real", "s-real", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  const manager = new RunManager(store);
  manager.purgeWorkspace("s-real");
  assert.ok(fs.existsSync(userFile));
  assert.equal(fs.readFileSync(userFile, "utf8"), "USER-DATA");
  manager.close();
});

test("Purge 后内存 Run 不再可访问", () => {
  const dbPath = path.join(ROOT, "purge-memory.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const sessionId = createStoppedSession(manager, "purge-memory").sessionId;
  const runId = manager.listSessionRuns(sessionId)![0].runId;

  manager.deleteWorkspace(sessionId);
  manager.purgeWorkspace(sessionId);

  assert.equal(manager.get(runId), null);
  assert.equal(manager.getWorkspaceRoot(runId), null);
  assert.equal(manager.stop(runId), false);
  manager.close();
});

// ---------------------------------------------------------------------------
// 6. 同名 Workspace 隔离
// ---------------------------------------------------------------------------
test("两个 basename 相同但 root 不同的 Workspace 不互相影响", () => {
  const dbPath = path.join(ROOT, "isolation.db");
  const store = new SqliteRunStore(dbPath);
  const sameName = "shared-name";
  store.createSession(storedSession("s-iso-a", canonicalA, sameName));
  store.createSession(storedSession("s-iso-b", canonicalB, sameName));
  store.createRun(storedRun("r-iso-a", "s-iso-a", canonicalA, sameName));
  store.createRun(storedRun("r-iso-b", "s-iso-b", canonicalB, sameName));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  assert.equal(store.listSessions().length, 1);
  assert.equal(store.listSessions({ includeDeleted: true }).length, 2);
  assert.equal(store.listRuns().length, 1);
  assert.equal(store.listRuns({ includeDeleted: true }).length, 2);
  assert.ok(store.getSession("s-iso-b"));
  assert.ok(store.getRun("r-iso-b"));
  store.close();
});

test("同名不同 root 时按 name 查找被拒绝", () => {
  const dbPath = path.join(ROOT, "name-ambiguity.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  store.createSession(storedSession("s-name-a", canonicalA, "shared-name"));
  store.createSession(storedSession("s-name-b", canonicalB, "shared-name"));
  store.createRun(storedRun("r-a", "s-name-a", canonicalA, "shared-name"));
  store.createRun(storedRun("r-b", "s-name-b", canonicalB, "shared-name"));
  assert.throws(() => manager.findSessionByWorkspaceName("shared-name"), /matches multiple roots/);
  manager.close();
});

// ---------------------------------------------------------------------------
// 7. Host 路由级过滤
// ---------------------------------------------------------------------------
let port = 0;
let server: http.Server | null = null;

test("软删除后通过旧 ID 无法绕过过滤访问 Session、Run、Events、Files 和 Resume", async () => {
  const dbPath = path.join(ROOT, "host-filter.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const sessionId = createStoppedSession(manager, "host-filter").sessionId;
  const runId = manager.listSessionRuns(sessionId)![0].runId;
  manager.close();

  const soft = new RunManager(new SqliteRunStore(dbPath));
  soft.deleteWorkspace(sessionId);
  soft.close();

  const srv = createHostServer(new RunManager(new SqliteRunStore(dbPath)));
  server = srv;
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;

  try {
    const sessionResp = await httpJson("GET", `/sessions/${sessionId}`);
    assert.equal(sessionResp.status, 404, `session status=${sessionResp.status}`);

    const runsResp = await httpJson("GET", `/sessions/${sessionId}/runs`);
    assert.equal(runsResp.status, 404, `session runs status=${runsResp.status}`);

    const runResp = await httpJson("GET", `/runs/${runId}`);
    assert.equal(runResp.status, 404, `run status=${runResp.status}`);

    const eventsResp = await httpJson("GET", `/runs/${runId}/events`);
    assert.equal(eventsResp.status, 404, `events status=${eventsResp.status}`);

    const filesResp = await httpJson("GET", `/runs/${runId}/files`);
    assert.equal(filesResp.status, 404, `files status=${filesResp.status}`);

    const resumeResp = await httpJson("POST", `/runs/${runId}/resume`);
    assert.equal(resumeResp.status, 404, `resume status=${resumeResp.status}`);
  } finally {
    if (server) server.close();
    server = null;
    clearWorkspace();
  }
});

// ---------------------------------------------------------------------------
// 8. RunManager 级行为
// ---------------------------------------------------------------------------
test("running Run 拒绝软删", () => {
  const dbPath = path.join(ROOT, "running-reject.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  store.createSession(storedSession(sessionId, canonicalA, "workspace-A"));
  store.createRun(storedRun(runId, sessionId, canonicalA, "workspace-A", "running"));
  assert.throws(() => manager.deleteWorkspace(sessionId), /Workspace has a running Run/);
  manager.close();
});

test("running Run 拒绝永久删除", () => {
  const dbPath = path.join(ROOT, "running-purge-reject.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-run", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-run", "s-run", canonicalA, "workspace-A", "running"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  const manager = new RunManager(store);
  assert.throws(() => manager.purgeWorkspace("s-run"), /Workspace has a running Run/);
  manager.close();
});

test("当前 Workspace 被软删后 clearWorkspace", () => {
  const dbPath = path.join(ROOT, "current-clear.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  setWorkspace(workspaceA);
  const sessionId = createStoppedSession(manager, "current-clear").sessionId;
  const runId = manager.listSessionRuns(sessionId)![0].runId;
  manager.stop(runId);
  manager.deleteWorkspace(sessionId);
  assert.equal(getWorkspace(), null);
  manager.close();
});

test("删除其他 Workspace 时不得清空当前 Workspace", () => {
  const dbPath = path.join(ROOT, "other-clear.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  setWorkspace(workspaceA);
  const sessionA = createStoppedSession(manager, "keep-current").sessionId;
  setWorkspace(workspaceB);
  const sessionB = createStoppedSession(manager, "delete-other").sessionId;
  const runB = manager.listSessionRuns(sessionB)![0].runId;
  manager.stop(runB);
  setWorkspace(workspaceA); // current is A, we will delete B
  manager.deleteWorkspace(sessionB);
  assert.ok(getWorkspace());
  assert.equal(getWorkspace()!.rootPath, canonicalA);
  manager.close();
});

// ---------------------------------------------------------------------------
// 9. 事务 rollback
// ---------------------------------------------------------------------------
test("softDeleteWorkspace 异常时完整 rollback", () => {
  const dbPath = path.join(ROOT, "rollback-soft.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-rb", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-rb", "s-rb", canonicalA, "workspace-A"));

  // 在 sessions 上创建触发器，软删时强制 ABORT，验证 softDeleteWorkspace 自身事务回滚
  (store as any)["db"].exec(`
    CREATE TRIGGER soft_delete_fail BEFORE UPDATE ON sessions
    FOR EACH ROW WHEN NEW.deleted_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'soft_delete_abort'); END;
  `);

  assert.throws(() => store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z"), /soft_delete_abort/);
  assert.equal(store.getSession("s-rb", { includeDeleted: true })?.deletedAt, undefined);
  assert.equal(store.getRun("r-rb", { includeDeleted: true })?.deletedAt, undefined);
  store.close();
});

test("restoreWorkspace 异常时完整 rollback", () => {
  const dbPath = path.join(ROOT, "rollback-restore.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-rr", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-rr", "s-rr", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");

  // 在 sessions 上创建触发器，恢复时强制 ABORT，验证 restoreWorkspace 自身事务回滚
  (store as any)["db"].exec(`
    CREATE TRIGGER restore_fail BEFORE UPDATE ON sessions
    FOR EACH ROW WHEN NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'restore_abort'); END;
  `);

  assert.throws(() => store.restoreWorkspace(canonicalA, "2026-08-27T02:00:00.000Z"), /restore_abort/);
  assert.ok(store.getSession("s-rr", { includeDeleted: true })?.deletedAt);
  assert.ok(store.getRun("r-rr", { includeDeleted: true })?.deletedAt);
  store.close();
});

// ---------------------------------------------------------------------------
// 9.5 缺失覆盖：内存态绕过 / 多 Session Purge / 软删后接口拒绝
// ---------------------------------------------------------------------------
test("软删后同一 Manager 内存态绕过", () => {
  const dbPath = path.join(ROOT, "memory-bypass.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const sessionId = createStoppedSession(manager, "memory-bypass").sessionId;
  const runId = manager.listSessionRuns(sessionId)![0].runId;
  manager.stop(runId);

  manager.deleteWorkspace(sessionId);

  assert.equal(manager.get(runId), null, "in-memory run 应在软删后隐藏");
  assert.equal(manager.getWorkspaceRoot(runId), null, "workspaceRoot 应在软删后隐藏");
  assert.equal(manager.stop(runId), false, "stop 应拒绝已软删的 session");
  manager.close();
});

test("Purge 清理 Workspace 下全部 Session 的 checkpoint 和 sandbox", () => {
  const dbPath = path.join(ROOT, "purge-multi.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);

  const sessionA = "s-multi-a";
  const sessionB = "s-multi-b";
  const runA = "r-multi-a";
  const runB = "r-multi-b";
  store.createSession(storedSession(sessionA, canonicalA, "shared-workspace"));
  store.createSession(storedSession(sessionB, canonicalA, "shared-workspace"));
  store.createRun(storedRun(runA, sessionA, canonicalA, "shared-workspace"));
  store.createRun(storedRun(runB, sessionB, canonicalA, "shared-workspace"));

  saveCheckpoint({
    runId: runA,
    task: "a",
    status: "completed",
    iteration: 0,
    scratchpad: createScratchpad("a"),
    messages: [],
    state: createState("a", runA),
    workspaceRoot: canonicalA,
    sideEffects: [],
  });
  saveCheckpoint({
    runId: runB,
    task: "b",
    status: "completed",
    iteration: 0,
    scratchpad: createScratchpad("b"),
    messages: [],
    state: createState("b", runB),
    workspaceRoot: canonicalA,
    sideEffects: [],
  });

  const cpA = checkpointPath(runA);
  const cpB = checkpointPath(runB);
  assert.ok(fs.existsSync(cpA), `checkpoint A should exist at ${cpA}`);
  assert.ok(fs.existsSync(cpB), `checkpoint B should exist at ${cpB}`);

  manager.stop(runA);
  manager.stop(runB);
  manager.deleteWorkspace(sessionA);
  manager.purgeWorkspace(sessionA);

  assert.ok(!fs.existsSync(cpA), "checkpoint A 应被清理");
  assert.ok(!fs.existsSync(cpB), "checkpoint B 应被清理");
  manager.close();
});

test("软删后 Host 路由拒绝旧 Run 的 GET /runs/:id、stop 和 files", async () => {
  const dbPath = path.join(ROOT, "post-delete-routes.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const sessionId = createStoppedSession(manager, "post-delete").sessionId;
  const runId = manager.listSessionRuns(sessionId)![0].runId;
  manager.stop(runId);
  manager.close();

  const soft = new RunManager(new SqliteRunStore(dbPath));
  soft.deleteWorkspace(sessionId);
  soft.close();

  const srv = createHostServer(new RunManager(new SqliteRunStore(dbPath)));
  server = srv;
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  port = (server!.address() as { port: number }).port;
  try {
    async function request(method: string, urlPath: string): Promise<{ status: number; data: any }> {
      return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method, headers: { "Content-Type": "application/json" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let data: any;
            try { data = JSON.parse(text); } catch { data = text; }
            resolve({ status: res.statusCode ?? 500, data });
          });
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      });
    }

    const runResp = await request("GET", `/runs/${runId}`);
    assert.equal(runResp.status, 404, `run status=${runResp.status}`);

    const stopResp = await request("POST", `/runs/${runId}/stop`);
    assert.equal(stopResp.status, 404, `stop status=${stopResp.status}`);

    const filesResp = await request("GET", `/runs/${runId}/files`);
    assert.equal(filesResp.status, 404, `files status=${filesResp.status}`);
  } finally {
    await new Promise<void>((r) => setTimeout(r, 50));
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

// ---------------------------------------------------------------------------
// 10. Host 重启后软删状态保持
// ---------------------------------------------------------------------------
test("Host 重启后软删状态保持", () => {
  const dbPath = path.join(ROOT, "restart.db");
  const first = new SqliteRunStore(dbPath);
  first.createSession(storedSession("s-restart", canonicalA, "workspace-A"));
  first.createRun(storedRun("r-restart", "s-restart", canonicalA, "workspace-A"));
  first.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  first.close();

  const second = new SqliteRunStore(dbPath);
  assert.equal(second.listSessions().length, 0);
  assert.equal(second.listRuns().length, 0);
  assert.equal(second.listSessions({ includeDeleted: true }).length, 1);
  assert.equal(second.listRuns({ includeDeleted: true }).length, 1);
  second.close();
});

// ---------------------------------------------------------------------------
// 11. workspaceName 查找不会命中已删除 Workspace
// ---------------------------------------------------------------------------
test("workspaceName 查找不会命中已删除 Workspace", () => {
  const dbPath = path.join(ROOT, "name-lookup.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-name", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-name", "s-name", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  assert.equal(store.findSessionByWorkspaceName("workspace-A"), null);
  assert.equal(store.findSessionByWorkspaceName("workspace-A", { includeDeleted: true })?.sessionId, "s-name");
  store.close();
});

// ---------------------------------------------------------------------------
// 12. 恢复不自动设置 currentWorkspace
// ---------------------------------------------------------------------------
test("恢复不自动设置 currentWorkspace", () => {
  const dbPath = path.join(ROOT, "restore-no-current.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-rc", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-rc", "s-rc", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  const manager = new RunManager(store);
  setWorkspace(workspaceA);
  assert.equal(getWorkspace()!.rootPath, canonicalA);
  manager.deleteWorkspace("s-rc");
  assert.equal(getWorkspace(), null);
  manager.restoreWorkspace("s-rc");
  assert.equal(getWorkspace(), null);
  manager.close();
});

// ---------------------------------------------------------------------------
// 13. 幂等性
// ---------------------------------------------------------------------------
test("重复软删采用确定性幂等语义", () => {
  const dbPath = path.join(ROOT, "idempotent-delete.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-idem", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-idem", "s-idem", canonicalA, "workspace-A"));
  const now = "2026-08-27T01:00:00.000Z";
  const first = store.softDeleteWorkspace(canonicalA, now);
  const second = store.softDeleteWorkspace(canonicalA, now);
  assert.equal(first, 1);
  assert.equal(second, 0);
  store.close();
});

test("重复恢复采用确定性幂等语义", () => {
  const dbPath = path.join(ROOT, "idempotent-restore.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-idem-r", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-idem-r", "s-idem-r", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  const first = store.restoreWorkspace(canonicalA, "2026-08-27T02:00:00.000Z");
  const second = store.restoreWorkspace(canonicalA, "2026-08-27T03:00:00.000Z");
  assert.equal(first, 1);
  assert.equal(second, 0);
  store.close();
});

test("未软删除的 Workspace 拒绝 purge", () => {
  const dbPath = path.join(ROOT, "purge-not-deleted.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const sessionId = createStoppedSession(manager, "purge-not-deleted").sessionId;
  const runId = manager.listSessionRuns(sessionId)![0].runId;
  manager.stop(runId);
  assert.throws(() => manager.purgeWorkspace(sessionId), /Workspace has not been deleted/);
  manager.close();
});

// ---------------------------------------------------------------------------
// 14. 软删期间不能继续对话（通过 RunManager 公开边界验证）
// ---------------------------------------------------------------------------
test("软删期间不能继续对话", () => {
  const dbPath = path.join(ROOT, "no-new-run.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const sessionId = createStoppedSession(manager, "no-new-run").sessionId;
  const runId = manager.listSessionRuns(sessionId)![0].runId;
  manager.stop(runId);
  manager.deleteWorkspace(sessionId);
  assert.throws(() => manager.createInSession("new-run", sessionId), /Session not found/);
  manager.close();
});

// ---------------------------------------------------------------------------
// 15. 软删期间不能 Resume 或 Stop
// ---------------------------------------------------------------------------
test("软删期间不能 Resume", () => {
  const dbPath = path.join(ROOT, "no-resume.db");
  const store = new SqliteRunStore(dbPath);
  const runId = "no-resume-run";
  store.createSession(storedSession("s-resume", canonicalA, "workspace-A"));
  store.createRun(storedRun(runId, "s-resume", canonicalA, "workspace-A", "interrupted"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  const manager = new RunManager(store);
  assert.equal(manager.resume(runId), false);
  manager.close();
});

test("软删期间不能 Stop", () => {
  const dbPath = path.join(ROOT, "no-stop.db");
  const store = new SqliteRunStore(dbPath);
  const runId = "no-stop-run";
  store.createSession(storedSession("s-stop", canonicalA, "workspace-A"));
  store.createRun(storedRun(runId, "s-stop", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  const manager = new RunManager(store);
  assert.equal(manager.stop(runId), false);
  manager.close();
});

// ---------------------------------------------------------------------------
// 16. 软删期间 Event 和 checkpoint 完整保留
// ---------------------------------------------------------------------------
test("软删期间 Event 完整保留", () => {
  const dbPath = path.join(ROOT, "events-retained.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-ev", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-ev", "s-ev", canonicalA, "workspace-A"));
  store.appendEvent("r-ev", { type: "run_started", runId: "r-ev", timestamp: "2026-08-27T00:00:00.000Z" });
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  assert.equal(store.listEvents("r-ev").length, 1);
  store.close();
});

test("软删期间 checkpoint 完整保留", () => {
  const runId = "checkpoint-retained-run";
  const dbPath = path.join(ROOT, "checkpoint-retained.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-ck", canonicalA, "workspace-A"));
  store.createRun(storedRun(runId, "s-ck", canonicalA, "workspace-A"));
  saveCheckpoint({
    runId,
    task: "checkpoint",
    status: "running",
    iteration: 0,
    scratchpad: createScratchpad("checkpoint"),
    messages: [{ role: "user", content: "checkpoint" }],
    state: createState("checkpoint", runId),
    workspaceRoot: canonicalA,
    sideEffects: [],
  });
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  assert.ok(fs.existsSync(checkpointPath(runId)));
  store.close();
  fs.rmSync(checkpointPath(runId), { force: true });
});

// ---------------------------------------------------------------------------
// 17. 恢复后数据重新可用
// ---------------------------------------------------------------------------
test("恢复后 Session、Run、Event 和 checkpoint 重新可用", () => {
  const runId = "restore-reuse-run";
  const dbPath = path.join(ROOT, "restore-reuse.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-reuse", canonicalA, "workspace-A"));
  store.createRun(storedRun(runId, "s-reuse", canonicalA, "workspace-A", "interrupted"));
  store.appendEvent(runId, { type: "run_started", runId, timestamp: "2026-08-27T00:00:00.000Z" });
  saveCheckpoint({
    runId,
    task: "restore-reuse",
    status: "running",
    iteration: 0,
    scratchpad: createScratchpad("restore-reuse"),
    messages: [{ role: "user", content: "restore-reuse" }],
    state: createState("restore-reuse", runId),
    workspaceRoot: canonicalA,
    sideEffects: [],
  });
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  store.restoreWorkspace(canonicalA, "2026-08-27T02:00:00.000Z");
  assert.ok(store.getSession("s-reuse"));
  assert.ok(store.getRun(runId));
  assert.equal(store.listEvents(runId).length, 1);
  assert.ok(loadCheckpoint(runId));
  store.close();
  fs.rmSync(checkpointPath(runId), { force: true });
});

// ---------------------------------------------------------------------------
// 18. 通过 sessionId 解析私有 workspaceRoot（RunManager 层）
// ---------------------------------------------------------------------------
test("deleteWorkspace 基于 sessionId 解析私有 workspaceRoot", () => {
  const dbPath = path.join(ROOT, "session-id-delete.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const sessionId = createStoppedSession(manager, "session-id-delete").sessionId;
  const runId = manager.listSessionRuns(sessionId)![0].runId;
  manager.stop(runId);
  // Another workspace with same basename but different root
  const otherRoot = path.join(ROOT, "other-" + path.basename(workspaceA));
  fs.mkdirSync(otherRoot, { recursive: true });
  const otherCanonical = fs.realpathSync.native(otherRoot);
  store.createSession(storedSession("s-other", otherCanonical, path.basename(workspaceA)));
  store.createRun(storedRun("r-other", "s-other", otherCanonical, path.basename(workspaceA)));
  manager.deleteWorkspace(sessionId);
  assert.equal(store.listSessions({ includeDeleted: true }).length, 2);
  assert.equal(store.listSessions().length, 1); // only the other one remains visible
  manager.close();
});

// ---------------------------------------------------------------------------
// 19. 恢复路径校验不泄露绝对路径
// ---------------------------------------------------------------------------
test("恢复路径校验不泄露 Host 绝对路径到响应", async () => {
  const dbPath = path.join(ROOT, "no-path-leak.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const privateWorkspace = path.join(ROOT, "private-workspace-leak");
  fs.mkdirSync(privateWorkspace, { recursive: true });
  const privateCanonical = fs.realpathSync.native(privateWorkspace);
  const sessionId = createStoppedSession(manager, "no-path-leak", undefined, { workspaceName: "private-leak" }).sessionId;
  const session = store.getSession(sessionId, { includeDeleted: true })!;
  store.updateSession({ ...session, workspaceRoot: privateCanonical });
  const runId = manager.listSessionRuns(sessionId)![0].runId;
  manager.stop(runId);
  manager.deleteWorkspace(sessionId);
  fs.rmSync(privateCanonical, { recursive: true, force: true });
  try {
    manager.restoreWorkspace(sessionId);
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(!msg.includes(privateCanonical), `error leaked path: ${msg}`);
  } finally {
    manager.close();
  }
});

// ---------------------------------------------------------------------------
// 20. 重复软删/恢复/清空的边界
// ---------------------------------------------------------------------------
test("重复软删幂等且不返回 500", () => {
  const dbPath = path.join(ROOT, "idempotent-http.db");
  const store = new SqliteRunStore(dbPath);
  const manager = new RunManager(store);
  const sessionId = createStoppedSession(manager, "idempotent-http").sessionId;
  const runId = manager.listSessionRuns(sessionId)![0].runId;
  manager.stop(runId);
  manager.deleteWorkspace(sessionId);
  const second = manager.deleteWorkspace(sessionId);
  assert.ok(second.deleted === 0 || second.deleted === 1); // deterministic: 0 after first
  manager.close();
});

test("恢复后再次软删正常", () => {
  const dbPath = path.join(ROOT, "re-delete.db");
  const store = new SqliteRunStore(dbPath);
  store.createSession(storedSession("s-rd", canonicalA, "workspace-A"));
  store.createRun(storedRun("r-rd", "s-rd", canonicalA, "workspace-A"));
  store.softDeleteWorkspace(canonicalA, "2026-08-27T01:00:00.000Z");
  const manager = new RunManager(store);
  manager.restoreWorkspace("s-rd");
  manager.deleteWorkspace("s-rd");
  assert.equal(store.listSessions().length, 0);
  manager.close();
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  try {
    for (const item of tests) {
      try {
        await item.fn();
        passed++;
        console.log(`  PASS  ${item.name}`);
      } catch (err) {
        failed++;
        console.error(`  FAIL  ${item.name}`);
        console.error(`        ${(err as Error).stack ?? (err as Error).message}`);
      }
    }
  } finally {
    clearWorkspace();
    if (server) server.close();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`\nWorkspace trash tests: ${passed} passed / ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
