// 模块: grep 工具单元测试 — 递归搜索、workspace 边界、结果限制
// 用法: npx tsx tests/grep-tools.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute, getSchemas, validateToolResult, type ToolContext } from "../src/tools/tools.js";
import "../src/tools/runtime-tools.js"; // 副作用：注册 grep / shell / moveFile / deleteFile

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-grep-test-"));
process.env.SANDBOX_ROOT = TEST_ROOT;

const RUN = "grep-test";
import { createWorkspace } from "../src/sandbox/sandbox-manager.js";
const root = createWorkspace(RUN);
const ctx: ToolContext = { runId: RUN, workspaceRoot: root };

fs.writeFileSync(path.join(root, "work", "a.txt"), "hello world\nfoo bar\n", "utf8");
fs.mkdirSync(path.join(root, "work", "sub"), { recursive: true });
fs.writeFileSync(path.join(root, "work", "sub", "b.txt"), "hello node\nbaz qux\n", "utf8");
fs.writeFileSync(path.join(root, "work", "sub", "c.bin"), Buffer.from([0x00, 0x01, 0x02]), "utf8");
fs.writeFileSync(path.join(root, "work", "big.txt"), "x".repeat(2 * 1024 * 1024), "utf8"); // 2MB
const OUTSIDE = path.join(TEST_ROOT, "grep-outside.txt");
fs.writeFileSync(OUTSIDE, "secret outside", "utf8");

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

// ---- 1. 单文件搜索 ----
test("grep 单文件搜索找到匹配", async () => {
  const res = await execute("grep", { pattern: "hello", path: "work/a.txt" }, ctx);
  assert.ok(res.includes("找到 1 处匹配"), `结果: ${res}`);
  assert.ok(res.includes("work/a.txt:1:hello world"));
});

test("grep 单文件无匹配 → 未找到", async () => {
  const res = await execute("grep", { pattern: "nonexistent", path: "work/a.txt" }, ctx);
  assert.ok(res.includes('未找到 "nonexistent"'), `结果: ${res}`);
});

// ---- 2. 目录递归搜索 ----
test("grep 目录递归搜索跨子目录", async () => {
  const res = await execute("grep", { pattern: "hello", path: "work" }, ctx);
  assert.ok(res.includes("找到 2 处匹配"), `结果: ${res}`);
  assert.ok(res.includes("work/a.txt:1:hello world"));
  assert.ok(res.includes("work/sub/b.txt:1:hello node"));
});

// ---- 3. 跳过二进制和超大文件 ----
test("grep 跳过二进制文件与超大文件", async () => {
  const res = await execute("grep", { pattern: "x", path: "work" }, ctx);
  assert.ok(!res.includes("c.bin"), "应跳过二进制文件");
  assert.ok(!res.includes("big.txt"), "应跳过超大文件");
});

// ---- 4. maxResults 限制 ----
test("grep maxResults 限制返回行数", async () => {
  const res = await execute("grep", { pattern: "o", path: "work", maxResults: 1 }, ctx);
  const lines = res.split("\n").filter((l) => l.includes(":"));
  assert.equal(lines.length, 1, `应只返回 1 行: ${res}`);
});

// ---- 5. workspace 外路径拒绝 ----
test("grep 拒绝 workspace 外路径", async () => {
  await assert.rejects(() => execute("grep", { pattern: "secret", path: OUTSIDE }, ctx), /路径被拒绝/);
});

// ---- 6. 隐藏别名 searchText 仍可执行 ----
test("searchText 别名仍可执行（兼容旧调用方）", async () => {
  const res = await execute("searchText", { path: "work/a.txt", pattern: "hello" }, ctx);
  assert.ok(res.includes("找到 1 处"), `结果: ${res}`);
});

// ---- 7. Schema 包含 grep 但不含 searchText ----
test("grep 在 Schema 中注册，searchText 不在", () => {
  const names = getSchemas().map((s) => s.function.name);
  assert.ok(names.includes("grep"));
  assert.ok(!names.includes("searchText"));
});

// ---- 8. 超大文件搜索 → invalid result ----
test("grep 直接搜索超大文件 → tool_result_invalid", async () => {
  const res = await execute("grep", { pattern: "x", path: "work/big.txt" }, ctx);
  assert.ok(res.includes("文件过大"), `结果: ${res}`);
  assert.equal(validateToolResult("grep", res).valid, false);
});

// ---- 汇总 ----
console.log(`\ngrep 工具测试汇总: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exitCode = 1;
else console.log("验收：grep 递归搜索、边界限制、兼容别名成立 ✓");
