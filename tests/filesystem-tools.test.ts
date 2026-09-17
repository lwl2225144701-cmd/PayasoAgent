// 模块: 只读 Sandbox 文件工具单元测试（listDir / readFile）— 无 LLM，秒级完成
// 用法: npx tsx tests/filesystem-tools.test.ts   （或 npm run test:tools）
// 覆盖：正常 / 不存在 / 目录文件互指 / 穿越 / 绝对路径 / symlink 逃逸 / 超大 / 二进制 / Schema 无泄露

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

import '../src/tools/filesystem.js'; // 副作用：注册 listDir / readFile
import { cleanupWorkspace, createWorkspace } from '../src/sandbox/sandbox-manager.js';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-fs-test-'));
process.env.SANDBOX_ROOT = TEST_ROOT;

const RUN = 'fs-test';
const root = createWorkspace(RUN);
const ctx: ToolContext = { runId: RUN, workspaceRoot: root };

// ---- 预置工作区内容 ----
fs.writeFileSync(path.join(root, 'input', 'demo.txt'), 'hello sandbox');
fs.writeFileSync(path.join(root, 'work', 'a.txt'), 'aaa');
fs.mkdirSync(path.join(root, 'work', 'sub'), { recursive: true });
fs.writeFileSync(path.join(root, 'output', 'big.txt'), Buffer.alloc(2 * 1024 * 1024, 0x61)); // 2MB
fs.writeFileSync(path.join(root, 'work', 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
const OUTSIDE = path.join(TEST_ROOT, '..', 'fs-outside.txt');
fs.writeFileSync(OUTSIDE, 'secret outside');
fs.symlinkSync(OUTSIDE, path.join(root, 'work', 'evil-link'));

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
  const res = await execute('listDir', { path: 'work' }, ctx);
  assert.ok(res.includes('a.txt'), '缺少 a.txt');
  assert.ok(res.includes('sub'), '缺少 sub');
  assert.ok(res.includes('[file] a.txt'), '类型标注缺失');
  assert.ok(res.includes('[directory] sub'), '目录类型标注缺失');
  assert.ok(!res.includes(TEST_ROOT), '泄露了宿主机绝对路径');
});

test("listDir('input') 列出 demo.txt", async () => {
  const res = await execute('listDir', { path: 'input' }, ctx);
  assert.ok(res.includes('demo.txt'));
});

test("readFile('input/demo.txt') 返回带行号前缀的 UTF-8 内容", async () => {
  const res = await execute('readFile', { path: 'input/demo.txt' }, ctx);
  assert.equal(res, '1→hello sandbox');
});

// ---- 2. 不存在 ----
test('listDir 目录不存在 → tool_error', async () => {
  await assert.rejects(() => execute('listDir', { path: 'nope' }, ctx));
});

test('readFile 文件不存在 → tool_error', async () => {
  await assert.rejects(() => execute('readFile', { path: 'nope.txt' }, ctx));
});

// ---- 3. 目录/文件互指 ----
test('readFile 读取目录 → tool_error', async () => {
  await assert.rejects(() => execute('readFile', { path: 'work' }, ctx));
});

test('listDir 指向文件 → tool_error', async () => {
  await assert.rejects(() => execute('listDir', { path: 'input/demo.txt' }, ctx));
});

// ---- 4. 路径穿越 / 绝对路径（BLOCKED）----
test("readFile '../package.json' → BLOCKED", async () => {
  await assert.rejects(() => execute('readFile', { path: '../package.json' }, ctx));
});

test("readFile '/etc/passwd' → BLOCKED", async () => {
  await assert.rejects(() => execute('readFile', { path: '/etc/passwd' }, ctx));
});

test('BLOCKED 错误消息不泄露宿主机绝对路径', async () => {
  try {
    await execute('readFile', { path: '../package.json' }, ctx);
    assert.fail('应当被拒绝');
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(!msg.includes(TEST_ROOT), `错误消息泄露路径: ${msg}`);
    assert.ok(msg.includes('../package.json'), '应回显相对路径');
  }
});

// ---- 5. symlink 逃逸（BLOCKED）----
test('readFile symlink 指向 workspace 外 → BLOCKED', async () => {
  await assert.rejects(() => execute('readFile', { path: 'work/evil-link' }, ctx));
});

test('listDir symlink 指向 workspace 外 → BLOCKED', async () => {
  await assert.rejects(() => execute('listDir', { path: 'work/evil-link' }, ctx));
});

// ---- 6. 超大文本 / 二进制 / 图片 ----
test('read 超长单行明确截断，不再返回字节 offset 续读', async () => {
  const res = await execute('read', { path: 'output/big.txt' }, ctx);
  assert.ok(res.includes('[READ TRUNCATED]'));
  assert.ok(res.includes('offset 始终表示行号'));
  assert.ok(!/offset=\d+/.test(res));
  assert.equal(validateToolResult('read', res).valid, true);
  await assert.rejects(() => execute('read', { path: 'output/big.txt', offset: 2 }, ctx), /超出文件末尾/);
});

test('read 大小文件 offset/limit 一致，大文件按行连续分页', async () => {
  const text = Array.from({ length: 40000 }, (_, i) => `line-${i + 1}:` + '字'.repeat(24)).join('\n');
  assert.ok(Buffer.byteLength(text) > 2 * 1024 * 1024);
  fs.writeFileSync(path.join(root, 'work', 'large-lines.txt'), text);
  fs.writeFileSync(path.join(root, 'work', 'small-lines.txt'), text.split('\n').slice(0, 200).join('\n'));
  for (const file of ['large-lines.txt', 'small-lines.txt']) {
    const res = await execute('read', { path: `work/${file}`, offset: 100, limit: 2 }, ctx);
    assert.match(res, /100→line-100:/);
    assert.match(res, /101→line-101:/);
    assert.ok(!res.includes('→line-102:'));
    assert.ok(res.includes('offset=102'));
  }
  const page = await execute('read', { path: 'work/large-lines.txt', offset: 102, limit: 1 }, ctx);
  assert.match(page, /102→line-102:/);
  assert.ok(!page.includes('→line-103:'));
  const last = await execute('read', { path: 'work/large-lines.txt', offset: 40000, limit: 10 }, ctx);
  assert.match(last, /40000→line-40000:/);
  assert.ok(!last.includes('offset='));
  await assert.rejects(() => execute('read', { path: 'work/large-lines.txt', offset: 40001 }, ctx), /超出文件末尾/);
});

test('read 分块边界保留 UTF-8、BOM、CRLF 与尾部空行', async () => {
  // 中文首字节位于 64KiB 分块尾部；长行截断也不得产生半个字符。
  const text = '\ufeff' + 'a'.repeat(65532) + '中文\r\n第二行😀\r\n';
  fs.writeFileSync(path.join(root, 'work', 'boundary.txt'), text);
  const first = await execute('read', { path: 'work/boundary.txt', limit: 1 }, ctx);
  assert.ok(!first.includes('�'));
  assert.ok(first.includes('BOM'));
  const second = await execute('read', { path: 'work/boundary.txt', offset: 2, limit: 1 }, ctx);
  assert.match(second, /2→第二行😀\r/);
  assert.ok(second.includes('offset=3'));
  assert.equal((await execute('read', { path: 'work/boundary.txt', offset: 3, limit: 1 }, ctx)).split('\n')[0], '3→');
  fs.writeFileSync(path.join(root, 'work', 'utf8-chunks.txt'), 'a'.repeat(65531) + '\naaa中文');
  assert.equal(await execute('read', { path: 'work/utf8-chunks.txt', offset: 2, limit: 1 }, ctx), '2→aaa中文');
});

test('read 显式 limit 超上限时最多读取 500 行', async () => {
  fs.writeFileSync(path.join(root, 'work', 'capped.txt'), Array.from({ length: 600 }, (_, i) => String(i + 1)).join('\n'));
  const res = await execute('read', { path: 'work/capped.txt', limit: 1000000 }, ctx);
  assert.ok(res.includes('500→500'));
  assert.ok(!res.includes('501→501'));
  assert.ok(res.includes('offset=501'));
});

test('read 二进制文件（非图片）→ 省略提示（valid，乱码不进 Context）', async () => {
  const res = await execute('read', { path: 'work/bin.dat' }, ctx);
  assert.ok(res.includes('二进制文件省略'), `结果: ${res}`);
  assert.ok(res.includes('shell'), '应指路 shell 工具（file/wc/xxd）');
  assert.ok(!res.includes('\u0000'), 'NUL 字节不应出现在结果里');
  const v = validateToolResult('read', res);
  assert.equal(v.valid, true, '二进制省略提示应视为有效');
});

test('read 图片文件（PNG magic）→ 省略提示（valid）', async () => {
  const png = path.join(root, 'work', 'pic.png');
  fs.writeFileSync(
    png,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0x00),
    ]),
  );
  const res = await execute('read', { path: 'work/pic.png' }, ctx);
  assert.ok(res.includes('图片文件省略'), `结果: ${res}`);
  assert.ok(res.includes('PNG'), `结果: ${res}`);
  const v = validateToolResult('read', res);
  assert.equal(v.valid, true, '图片省略提示应视为有效');
});

test('read 图片文件 + vision 上下文 → 多模态结果（图片走 images，文本只留提示）', async () => {
  const visionCtx: ToolContext = { runId: RUN, workspaceRoot: root, vision: true };
  const withVision = normalizeToolResult(
    await executeRaw('read', { path: 'work/pic.png' }, visionCtx),
  );
  assert.ok(withVision.images && withVision.images.length === 1, '应返回 1 张图片引用');
  assert.equal(withVision.images?.[0].mimeType, 'image/png');
  assert.equal(withVision.images?.[0].path, 'work/pic.png', '图片路径必须是工作区相对路径');
  assert.ok(!withVision.text.includes('宿主机'), '文本不得泄露宿主路径');

  // 非视觉上下文：保持向后兼容，只给省略提示、不附图
  const plain = normalizeToolResult(await executeRaw('read', { path: 'work/pic.png' }, ctx));
  assert.ok(plain.text.includes('图片文件省略'), `结果: ${plain.text}`);
  assert.equal(plain.images, undefined);
});

test('read 文件为空 → 空文件提示（valid）', async () => {
  fs.writeFileSync(path.join(root, 'work', 'empty.txt'), '');
  const res = await execute('read', { path: 'work/empty.txt' }, ctx);
  assert.ok(res.includes('文件为空'), `结果: ${res}`);
});

// ---- 6b. 行号 / offset / limit / 截断 ----
test('read 多行文件带行号前缀', async () => {
  fs.writeFileSync(path.join(root, 'work', 'nums.txt'), 'one\ntwo\nthree\n');
  const res = await execute('read', { path: 'work/nums.txt' }, ctx);
  assert.ok(res.includes('1→one'), `缺行号: ${res}`);
  assert.ok(res.includes('2→two'), `缺行号: ${res}`);
  assert.ok(res.includes('3→three'), `缺行号: ${res}`);
});

test('read offset+limit 按行切片并给续读行号', async () => {
  fs.writeFileSync(path.join(root, 'work', 'nums2.txt'), ['a', 'b', 'c', 'd', 'e'].join('\n'));
  const res = await execute('read', { path: 'work/nums2.txt', offset: 2, limit: 2 }, ctx);
  assert.ok(res.includes('2→b'), `应从第2行: ${res}`);
  assert.ok(res.includes('3→c'), `应含第3行: ${res}`);
  assert.ok(!res.includes('4→d'), 'limit=2 不应含第4行');
  assert.ok(res.includes('offset=4'), `应提示 offset=4 续读: ${res}`);
});

test('read offset 超出行数 → 报错', async () => {
  fs.writeFileSync(path.join(root, 'work', 'small.txt'), 'x\ny\n');
  await assert.rejects(
    () => execute('read', { path: 'work/small.txt', offset: 99 }, ctx),
    /超出文件末尾/,
  );
});

test('read 行数超 500 → 截断并给 offset 续读', async () => {
  fs.writeFileSync(
    path.join(root, 'work', 'many.txt'),
    Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n'),
  );
  const res = await execute('read', { path: 'work/many.txt' }, ctx);
  assert.ok(res.includes('READ 提示'), `应有续读提示: ${res.slice(-200)}`);
  assert.ok(res.includes('500'), `应显示到约500行: ${res.slice(-200)}`);
});

// v1.8：窗口超输出预算 + 文件仍有后续行 → 两条续读提示必须同时存在，
// 否则模型会误以为已经读到文件末尾。
test('read 超预算窗口 + 后续行 → 中间续读与窗口续读提示并存', async () => {
  const long = 'x'.repeat(200);
  fs.writeFileSync(
    path.join(root, 'work', 'wide.txt'),
    Array.from({ length: 600 }, (_, i) => `${i + 1} ${long}`).join('\n'),
  );
  const res = await execute('read', { path: 'work/wide.txt' }, ctx);
  assert.ok(res.includes('[READ TRUNCATED]'), `应有截断标记: ${res.slice(0, 200)}`);
  assert.ok(res.includes('省略中间'), `应说明省略中间: ${res.slice(-400)}`);
  assert.ok(res.includes('续读该段'), `应给出中间续读区间: ${res.slice(-400)}`);
  assert.ok(res.includes('续读剩余'), `应给出窗口后的续读提示: ${res.slice(-300)}`);
  assert.ok(
    Buffer.byteLength(res, 'utf8') <= 16 * 1024,
    `read 输出必须落在共享预算内，实际 ${Buffer.byteLength(res, 'utf8')}`,
  );
});

// ---- 7. Schema 无泄露 ----
test('LLM Schema 无 runId、无宿主机绝对路径', () => {
  const json = JSON.stringify(getSchemas());
  assert.ok(!json.includes('runId'), 'Schema 中出现 "runId"');
  assert.ok(!json.includes(TEST_ROOT), 'Schema 中出现宿主机绝对路径');
  assert.ok(!json.includes('/Users'), 'Schema 中出现 /Users 绝对路径');
});

test('ls / read / write 的 Tool Schema 已注册', () => {
  const names = getSchemas().map((s) => s.function.name);
  assert.ok(names.includes('ls'));
  assert.ok(names.includes('read'));
  assert.ok(names.includes('write'));
});

test('向后兼容别名不在 Schema 中但仍可通过 execute 调用', async () => {
  const names = getSchemas().map((s) => s.function.name);
  assert.ok(!names.includes('listDir'), 'listDir 应从 Schema 中移除');
  assert.ok(!names.includes('readFile'), 'readFile 应从 Schema 中移除');
  assert.ok(!names.includes('writeFile'), 'writeFile 应从 Schema 中移除');
  assert.equal(await execute('readFile', { path: 'input/demo.txt' }, ctx), '1→hello sandbox');
  assert.match(await execute('listDir', { path: 'work' }, ctx), /a\.txt/);
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
  console.log(`\n${'='.repeat(56)}`);
  console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) {
    failures.forEach((f) => {
      console.log(`  FAIL ${f}`);
    });
    process.exit(1);
  }
  console.log('验收：正常读取 PASS，所有逃逸/超大/二进制处理正确 ✓');
}

main();
