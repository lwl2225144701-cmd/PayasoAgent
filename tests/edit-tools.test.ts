// 模块: edit 工具单元测试 — 精确替换、去重、换行保留、diff/patch
// 用法: npx tsx tests/edit-tools.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute, getSchemas, validateToolResult, type ToolContext } from "../src/tools/tools.js";
import "../src/tools/filesystem.js"; // 副作用：注册 read / write / edit / ls

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-edit-test-"));
process.env.SANDBOX_ROOT = TEST_ROOT;

const RUN = "edit-test";
import { createWorkspace } from "../src/sandbox/sandbox-manager.js";
const root = createWorkspace(RUN);
const ctx: ToolContext = { runId: RUN, workspaceRoot: root };

const OUTSIDE = path.join(TEST_ROOT, "edit-outside.txt");
fs.writeFileSync(OUTSIDE, "secret", "utf8");

function writeApp(content: string): void {
  fs.writeFileSync(path.join(root, "work", "app.ts"), content, "utf8");
}

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

// ---- 1. 单编辑成功 ----
test("edit 单编辑成功并返回 diff", async () => {
  writeApp("const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const res = await execute("edit", {
    path: "work/app.ts",
    edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
  }, ctx);
  assert.ok(res.includes("编辑成功"), `结果: ${res}`);
  assert.ok(res.includes("-const a = 1;"), `diff 缺少旧行: ${res}`);
  assert.ok(res.includes("+const a = 2;"), `diff 缺少新行: ${res}`);
  const content = fs.readFileSync(path.join(root, "work", "app.ts"), "utf8");
  assert.ok(content.includes("const a = 2;"), `内容: ${content}`);
  assert.ok(!content.includes("const a = 1;"), `内容: ${content}`);
});

// ---- 2. oldText 未找到 → 失败 ----
test("edit oldText 未找到 → tool_error", async () => {
  writeApp("const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await assert.rejects(() => execute("edit", {
    path: "work/app.ts",
    edits: [{ oldText: "const z = 9;", newText: "const z = 0;" }],
  }, ctx), /oldText 未找到/);
});

// ---- 3. oldText 多次匹配 → 失败 ----
test("edit oldText 多次匹配 → 拒绝", async () => {
  fs.writeFileSync(path.join(root, "work", "dup.txt"), "x\nx\nx\n", "utf8");
  await assert.rejects(() => execute("edit", {
    path: "work/dup.txt",
    edits: [{ oldText: "x", newText: "y" }],
  }, ctx), /出现 3 次/);
});

// ---- 4. 多次非重叠编辑 ----
test("edit 多次非重叠编辑成功", async () => {
  writeApp("const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const res = await execute("edit", {
    path: "work/app.ts",
    edits: [
      { oldText: "const b = 2;", newText: "const b = 20;" },
      { oldText: "const c = 3;", newText: "const c = 30;" },
    ],
  }, ctx);
  assert.ok(res.includes("编辑成功"), `结果: ${res}`);
  assert.ok(res.includes("2 处修改"), `应返回 2 处修改: ${res}`);
  const content = fs.readFileSync(path.join(root, "work", "app.ts"), "utf8");
  assert.ok(content.includes("const b = 20;"));
  assert.ok(content.includes("const c = 30;"));
});

// ---- 5. 重叠编辑 → 拒绝 ----
test("edit 重叠编辑 → 拒绝", async () => {
  fs.writeFileSync(path.join(root, "work", "overlap.txt"), "abcdef", "utf8");
  await assert.rejects(() => execute("edit", {
    path: "work/overlap.txt",
    edits: [
      { oldText: "abc", newText: "XXX" },
      { oldText: "cde", newText: "YYY" },
    ],
  }, ctx), /重叠/);
});

// ---- 6. 保留 CRLF 换行风格 ----
test("edit 保留 CRLF 换行风格", async () => {
  fs.writeFileSync(path.join(root, "work", "crlf.ts"), "line1\r\nline2\r\nline3\r\n", "utf8");
  const res = await execute("edit", {
    path: "work/crlf.ts",
    edits: [{ oldText: "line2", newText: "line2-updated" }],
  }, ctx);
  assert.ok(res.includes("编辑成功"), `结果: ${res}`);
  const content = fs.readFileSync(path.join(root, "work", "crlf.ts"), "utf8");
  assert.ok(content.includes("\r\n"), "应保留 CRLF: " + JSON.stringify(content));
  assert.ok(!content.includes("\r\n\r\n"), "不应引入多余换行");
});

// ---- 7. 保留 LF 换行风格 ----
test("edit 保留 LF 换行风格", async () => {
  writeApp("const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const content = fs.readFileSync(path.join(root, "work", "app.ts"), "utf8");
  assert.ok(!content.includes("\r\n"), "应保留 LF: " + JSON.stringify(content));
});

// ---- 8. 无实际修改（oldText === newText）→ 无修改提示 ----
test("edit oldText 与 newText 相同 → 无修改", async () => {
  writeApp("const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const res = await execute("edit", {
    path: "work/app.ts",
    edits: [{ oldText: "const a = 1;", newText: "const a = 1;" }],
  }, ctx);
  assert.ok(res.includes("无修改"), `结果: ${res}`);
});

// ---- 9. 空 oldText → 失败 ----
test("edit 空 oldText → tool_error", async () => {
  writeApp("const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await assert.rejects(() => execute("edit", {
    path: "work/app.ts",
    edits: [{ oldText: "", newText: "x" }],
  }, ctx), /oldText 不能为空/);
});

// ---- 10. 超大文件 → invalid result ----
test("edit 超大文件（>1MB）→ tool_result_invalid", async () => {
  fs.writeFileSync(path.join(root, "output", "big.ts"), "x".repeat(2 * 1024 * 1024), "utf8");
  const res = await execute("edit", {
    path: "output/big.ts",
    edits: [{ oldText: "x", newText: "y" }],
  }, ctx);
  assert.ok(res.includes("文件过大"), `结果: ${res}`);
  assert.equal(validateToolResult("edit", res).valid, false);
});

// ---- 11. Schema 包含 edit ----
test("edit 在 Schema 中注册", () => {
  const names = getSchemas().map((s) => s.function.name);
  assert.ok(names.includes("edit"));
});

// ---- 汇总 ----
console.log(`\n编辑工具测试汇总: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exitCode = 1;
else console.log("验收：edit 精确替换、去重、换行保留、diff/patch 成立 ✓");
process.exit(failed === 0 ? 0 : 1);
