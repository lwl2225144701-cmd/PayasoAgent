// 模块: 只读 Sandbox 文件工具单元测试（listDir / readFile）— 无 LLM，秒级完成
// 用法: npx tsx tests/filesystem-tools.test.ts   （或 npm run test:tools）
// 覆盖：正常 / 不存在 / 目录文件互指 / 穿越 / 绝对路径 / symlink 逃逸 / 超大 / 二进制 / Schema 无泄露

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute, getSchemas, validateToolResult, type ToolContext } from "../src/tools/tools.js";
import "../src/tools/filesystem.js"; // 副作用：注册 listDir / readFile
import { createWorkspace, cleanupWorkspace } from "../src/sandbox/sandbox-manager.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-fs-test-"));
process.env.SANDBOX_ROOT = TEST_ROOT;

const RUN = "fs-test";
const root = createWorkspace(RUN);
const ctx: ToolContext = { runId: RUN, workspaceRoot: root };

// ---- 预置工作区内容 ----
fs.writeFileSync(path.join(root, "input", "demo.txt"), "hello sandbox");
fs.writeFileSync(path.join(root, "work", "a.txt"), "aaa");
fs.mkdirSync(path.join(root, "work", "sub"), { recursive: true });
fs.writeFileSync(path.join(root, "output", "big.txt"), Buffer.alloc(2 * 1024 * 1024, 0x61)); // 2MB
fs.writeFileSync(path.join(root, "work", "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
const OUTSIDE = path.join(TEST_ROOT, "..", "fs-outside.txt");
fs.writeFileSync(OUTSIDE, "secret outside");
fs.symlinkSync(OUTSIDE, path.join(root, "work", "evil-link"));

interface Case {
  name: string;
  fn: () => void | Promise<void>;
}
const tests: Case[] = [];
let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// ---- 1. 正常 ----
test("listDir('work') 返回条目名与类型（file/directory），无宿主绝对路径", async () => {
  const res = await execute("listDir", { path: "work" }, ctx);
  assert.ok(res.includes("a.txt"), "缺少 a.txt");
  assert.ok(res.includes("sub"), "缺少 sub");
  assert.ok(res.includes("[file] a.txt"), "类型标注缺失");
  assert.ok(res.includes("[directory] sub"), "目录类型标注缺失");
  assert.ok(!res.includes(TEST_ROOT), "泄露了宿主机绝对路径");
});

test("listDir('input') 列出 demo.txt", async () => {
  const res = await execute("listDir", { path: "input" }, ctx);
  assert.ok(res.includes("demo.txt"));
});

test("readFile('input/demo.txt') 返回 UTF-8 内容", async () => {
  const res = await execute("readFile", { path: "input/demo.txt" }, ctx);
  assert.equal(res, "hello sandbox");
});

// ---- 2. 不存在 ----
test("listDir 目录不存在 → tool_error", async () => {
  await assert.rejects(() => execute("listDir", { path: "nope" }, ctx));
});

test("readFile 文件不存在 → tool_error", async () => {
  await assert.rejects(() => execute("readFile", { path: "nope.txt" }, ctx));
});

// ---- 3. 目录/文件互指 ----
test("readFile 读取目录 → tool_error", async () => {
  await assert.rejects(() => execute("readFile", { path: "work" }, ctx));
});

test("listDir 指向文件 → tool_error", async () => {
  await assert.rejects(() => execute("listDir", { path: "input/demo.txt" }, ctx));
});

// ---- 4. 路径穿越 / 绝对路径（BLOCKED）----
test("readFile '../package.json' → BLOCKED", async () => {
  await assert.rejects(() => execute("readFile", { path: "../package.json" }, ctx));
});

test("readFile '/etc/passwd' → BLOCKED", async () => {
  await assert.rejects(() => execute("readFile", { path: "/etc/passwd" }, ctx));
});

test("BLOCKED 错误消息不泄露宿主机绝对路径", async () => {
  try {
    await execute("readFile", { path: "../package.json" }, ctx);
    assert.fail("应当被拒绝");
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(!msg.includes(TEST_ROOT), `错误消息泄露路径: ${msg}`);
    assert.ok(msg.includes("../package.json"), "应回显相对路径");
  }
});

// ---- 5. symlink 逃逸（BLOCKED）----
test("readFile symlink 指向 workspace 外 → BLOCKED", async () => {
  await assert.rejects(() => execute("readFile", { path: "work/evil-link" }, ctx));
});

test("listDir symlink 指向 workspace 外 → BLOCKED", async () => {
  await assert.rejects(() => execute("listDir", { path: "work/evil-link" }, ctx));
});

// ---- 6. 超大文件 / 二进制 → invalid result ----
test("readFile 超大文件（2MB > 1MB 限制）→ tool_result_invalid", async () => {
  const res = await execute("readFile", { path: "output/big.txt" }, ctx);
  assert.ok(res.includes("文件过大"), `结果: ${res}`);
  const v = validateToolResult("readFile", res);
  assert.equal(v.valid, false, "应判为 invalid");
});

test("readFile 二进制文件 → tool_result_invalid", async () => {
  const res = await execute("readFile", { path: "work/bin.dat" }, ctx);
  assert.ok(res.includes("二进制"), `结果: ${res}`);
  const v = validateToolResult("readFile", res);
  assert.equal(v.valid, false, "应判为 invalid");
});

// ---- 7. Schema 无泄露 ----
test("LLM Schema 无 runId、无宿主机绝对路径", () => {
  const json = JSON.stringify(getSchemas());
  assert.ok(!json.includes("runId"), 'Schema 中出现 "runId"');
  assert.ok(!json.includes(TEST_ROOT), "Schema 中出现宿主机绝对路径");
  assert.ok(!json.includes("/Users"), "Schema 中出现 /Users 绝对路径");
});

test("listDir / readFile 的 Tool Schema 已注册", () => {
  const names = getSchemas().map((s) => s.function.name);
  assert.ok(names.includes("listDir"));
  assert.ok(names.includes("readFile"));
});

// ---- 汇总 ----
async function main(): Promise<void> {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failed++;
      const msg = (err as Error).message;
      failures.push(`${t.name} — ${msg}`);
      console.log(`  [FAIL] ${t.name} — ${msg}`);
    }
  }
  cleanupWorkspace(RUN);
  fs.rmSync(OUTSIDE, { force: true });
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  console.log("\n" + "=".repeat(56));
  console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) {
    failures.forEach((f) => console.log(`  FAIL ${f}`));
    process.exit(1);
  }
  console.log("验收：正常读取 PASS，所有逃逸/超大/二进制处理正确 ✓");
}

main();
