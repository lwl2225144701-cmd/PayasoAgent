// 模块: grep 工具单元测试 — 递归搜索、workspace 边界、结果限制
// 用法: npx tsx tests/grep-tools.test.ts

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  execute as executeRaw,
  getSchemas,
  normalizeToolResult,
  type ToolContext,
  validateToolResult,
} from '../src/tools/tools.js';

// 测试按文本结果断言：execute 可能返回多模态结果（文本+图片引用），统一取文本部分。
async function execute(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  return normalizeToolResult(await executeRaw(name, args, context)).text;
}

import '../src/tools/runtime-tools.js'; // 副作用：注册 grep / glob / shell / moveFile / deleteFile
import { SEARCH_MAX_FILE_BYTES } from '../src/tools/workspace-scan.js';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-grep-test-'));
process.env.SANDBOX_ROOT = TEST_ROOT;

const RUN = 'grep-test';

import { createWorkspace } from '../src/sandbox/sandbox-manager.js';

const root = createWorkspace(RUN);
const ctx: ToolContext = { runId: RUN, workspaceRoot: root };

fs.writeFileSync(path.join(root, 'work', 'a.txt'), 'hello world\nfoo bar\n', 'utf8');
fs.mkdirSync(path.join(root, 'work', 'sub'), { recursive: true });
fs.writeFileSync(path.join(root, 'work', 'sub', 'b.txt'), 'hello node\nbaz qux\n', 'utf8');
fs.writeFileSync(path.join(root, 'work', 'sub', 'c.bin'), Buffer.from([0x00, 0x01, 0x02]), 'utf8');
// 超过搜索阈值才应被跳过（v1.9 阈值从 64KB 提升到 8MB：源码文件不再被静默漏搜）
fs.writeFileSync(path.join(root, 'work', 'big.txt'), 'x'.repeat(SEARCH_MAX_FILE_BYTES + 1), 'utf8');
const OUTSIDE = path.join(TEST_ROOT, 'grep-outside.txt');
fs.writeFileSync(OUTSIDE, 'secret outside', 'utf8');

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

// ---- 1. 单文件搜索 ----
await test('grep 单文件搜索找到匹配（按文件分组输出）', async () => {
  const res = await execute('grep', { pattern: 'hello', path: 'work/a.txt' }, ctx);
  assert.ok(res.includes('找到 1 处匹配'), `结果: ${res}`);
  assert.ok(res.includes('work/a.txt'), `应含文件名分组: ${res}`);
  assert.ok(res.includes('1: hello world'), `应含行号与内容: ${res}`);
});

await test('grep 单文件无匹配 → 未找到', async () => {
  const res = await execute('grep', { pattern: 'nonexistent', path: 'work/a.txt' }, ctx);
  assert.ok(res.includes('未找到 "nonexistent"'), `结果: ${res}`);
});

// ---- 2. 目录递归搜索 ----
await test('grep 目录递归搜索跨子目录', async () => {
  const res = await execute('grep', { pattern: 'hello', path: 'work' }, ctx);
  assert.ok(res.includes('找到 2 处匹配'), `结果: ${res}`);
  assert.ok(res.includes('work/a.txt'), `应含 a.txt 分组: ${res}`);
  assert.ok(res.includes('work/sub/b.txt'), `应含 b.txt 分组: ${res}`);
  assert.ok(res.includes('1: hello world') && res.includes('1: hello node'), `结果: ${res}`);
});

// ---- 3. 跳过二进制和超大文件 ----
await test('grep 跳过二进制文件与超大文件', async () => {
  const res = await execute('grep', { pattern: 'x', path: 'work' }, ctx);
  assert.ok(!res.includes('c.bin'), '应跳过二进制文件');
  assert.ok(!res.includes('big.txt'), '应跳过超大文件');
});

// ---- 4. maxResults 限制 ----
await test('grep maxResults 限制返回行数', async () => {
  const res = await execute('grep', { pattern: 'o', path: 'work', maxResults: 1 }, ctx);
  const lines = res.split('\n').filter((l) => l.includes(':'));
  assert.equal(lines.length, 1, `应只返回 1 行: ${res}`);
});

// ---- 5. workspace 外路径拒绝 ----
await test('grep 拒绝 workspace 外路径', async () => {
  await assert.rejects(
    () => execute('grep', { pattern: 'secret', path: OUTSIDE }, ctx),
    /路径被拒绝/,
  );
});

// ---- 6. 隐藏别名 searchText 仍可执行 ----
await test('searchText 别名仍可执行（兼容旧调用方）', async () => {
  const res = await execute('searchText', { path: 'work/a.txt', pattern: 'hello' }, ctx);
  assert.ok(res.includes('找到 1 处'), `结果: ${res}`);
});

// ---- 7. Schema 包含 grep 但不含 searchText ----
await test('grep 在 Schema 中注册，searchText 不在', () => {
  const names = getSchemas().map((s) => s.function.name);
  assert.ok(names.includes('grep'));
  assert.ok(!names.includes('searchText'));
});

// ---- 8. 超大文件搜索 → invalid result ----
await test('grep 直接搜索超大文件 → tool_result_invalid', async () => {
  const res = await execute('grep', { pattern: 'x', path: 'work/big.txt' }, ctx);
  assert.ok(res.includes('文件过大'), `结果: ${res}`);
  assert.equal(validateToolResult('grep', res).valid, false);
});

// ---- 7. v1.9 正则 + 默认忽略 ----
fs.mkdirSync(path.join(root, 'work', 'node_modules', 'dep'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'work', 'node_modules', 'dep', 'index.js'),
  'const helloFromDependency = 1;\n',
  'utf8',
);

await test('grep 支持正则（hel+o 匹配 hello）', async () => {
  const res = await execute('grep', { pattern: 'hel+o', path: 'work/a.txt' }, ctx);
  assert.ok(res.includes('找到 1 处匹配'), `结果: ${res}`);
});

await test('grep 支持正则分组与交替', async () => {
  // a.txt: hello(1) ; b.txt: hello(1) + baz(1) = 3
  const res = await execute('grep', { pattern: '(hello|baz)', path: 'work' }, ctx);
  assert.ok(res.includes('找到 3 处匹配'), `结果: ${res}`);
});

await test('grep 非法正则 → 明确报错（不静默无结果）', async () => {
  await assert.rejects(
    () => execute('grep', { pattern: '([unclosed', path: 'work' }, ctx),
    /不是合法的正则表达式/,
  );
});

await test('grep 默认忽略 node_modules', async () => {
  const res = await execute('grep', { pattern: 'helloFromDependency', path: 'work' }, ctx);
  assert.ok(res.includes('未找到'), `默认应忽略依赖目录: ${res}`);
});

await test('grep includeIgnored=true 才搜索 node_modules', async () => {
  const res = await execute(
    'grep',
    { pattern: 'helloFromDependency', path: 'work', includeIgnored: true },
    ctx,
  );
  assert.ok(res.includes('找到 1 处匹配'), `结果: ${res}`);
  assert.ok(res.includes('node_modules/dep/index.js'), `应含依赖文件: ${res}`);
});

await test('grep 结果按文件分组（文件名只出现一次）', async () => {
  const res = await execute('grep', { pattern: 'o', path: 'work/a.txt' }, ctx);
  const occurrences = res.split('\n').filter((line) => line.trim() === 'work/a.txt').length;
  assert.equal(occurrences, 1, `文件名应只出现一次: ${res}`);
});

// ---- 汇总 ----
console.log(`\ngrep 工具测试汇总: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exitCode = 1;
else console.log('验收：grep 递归搜索、边界限制、兼容别名成立 ✓');
