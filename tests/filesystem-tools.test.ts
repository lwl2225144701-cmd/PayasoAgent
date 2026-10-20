// 模块: 只读 Sandbox 文件工具单元测试（listDir / readFile）— 无 LLM，秒级完成
// 用法: npx tsx tests/filesystem-tools.test.ts   （或 npm run test:tools）
// 覆盖：正常 / 不存在 / 目录文件互指 / 穿越 / 绝对路径 / symlink 逃逸 / 超大 / 二进制 / Schema 无泄露
// v2.5（批次A · 计划§9）：edit 大文件上限与错误码（E01/E02）、沙箱拒绝反馈的
//       TMPDIR 指引（E03，macOS 条件用例）。

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
import { probeSandboxAvailability } from '../src/sandbox/macos-sandbox.js';
import { cleanupWorkspace, createWorkspace } from '../src/sandbox/sandbox-manager.js';
// 副作用：注册 shell（E03 沙箱拒绝反馈用例）；并取拒绝反馈文案常量做行为断言。
import { SHELL_SANDBOX_DENIED_FEEDBACK } from '../src/tools/runtime-tools.js';

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
  await assert.rejects(
    () => execute('read', { path: 'output/big.txt', offset: 2 }, ctx),
    /超出文件末尾/,
  );
});

test('read 大小文件 offset/limit 一致，大文件按行连续分页', async () => {
  const text = Array.from({ length: 40000 }, (_, i) => `line-${i + 1}:` + '字'.repeat(24)).join(
    '\n',
  );
  assert.ok(Buffer.byteLength(text) > 2 * 1024 * 1024);
  fs.writeFileSync(path.join(root, 'work', 'large-lines.txt'), text);
  fs.writeFileSync(
    path.join(root, 'work', 'small-lines.txt'),
    text.split('\n').slice(0, 200).join('\n'),
  );
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
  const last = await execute(
    'read',
    { path: 'work/large-lines.txt', offset: 40000, limit: 10 },
    ctx,
  );
  assert.match(last, /40000→line-40000:/);
  assert.ok(!last.includes('offset='));
  await assert.rejects(
    () => execute('read', { path: 'work/large-lines.txt', offset: 40001 }, ctx),
    /超出文件末尾/,
  );
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
  assert.equal(
    (await execute('read', { path: 'work/boundary.txt', offset: 3, limit: 1 }, ctx)).split('\n')[0],
    '3→',
  );
  fs.writeFileSync(path.join(root, 'work', 'utf8-chunks.txt'), 'a'.repeat(65531) + '\naaa中文');
  assert.equal(
    await execute('read', { path: 'work/utf8-chunks.txt', offset: 2, limit: 1 }, ctx),
    '2→aaa中文',
  );
});

test('read 显式 limit 超上限时最多读取 500 行', async () => {
  fs.writeFileSync(
    path.join(root, 'work', 'capped.txt'),
    Array.from({ length: 600 }, (_, i) => String(i + 1)).join('\n'),
  );
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

test('read 连续分页：唯一游标推进，完整遍历无跳行且不超预算', async () => {
  const lines = Array.from({ length: 600 }, (_, i) => `${i + 1} ${'x'.repeat(200)}`);
  fs.writeFileSync(path.join(root, 'work', 'wide.txt'), lines.join('\n'));
  let offset = 1;
  const seen: number[] = [];
  while (offset <= lines.length) {
    const res = await execute('read', { path: 'work/wide.txt', offset }, ctx);
    assert.ok(Buffer.byteLength(res, 'utf8') <= 16 * 1024);
    const returned = [...res.matchAll(/^\s*(\d+)→/gm)].map((m) => Number(m[1]));
    assert.ok(returned.length);
    assert.deepEqual(
      returned,
      Array.from({ length: returned.length }, (_, i) => offset + i),
    );
    seen.push(...returned);
    const cursors = [...res.matchAll(/offset=(\d+)/g)];
    offset += returned.length;
    if (offset <= lines.length) {
      assert.equal(cursors.length, 1, '只允许一个下一页位置');
      assert.equal(Number(cursors[0][1]), offset);
    } else assert.equal(cursors.length, 0);
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 600 }, (_, i) => i + 1),
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

// ---- 8. E01：>64KiB 且 ≤1MiB 大文件定点编辑（计划 §9.1 / 用例 E01）----
const WORK_DIR = path.join(root, 'work');
function tmpResidue(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.includes('.payaso-') && f.endsWith('.tmp'));
}

test('E01 >64KiB 文件定点 edit 成功：只改目标行，其余字节一致，无 .tmp 残留（原子写）', async () => {
  const lines = Array.from({ length: 1500 }, (_, i) => `line-${i + 1} ${'x'.repeat(64)}`);
  const original = `${lines.join('\n')}\n`;
  assert.ok(Buffer.byteLength(original) > 64 * 1024, '前提：文件必须超过旧的 64KiB 编辑限制');
  assert.ok(Buffer.byteLength(original) <= 1024 * 1024, '前提：文件在 1MiB 编辑上限内');
  // 目标行位于第一页读取预算之外：定点编辑无需整篇生成。
  assert.ok(Buffer.byteLength(lines.slice(0, 1199).join('\n')) > 64 * 1024);
  fs.writeFileSync(path.join(WORK_DIR, 'e01.css'), original);
  const res = await execute(
    'edit',
    {
      path: 'work/e01.css',
      edits: [{ oldText: `line-1200 ${'x'.repeat(64)}`, newText: 'line-1200 /* EDITED */' }],
    },
    ctx,
  );
  assert.ok(res.includes('编辑成功'), res);
  const after = fs.readFileSync(path.join(WORK_DIR, 'e01.css'), 'utf8').split('\n');
  assert.equal(after.length, lines.length + 1, '行数只应保留尾部空行结构');
  assert.equal(after[1199], 'line-1200 /* EDITED */');
  for (let i = 0; i < lines.length; i++) {
    if (i !== 1199) assert.equal(after[i], lines[i], `第 ${i + 1} 行不应被改动`);
  }
  assert.deepEqual(tmpResidue(WORK_DIR), [], '原子写不得留下 .tmp 残留');
});

test('E01 BOM+CRLF 100KiB 文件定点 edit：BOM/CRLF 与区域外内容完整保留', async () => {
  const lines = Array.from({ length: 1400 }, (_, i) => `row${i + 1} ${'é中'.repeat(30)}`);
  const text = `\uFEFF${lines.join('\r\n')}\r\n`;
  const byteLen = Buffer.byteLength(text);
  assert.ok(byteLen > 64 * 1024 && byteLen <= 1024 * 1024, `前提：64KiB<size≤1MiB（${byteLen}）`);
  const p = path.join(WORK_DIR, 'e01-bom.txt');
  fs.writeFileSync(p, text);
  // 先走一次分页 read（read 分页上限仍是 64KiB），并记录读取快照
  await execute('read', { path: 'work/e01-bom.txt' }, ctx);
  const res = await execute(
    'edit',
    { path: 'work/e01-bom.txt', edits: [{ oldText: lines[700], newText: 'ROW701-EDITED' }] },
    ctx,
  );
  assert.ok(res.includes('编辑成功'), res);
  const buf = fs.readFileSync(p);
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM 字节应保留');
  const body = buf.toString('utf8').slice(1);
  assert.ok(!body.replace(/\r\n/g, '\n').includes('\r'), '换行风格应保持 CRLF，不混入孤立 CR');
  const rows = body.split('\r\n');
  assert.equal(rows.length, lines.length + 1, '行数结构不变');
  assert.equal(rows[700], 'ROW701-EDITED');
  for (let i = 0; i < lines.length; i++) {
    if (i !== 700) assert.equal(rows[i], lines[i], `第 ${i + 1} 行不应被改动`);
  }
  assert.deepEqual(tmpResidue(WORK_DIR), [], '原子写不得留下 .tmp 残留');
});

// ---- 9. E02：匹配失败/重叠/超限/外部改变/目标文件错误（计划 §9.2 / 用例 E02）----
test('E02 oldText 多处匹配 → EDIT_AMBIGUOUS：目标路径+次数+有界位置列表，磁盘未变', async () => {
  const p = path.join(WORK_DIR, 'e02-dup.txt');
  const original = `${Array.from({ length: 20 }, () => 'dup-target\nfiller').join('\n')}\n`;
  fs.writeFileSync(p, original);
  await assert.rejects(
    () =>
      execute(
        'edit',
        { path: 'work/e02-dup.txt', edits: [{ oldText: 'dup-target', newText: 'X' }] },
        ctx,
      ),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.ok(m.includes('[EDIT_AMBIGUOUS]'), m);
      assert.ok(m.includes('work/e02-dup.txt'), '错误应指向实际目标路径');
      assert.ok(m.includes('出现 20 次'), m);
      assert.ok(m.includes('共 20 处，仅列前 8 处'), '位置列表必须有界（≤8）');
      return true;
    },
  );
  assert.equal(fs.readFileSync(p, 'utf8'), original, '拒绝后磁盘必须原样');
});

test('E02 两处 edit 区间重叠 → EDIT_OVERLAP：指认具体序号与片段，磁盘未变', async () => {
  const p = path.join(WORK_DIR, 'e02-ov.txt');
  fs.writeFileSync(p, 'abcdef\nghijkl\n');
  await assert.rejects(
    () =>
      execute(
        'edit',
        {
          path: 'work/e02-ov.txt',
          edits: [
            { oldText: 'abcd', newText: 'ZZZZ' },
            { oldText: 'cdef', newText: 'YYYY' },
          ],
        },
        ctx,
      ),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.ok(m.includes('[EDIT_OVERLAP]'), m);
      assert.ok(m.includes('work/e02-ov.txt'), m);
      assert.ok(m.includes('重叠'), m);
      assert.ok(m.includes('第 1 处') && m.includes('第 2 处'), '应指明交叠的两处序号');
      return true;
    },
  );
  assert.equal(fs.readFileSync(p, 'utf8'), 'abcdef\nghijkl\n');
});

test('E02 编辑前文件 >1MiB → EDIT_TOO_LARGE：含路径/实际大小/限制/恢复建议，不建议整篇重写', async () => {
  const p = path.join(root, 'output', 'e02-big.txt');
  const big = Buffer.concat([Buffer.from('line-0\n'), Buffer.alloc(2 * 1024 * 1024 - 7, 0x61)]);
  assert.equal(big.length, 2 * 1024 * 1024);
  fs.writeFileSync(p, big);
  const res = await execute(
    'edit',
    { path: 'output/e02-big.txt', edits: [{ oldText: 'line-0', newText: 'line-X' }] },
    ctx,
  );
  assert.ok(res.startsWith('[sandbox-tool-invalid]'), `原生命周期保持：${res.slice(0, 60)}`);
  assert.ok(res.includes('[EDIT_TOO_LARGE]'), res.slice(0, 120));
  assert.ok(res.includes('文件过大'), res.slice(0, 120));
  assert.ok(res.includes('output/e02-big.txt'), '错误需含路径');
  assert.ok(res.includes('实际 2097152 字节'), '错误需含实际大小');
  assert.ok(res.includes('编辑上限 1048576 字节'), '错误需含限制值');
  assert.ok(res.includes('恢复建议'), '错误需含恢复建议');
  assert.ok(res.includes('请勿整篇重写'), '不得建议整篇重写');
  assert.equal(validateToolResult('edit', res).valid, false);
  assert.equal(fs.readFileSync(p).length, 2 * 1024 * 1024, '拒绝后磁盘必须原样');
});

test('E02 编辑后内容 >1MiB → EDIT_TOO_LARGE：不写入、无残留', async () => {
  const lines = Array.from(
    { length: 16384 },
    (_, i) => `L${String(i).padStart(5, '0')} ${'p'.repeat(55)}`,
  );
  const original = lines.join('\n');
  const originalBytes = Buffer.byteLength(original);
  assert.ok(
    originalBytes <= 1024 * 1024 && originalBytes > 1024 * 1024 - 32768,
    `前提：接近上限（${originalBytes}）`,
  );
  const p = path.join(WORK_DIR, 'e02-post.txt');
  fs.writeFileSync(p, original);
  const growth = 30001; // '\n' + 30000 个 q
  const res = await execute(
    'edit',
    {
      path: 'work/e02-post.txt',
      edits: [{ oldText: lines[16000], newText: `${lines[16000]}\n${'q'.repeat(30000)}` }],
    },
    ctx,
  );
  assert.ok(res.startsWith('[sandbox-tool-invalid]'), res.slice(0, 60));
  assert.ok(res.includes('[EDIT_TOO_LARGE]'), res.slice(0, 120));
  assert.ok(res.includes(`实际 ${originalBytes + growth} 字节`), res.slice(0, 160));
  assert.ok(res.includes('编辑上限 1048576 字节'), res.slice(0, 160));
  assert.ok(res.includes('恢复建议'), res.slice(0, 160));
  assert.equal(validateToolResult('edit', res).valid, false);
  assert.equal(fs.readFileSync(p, 'utf8'), original, '未写入');
  assert.deepEqual(tmpResidue(WORK_DIR), [], '拒绝路径不得留下 .tmp');
});

test('E02 外部改变（read 之后被改写）→ EDIT_STALE：拒绝覆盖并要求重新读取', async () => {
  const p = path.join(WORK_DIR, 'e02-stale.txt');
  fs.writeFileSync(p, 'alpha\nbeta\ngamma\n');
  await execute('read', { path: 'work/e02-stale.txt' }, ctx);
  // 模拟外部修改（shell 命令 / 其他进程）
  fs.writeFileSync(p, 'alpha\nBETA-EXTERN\ngamma\nextra\n');
  await assert.rejects(
    () =>
      execute(
        'edit',
        { path: 'work/e02-stale.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] },
        ctx,
      ),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.ok(m.includes('[EDIT_STALE]'), m);
      assert.ok(m.includes('work/e02-stale.txt'), '错误应指向实际目标路径');
      assert.ok(/重新\s*read|重新读取/.test(m), '应要求重新读取');
      assert.ok(m.includes('不提供跨进程事务锁'), '不得宣称跨进程事务锁');
      return true;
    },
  );
  assert.equal(
    fs.readFileSync(p, 'utf8'),
    'alpha\nBETA-EXTERN\ngamma\nextra\n',
    '拒绝后磁盘保持外部新内容',
  );
  // 重新 read 之后可以正常编辑
  await execute('read', { path: 'work/e02-stale.txt' }, ctx);
  const res2 = await execute(
    'edit',
    { path: 'work/e02-stale.txt', edits: [{ oldText: 'BETA-EXTERN', newText: 'BETA' }] },
    ctx,
  );
  assert.ok(res2.includes('编辑成功'), res2);
});

test('E02 自身连续 edit（read 一次后两连改）不误报 STALE；write 也刷新快照', async () => {
  const p = path.join(WORK_DIR, 'e02-chain.txt');
  fs.writeFileSync(p, 'one\ntwo\nthree\n');
  await execute('read', { path: 'work/e02-chain.txt' }, ctx);
  await execute(
    'edit',
    { path: 'work/e02-chain.txt', edits: [{ oldText: 'one', newText: 'ONE' }] },
    ctx,
  );
  const r = await execute(
    'edit',
    { path: 'work/e02-chain.txt', edits: [{ oldText: 'two', newText: 'TWO' }] },
    ctx,
  );
  assert.ok(r.includes('编辑成功'), r);
  const w = await execute('write', { path: 'work/e02-chain.txt', content: 'fresh\nlines\n' }, ctx);
  assert.ok(w.includes('写入成功'), w);
  const r2 = await execute(
    'edit',
    { path: 'work/e02-chain.txt', edits: [{ oldText: 'fresh', newText: 'FRESH' }] },
    ctx,
  );
  assert.ok(r2.includes('编辑成功'), `write 后无需重读：${r2}`);
});

test('E02 目标文件错误（片段属于别的文件）→ EDIT_NOT_FOUND：明确本次目标与依据，不改其他文件', async () => {
  const css = path.join(WORK_DIR, 'e02-style.css');
  const js = path.join(WORK_DIR, 'e02-app.js');
  fs.writeFileSync(css, '.btn { color: red; }\n');
  fs.writeFileSync(js, 'console.log("hello");\n');
  await assert.rejects(
    () =>
      execute(
        'edit',
        {
          path: 'work/e02-app.js',
          edits: [{ oldText: '.btn { color: red; }', newText: '.btn { color: blue; }' }],
        },
        ctx,
      ),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.ok(m.includes('[EDIT_NOT_FOUND]'), m);
      assert.ok(m.includes('work/e02-app.js'), '应指向本次实际目标');
      assert.ok(m.includes('oldText 在文件中未精确匹配'), m);
      assert.ok(m.includes('不会自动改动其他文件'), '不得自动把改动挪到其他文件');
      return true;
    },
  );
  assert.equal(fs.readFileSync(css, 'utf8'), '.btn { color: red; }\n', 'CSS 文件不得被顺手动');
  assert.equal(fs.readFileSync(js, 'utf8'), 'console.log("hello");\n');
});

test('E02 缩进/边界抄错 → EDIT_NOT_FOUND 附最接近行范围（有界 details）', async () => {
  const p = path.join(WORK_DIR, 'e02-nf.txt');
  fs.writeFileSync(p, 'head\n    indented line here\ntail\n');
  await assert.rejects(
    () =>
      execute(
        'edit',
        {
          path: 'work/e02-nf.txt',
          edits: [{ oldText: 'indented line here\nTHE-UNKNOWN-TAIL', newText: 'x' }],
        },
        ctx,
      ),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.ok(m.includes('[EDIT_NOT_FOUND]'), m);
      assert.ok(m.includes('work/e02-nf.txt'), m);
      assert.ok(m.includes('第 2-3 行附近'), `应给最接近行范围：${m}`);
      return true;
    },
  );
  assert.equal(fs.readFileSync(p, 'utf8'), 'head\n    indented line here\ntail\n');
});

test('E02 多 edit 第 2 处失败 → 第 1 处也不落盘（无部分修改）', async () => {
  const p = path.join(WORK_DIR, 'e02-atomic.txt');
  fs.writeFileSync(p, 'first\nsecond\n');
  await assert.rejects(
    () =>
      execute(
        'edit',
        {
          path: 'work/e02-atomic.txt',
          edits: [
            { oldText: 'first', newText: 'FIRST' },
            { oldText: 'nope-missing', newText: 'x' },
          ],
        },
        ctx,
      ),
    /\[EDIT_NOT_FOUND\][\s\S]*第 2\/2 处 edit/,
  );
  assert.equal(fs.readFileSync(p, 'utf8'), 'first\nsecond\n', '任一失败不得产生部分修改');
  assert.deepEqual(tmpResidue(WORK_DIR), []);
});

// ---- 10. E03：TMPDIR 同次使用 / 跨调用误用 / 越界写入（计划 §9.3 / 用例 E03）----
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

test('E03 shell 沙箱：同次调用 TMPDIR 可用、跨调用文件不复存在、越界写入拒绝反馈含 TMPDIR 指引', async () => {
  if (process.platform !== 'darwin') {
    console.log('    [E03] 非 macOS 平台：跳过 OS 沙箱行为用例');
    return;
  }
  const shellCtx: ToolContext = {
    runId: RUN,
    workspaceRoot: root,
    permissionMode: 'workspace-write',
  };
  const run = (command: string) => execute('shell', { command, timeoutMs: 30_000 }, shellCtx);
  // 拒绝反馈文案契约（两种环境都断言）：TMPDIR 指引 + 跨调用/工作区指引 + 无宿主私有路径。
  const denialText = SHELL_SANDBOX_DENIED_FEEDBACK;
  assert.ok(denialText.startsWith('Shell operation denied by the workspace sandbox'), denialText);
  assert.ok(denialText.includes('TMPDIR'), '拒绝反馈应含 TMPDIR 指引');
  assert.ok(denialText.includes('跨调用'), '应说明临时文件跨调用生命周期');
  assert.ok(denialText.includes('工作区'), '应指引按权限落工作区允许目录');
  assert.ok(!denialText.includes('/tmp'), '不给任意 /tmp 加白名单');
  assert.ok(
    !denialText.includes(TEST_ROOT) && !denialText.includes(os.homedir()),
    '拒绝反馈不得泄露宿主私有路径',
  );
  // 能力门控：沙箱原语不可用时 shell 必须 fail-closed（与 os-sandbox/write-scope 同策略）。
  if (!(await probeSandboxAvailability())) {
    let refused = false;
    try {
      await run('printf ok');
    } catch (err) {
      refused = err instanceof Error && /unavailable|cannot be applied/i.test(err.message);
    }
    assert.ok(refused, '沙箱不可用时应 fail-closed 拒绝执行');
    console.log(
      '    [E03] sandbox-exec 无法应用：验证拒绝反馈契约 + fail-closed 拒绝，跳过包含矩阵',
    );
    return;
  }

  // ① 同一次调用使用注入的 TMPDIR：受管 scratch 可写
  const same = await run('printf temp-a > "$TMPDIR/e03.txt" && cat "$TMPDIR/e03.txt"');
  assert.ok(same.includes('[shell-exit-0]'), `同次调用 TMPDIR 应可写：${same}`);
  assert.ok(same.includes('temp-a'), same);

  // ② 跨调用误用：scratch 随上次调用删除，文件不复存在（退出码非零）
  const cross = await run('cat "$TMPDIR/e03.txt"');
  assert.match(cross, /\[shell-exit-[1-9]\]/, '跨调用 TMPDIR 文件不应存在');
  assert.ok(!cross.includes('temp-a'), '不得残留上次调用的临时内容');

  // ③ 越界写入：OS 沙箱拒绝；反馈含 TMPDIR 指引；不泄露宿主私有路径；磁盘不变
  const escapePath = path.join(TEST_ROOT, '..', 'fs-e03-escape.txt');
  fs.writeFileSync(escapePath, 'keep');
  try {
    await assert.rejects(
      () => run(`printf hacked > ${shQuote(escapePath)}`),
      (err: unknown) => {
        const m = (err as Error).message;
        assert.equal(m, SHELL_SANDBOX_DENIED_FEEDBACK, '真实拒绝应使用该反馈文案');
        assert.ok(m.includes('TMPDIR'), '拒绝反馈应含 TMPDIR 指引');
        assert.ok(m.includes('跨调用'), '应说明临时文件的跨调用生命周期');
        assert.ok(m.includes('工作区'), '应指引按权限落工作区允许目录');
        assert.ok(
          !m.includes(TEST_ROOT) && !m.includes(os.homedir()) && !/\/var\/folders|\/tmp\//.test(m),
          `拒绝反馈不得泄露宿主私有路径: ${m}`,
        );
        return true;
      },
    );
    assert.equal(fs.readFileSync(escapePath, 'utf8'), 'keep', '权限边界保持：越界写入未落盘');
  } finally {
    fs.rmSync(escapePath, { force: true });
  }
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
