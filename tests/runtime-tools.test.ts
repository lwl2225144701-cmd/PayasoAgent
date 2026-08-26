// 套件: Runtime 工具移植验证 — writeFile 往返 + moveFile 防重放(idle) + ./ 路径归一化 identity 一致
// 覆盖：新移植工具可用性 + v1.5 身份机制（路径类工具用 canonicalPathKey 归一化 ./ 与根段为同一 identity）。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute, getTool, getSchemas, type ToolContext } from "../src/tools/tools.js";
import "../src/tools/filesystem.js"; // 副作用：注册 listDir / readFile / writeFile
import "../src/tools/runtime-tools.js"; // 副作用：注册 searchText / createDir / moveFile / deleteFile / shell
import {
  createSideEffectGuard,
  getReplay,
  markExecuted,
  operationIdentity,
} from "../src/runtime/side-effect.js";
import { createWorkspace, cleanupWorkspace } from "../src/sandbox/sandbox-manager.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-runtime-tools-"));
process.env.SANDBOX_ROOT = TEST_ROOT;

const RUN = "runtime-tools-test";
const root = createWorkspace(RUN);
const ctx: ToolContext = { runId: RUN, workspaceRoot: root };

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

// ---- 1. 工具已注册 ----
test("searchText / createDir / moveFile / deleteFile / shell / writeFile 均已注册", () => {
  const names = getSchemas().map((s) => s.function.name);
  for (const n of ["searchText", "createDir", "moveFile", "deleteFile", "shell", "writeFile"]) {
    assert.ok(names.includes(n), `缺少工具 ${n}`);
  }
});

// ---- 2. writeFile 往返（写入 → readFile 读回）----
test("writeFile 往返：写入 work/note.txt 后可 readFile 读回", async () => {
  const w = await execute("writeFile", { path: "work/note.txt", content: "hello" }, ctx);
  assert.ok(w.includes("写入成功"), `写入结果: ${w}`);
  const r = await execute("readFile", { path: "work/note.txt" }, ctx);
  assert.equal(r, "hello");
});

test("writeFile 禁止写入 input/（只读白名单）", async () => {
  await assert.rejects(() => execute("writeFile", { path: "input/x.txt", content: "no" }, ctx));
});

// ---- 3. ./ 路径归一化 → 同一 identity ----
test("writeFile：./work/note.txt 与 work/note.txt 归一化为同一 identity", () => {
  const t = getTool("writeFile")!;
  const a = operationIdentity(t, { path: "./work/note.txt", content: "hello" }, ctx);
  const b = operationIdentity(t, { path: "work/note.txt", content: "hello" }, ctx);
  assert.equal(a, b, `identity 不一致: ${a} vs ${b}`);
});

test("moveFile：./work/m/n.txt 与 work/m/n.txt 源/目标归一化为同一 identity", () => {
  const t = getTool("moveFile")!;
  const a = operationIdentity(
    t,
    { source: "./work/m/n.txt", target: "./work/t/n.txt" },
    ctx
  );
  const b = operationIdentity(t, { source: "work/m/n.txt", target: "work/t/n.txt" }, ctx);
  assert.equal(a, b, `identity 不一致: ${a} vs ${b}`);
});

test("归一化 identity 不泄露宿主机绝对路径", () => {
  const t = getTool("writeFile")!;
  const key = operationIdentity(t, { path: "./work/note.txt", content: "hello" }, ctx);
  assert.ok(!key.includes(TEST_ROOT), `identity 泄露绝对路径: ${key}`);
});

// ---- 4. moveFile 防重放（idle）：同 canonical identity 回放，不重复执行副作用 ----
test("moveFile 防重放：成功执行后同 identity 请求回放（idle），源不重复移动", async () => {
  const t = getTool("moveFile")!;
  fs.writeFileSync(path.join(root, "work", "idle-src.txt"), "data");

  const g = createSideEffectGuard();
  // 首次：无回放 → 真实执行 + 记录
  assert.equal(getReplay(g, t, { source: "work/idle-src.txt", target: "work/idle-dst.txt" }, ctx), undefined);
  const r1 = await execute("moveFile", { source: "work/idle-src.txt", target: "work/idle-dst.txt" }, ctx);
  markExecuted(g, t, { source: "work/idle-src.txt", target: "work/idle-dst.txt" }, r1, ctx);
  // 源已被移动；目标已存在
  assert.ok(!fs.existsSync(path.join(root, "work", "idle-src.txt")));
  assert.ok(fs.existsSync(path.join(root, "work", "idle-dst.txt")));

  // 重复请求（同一归一化 identity，含 ./ 变体）：回放，不再次移动源
  const replayed = getReplay(g, t, { source: "./work/idle-src.txt", target: "work/idle-dst.txt" }, ctx);
  assert.equal(replayed, r1, "同 identity 应回放首次结果");
  // 目标内容仍为首次移动后的数据，源没有被再次创建
  assert.equal(fs.readFileSync(path.join(root, "work", "idle-dst.txt"), "utf8"), "data");
  assert.ok(!fs.existsSync(path.join(root, "work", "idle-src.txt")));
});

// ---- 汇总 ----
async function main() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  PASS  ${t.name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${(e as Error).message}`);
    }
  }
  cleanupWorkspace(RUN);
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  console.log(`\nruntime-tools 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
  else console.log("验收：新工具可用 + 身份机制（./ 路径归一化 + non_idempotent 防重放）成立 ✓");
}

main();
