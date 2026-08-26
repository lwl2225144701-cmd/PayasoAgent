// Deterministic Workspace v1 acceptance: Host model, real-root file tools,
// two-root isolation, and macOS shell confinement. No LLM/network required.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execute, getSchemas, type ToolContext } from "../src/tools/tools.js";
import "../src/tools/filesystem.js";
import "../src/tools/runtime-tools.js";
import { clearWorkspace, getWorkspace, setWorkspace, workspacePublicView } from "../src/host/workspace.js";
import { createHostServer, RunManager } from "../src/host/server.js";
import { checkpointPath, loadCheckpoint, saveCheckpoint } from "../src/runtime/checkpoint.js";
import { probeSandboxAvailability } from "../src/sandbox/macos-sandbox.js";
import { createScratchpad } from "../src/runtime/scratchpad.js";
import { createState } from "../src/runtime/state.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-workspace-v1-"));
process.env.SANDBOX_ROOT = path.join(base, "runtime-sandbox");
const rootA = path.join(base, "workspace-A");
const rootB = path.join(base, "workspace-B");
fs.mkdirSync(rootA, { recursive: true });
fs.mkdirSync(rootB, { recursive: true });
const outsideFile = path.join(base, "outside.txt");
const outsideDir = path.join(base, "outside-dir");
fs.mkdirSync(outsideDir, { recursive: true });
fs.writeFileSync(outsideFile, "OUTSIDE-UNCHANGED", "utf8");
fs.writeFileSync(path.join(rootB, "b-only.txt"), "B-SECRET", "utf8");
fs.writeFileSync(path.join(outsideDir, "secret.txt"), "DIR-SECRET", "utf8");
fs.symlinkSync(outsideFile, path.join(rootA, "outside-link"));
fs.symlinkSync(outsideDir, path.join(rootA, "outside-dir-link"));

const canonicalA = fs.realpathSync.native(rootA);
const canonicalB = fs.realpathSync.native(rootB);
const ctxA: ToolContext = { runId: "workspace-run-a", workspaceRoot: canonicalA };
const ctxB: ToolContext = { runId: "workspace-run-b", workspaceRoot: canonicalB };

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, fn }); }

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function denied(tool: string, args: Record<string, unknown>, context = ctxA): Promise<void> {
  await assert.rejects(() => execute(tool, args, context));
}

test("Workspace 最小模型：set/get/clear + realpath canonicalize", () => {
  clearWorkspace();
  assert.equal(getWorkspace(), null);
  const selected = setWorkspace(rootA);
  assert.deepEqual(selected, { rootPath: canonicalA, name: "workspace-A" });
  assert.deepEqual(getWorkspace(), selected);
  assert.deepEqual(workspacePublicView(selected), { name: "workspace-A" });
  assert.ok(!JSON.stringify(workspacePublicView(selected)).includes(canonicalA));
  clearWorkspace();
  assert.equal(getWorkspace(), null);
});

test("Workspace 拒绝相对路径、不存在路径和普通文件", () => {
  assert.throws(() => setWorkspace("workspace-A"));
  assert.throws(() => setWorkspace(path.join(base, "missing")));
  assert.throws(() => setWorkspace(outsideFile));
});

test("Host Workspace API 只返回 name，不常规暴露真实绝对路径", async () => {
  setWorkspace(rootA);
  const server = createHostServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/workspace`);
    const body = await response.json() as { workspace: { name: string } | null };
    assert.deepEqual(body, { workspace: { name: "workspace-A" } });
    assert.ok(!JSON.stringify(body).includes(canonicalA));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearWorkspace();
  }
});

test("Host 拒绝超过 64KB 的 Run 请求体（Content-Length + chunked）", async () => {
  const server = createHostServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "x".repeat(70 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json() as { error: string }).error, "payload_too_large");

    const chunkedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/runs",
        method: "POST",
        headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      request.on("error", reject);
      request.write('{"task":"');
      request.write("x".repeat(70 * 1024));
      request.end('"}');
    });
    assert.equal(chunkedStatus, 413);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Run 创建时快照绑定当前 Workspace，之后更换不影响既有 Run", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "<think>private</think>done", reasoning_content: "private-reasoning" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  const manager = new RunManager();
  let runA = "";
  let runB = "";
  try {
    setWorkspace(rootA);
    runA = manager.create("A");
    setWorkspace(rootB);
    runB = manager.create("B");
    assert.equal(manager.getWorkspaceRoot(runA), canonicalA);
    assert.equal(manager.getWorkspaceRoot(runB), canonicalB);
    assert.deepEqual(manager.get(runA)?.workspace, { name: "workspace-A" });
    assert.deepEqual(manager.get(runB)?.workspace, { name: "workspace-B" });
    assert.ok(!JSON.stringify(manager.list()).includes(canonicalA));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(!JSON.stringify(loadCheckpoint(runA)?.messages).includes("<think>"));
    assert.ok(!JSON.stringify(loadCheckpoint(runA)?.messages).includes("private-reasoning"));
  } finally {
    globalThis.fetch = originalFetch;
    clearWorkspace();
    if (runA) fs.rmSync(checkpointPath(runA), { force: true });
    if (runB) fs.rmSync(checkpointPath(runB), { force: true });
  }
});

test("Host stop 记录 run_stopped SSE 终态事件", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => await new Promise<Response>(() => {});
  const manager = new RunManager();
  const chunks: string[] = [];
  try {
    const runId = manager.create("stop-event");
    assert.equal(manager.subscribe(runId, {
      write: (chunk) => chunks.push(chunk),
      end: () => {},
      closed: () => false,
    }), true);
    assert.equal(manager.stop(runId), true);
    assert.equal(manager.get(runId)?.status, "stopped");
    assert.ok(chunks.some((chunk) => chunk.includes("event: run_stopped")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Host resume 拒绝对同一 running runId 启动第二个 Agent", () => {
  const runId = "workspace-resume-guard";
  const task = "resume-guard";
  saveCheckpoint({
    runId,
    task,
    status: "running",
    iteration: 0,
    scratchpad: createScratchpad(task),
    messages: [{ role: "user", content: task }],
    state: createState(task, runId),
    workspaceRoot: canonicalA,
    sideEffects: [],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => await new Promise<Response>(() => {});
  const manager = new RunManager();
  try {
    assert.equal(manager.resume(runId), true);
    const active = manager.getRaw(runId);
    assert.equal(manager.resume(runId), false);
    assert.equal(manager.getRaw(runId), active);
    assert.equal(manager.get(runId)?.status, "running");
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(checkpointPath(runId), { force: true });
  }
});

test("Checkpoint 采用同目录临时文件原子替换，不遗留 tmp", () => {
  const runId = "workspace-checkpoint-atomic";
  const make = (task: string) => ({
    runId,
    task,
    status: "running",
    iteration: 0,
    scratchpad: createScratchpad(task),
    messages: [{ role: "user" as const, content: task }],
    state: createState(task, runId),
    workspaceRoot: canonicalA,
    sideEffects: [],
  });
  const file = checkpointPath(runId);
  try {
    saveCheckpoint(make("first"));
    saveCheckpoint(make("second"));
    assert.equal(loadCheckpoint(runId)?.task, "second");
    const prefix = `${path.basename(file)}.`;
    assert.ok(!fs.readdirSync(path.dirname(file)).some((name) => name.startsWith(prefix) && name.endsWith(".tmp")));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("Tool Schema 不泄露 workspaceRoot/runId/宿主绝对路径", () => {
  const schemas = JSON.stringify(getSchemas());
  assert.ok(!schemas.includes("workspaceRoot"));
  assert.ok(!schemas.includes("runId"));
  assert.ok(!schemas.includes(canonicalA));
});

test("真实 Workspace 内：write/read/list/search/create/move/delete 正常", async () => {
  await execute("writeFile", { path: "work-test.txt", content: "hello" }, ctxA);
  assert.equal(await execute("readFile", { path: "work-test.txt" }, ctxA), "hello");
  assert.match(await execute("listDir", { path: "." }, ctxA), /work-test\.txt/);
  assert.match(await execute("searchText", { path: "work-test.txt", pattern: "hello" }, ctxA), /找到 1 处/);
  await execute("createDir", { path: "generated" }, ctxA);
  await execute("moveFile", { source: "work-test.txt", target: "generated/moved.txt" }, ctxA);
  assert.equal(fs.readFileSync(path.join(rootA, "generated", "moved.txt"), "utf8"), "hello");
  await execute("deleteFile", { path: "generated/moved.txt" }, ctxA);
  assert.ok(!fs.existsSync(path.join(rootA, "generated", "moved.txt")));
});

test("Workspace 外文件攻击：../、绝对路径、symlink 的读写删除全部拒绝", async () => {
  await denied("readFile", { path: "../outside.txt" });
  await denied("readFile", { path: outsideFile });
  await denied("readFile", { path: "outside-link" });
  await denied("listDir", { path: "outside-dir-link" });
  await denied("writeFile", { path: "../outside.txt", content: "HACKED" });
  await denied("writeFile", { path: outsideFile, content: "HACKED" });
  await denied("writeFile", { path: "outside-link", content: "HACKED" });
  await denied("deleteFile", { path: "../outside.txt" });
  await denied("deleteFile", { path: outsideFile });
  await denied("deleteFile", { path: "outside-link" });
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "OUTSIDE-UNCHANGED");
});

test("Run A/B 真实隔离：绝对路径、../ 与 symlink 均不能跨 Workspace", async () => {
  await execute("writeFile", { path: "a-only.txt", content: "A" }, ctxA);
  await execute("writeFile", { path: "b-write.txt", content: "B" }, ctxB);
  await denied("readFile", { path: canonicalB + "/b-only.txt" }, ctxA);
  await denied("readFile", { path: "../workspace-B/b-only.txt" }, ctxA);
  fs.symlinkSync(path.join(rootB, "b-only.txt"), path.join(rootA, "b-link"));
  await denied("readFile", { path: "b-link" }, ctxA);
  await denied("readFile", { path: canonicalA + "/a-only.txt" }, ctxB);
  assert.equal(fs.readFileSync(path.join(rootA, "a-only.txt"), "utf8"), "A");
  assert.equal(fs.readFileSync(path.join(rootB, "b-write.txt"), "utf8"), "B");
});

if (process.platform === "darwin") {
  test("Shell 使用同一真实 Workspace Root，cwd/读写和 Node/npm 可用", async () => {
    if (!(await probeSandboxAvailability())) {
      // Fail-closed: shell must refuse rather than run unsandboxed.
      await assert.rejects(() => execute("shell", { command: "pwd" }, ctxA), /unavailable/i);
      return;
    }
    const pwd = await execute("shell", { command: "pwd" }, ctxA);
    assert.ok(pwd.includes(canonicalA));
    await execute("shell", { command: "printf hello > shell-test.txt" }, ctxA);
    const cat = await execute("shell", { command: "cat shell-test.txt" }, ctxA);
    assert.match(cat, /hello/);
    const versions = await execute("shell", { command: "node --version && npm --version" }, ctxA);
    assert.match(versions, /shell-exit-0/);
    assert.ok(!fs.readdirSync(rootA).some((name) => name.startsWith(".payaso-shell-")));
  });

  test("Shell 外部绝对路径、重定向、删除、子进程全部被 OS Sandbox 拒绝", async () => {
    if (!(await probeSandboxAvailability())) {
      // Fail-closed: shell must refuse rather than run unsandboxed.
      await assert.rejects(() => execute("shell", { command: "pwd" }, ctxA), /unavailable/i);
      return;
    }
    await denied("shell", { command: "cat " + quote(outsideFile) });
    await denied("shell", { command: "printf HACKED > " + quote(outsideFile) });
    await denied("shell", { command: "rm -f " + quote(outsideFile) });
    await denied("shell", { command: "sh -c " + quote("cat " + quote(outsideFile)) });
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "OUTSIDE-UNCHANGED");
  });
}

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
        console.error(`        ${(err as Error).message}`);
      }
    }
  } finally {
    clearWorkspace();
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(`\nworkspace 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

void main();
