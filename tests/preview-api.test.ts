// 模块: Preview API 契约测试 — 真实 HTTP server 覆盖 /preview* 只读端点与错误码全集。
// 用法: npx tsx tests/preview-api.test.ts（或随 npm run test:all 运行；无 LLM/网络）
// 覆盖: 目录树（懒加载/忽略规则/dotfile/截断）、文件四类分发（text/image/pdf/office）、
//   大小上限（text/image）、7 个错误码逐一触发、PreviewError.message===code 不变量、
//   前后端错误码集合一致性、M1 只读（POST 404）、Origin 校验。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from '../src/attachment-policy.js';
import { PREVIEW_ERROR_CODES, PreviewError } from '../src/host/preview/types.js';
import { createHostServer, RunManager } from '../src/host/server.js';
import { clearWorkspace, setWorkspace } from '../src/host/workspace.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-preview-test-'));
process.env.SANDBOX_ROOT = path.join(base, 'runtime-sandbox');
process.env.PAYASO_DB_PATH = path.join(base, 'payaso.db');

// ---- 工作区夹具：覆盖五类文档 + 图片 + 代码 + 边界形态 ----
const wsRoot = path.join(base, 'ws');
const outsideDir = path.join(base, 'outside');
fs.mkdirSync(path.join(wsRoot, 'sub'), { recursive: true });
fs.mkdirSync(path.join(wsRoot, 'node_modules', 'pkg'), { recursive: true });
fs.mkdirSync(path.join(wsRoot, 'many'), { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });

const MD_CONTENT = '# 标题\n\n正文 **加粗**\n';
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
]);
fs.writeFileSync(path.join(wsRoot, 'a.md'), MD_CONTENT, 'utf8');
fs.writeFileSync(path.join(wsRoot, 'note.txt'), 'hello preview\n', 'utf8');
fs.writeFileSync(path.join(wsRoot, 'Makefile'), 'all:\n\techo hi\n', 'utf8'); // 无扩展名 → 文本
fs.writeFileSync(path.join(wsRoot, 'img.png'), PNG_BYTES);
fs.writeFileSync(path.join(wsRoot, 'data.pdf'), Buffer.from('%PDF-1.4 fake'));
fs.writeFileSync(path.join(wsRoot, 'doc.docx'), Buffer.from('PK\x03\x04 fake docx'));
fs.writeFileSync(path.join(wsRoot, 'sheet.xlsx'), Buffer.from('PK\x03\x04 fake xlsx'));
fs.writeFileSync(path.join(wsRoot, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])); // 已知二进制（zip 魔数）
fs.writeFileSync(path.join(wsRoot, 'big.txt'), 'x'.repeat(MAX_TEXT_BYTES + 1), 'utf8');
fs.writeFileSync(
  path.join(wsRoot, 'huge.png'),
  Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_IMAGE_BYTES + 1)]),
);
fs.writeFileSync(path.join(wsRoot, '.hidden.txt'), 'dotfile\n', 'utf8');
fs.writeFileSync(path.join(wsRoot, 'sub', 'nested.txt'), 'nested\n', 'utf8');
fs.writeFileSync(path.join(wsRoot, 'node_modules', 'pkg', 'junk.txt'), 'junk\n', 'utf8');
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'OUTSIDE-SECRET', 'utf8');
fs.symlinkSync(outsideDir, path.join(wsRoot, 'link-out')); // symlink 逃逸夹具
for (let i = 0; i < 501; i++) {
  fs.writeFileSync(path.join(wsRoot, 'many', `f${String(i).padStart(4, '0')}.txt`), 'x', 'utf8');
}

setWorkspace(wsRoot);

const manager = new RunManager();
const server = createHostServer(manager);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}`;

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

async function getPreview(
  sub: string,
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; contentType: string | null }> {
  const qs = new URLSearchParams(params).toString();
  const resp = await fetch(`${baseUrl}/preview/${sub}${qs ? `?${qs}` : ''}`, { headers });
  return {
    status: resp.status,
    body: await resp.text(),
    contentType: resp.headers.get('content-type'),
  };
}

function jsonBody(body: string): { error?: string; [k: string]: unknown } {
  return JSON.parse(body) as { error?: string; [k: string]: unknown };
}

// ---- 目录树 ----

test('tree 根层：文件/目录/dotfile/忽略目录/父路径语义', async () => {
  const { status, body } = await getPreview('tree');
  assert.equal(status, 200);
  assert.equal(
    (JSON.parse(body) as { workspace?: string }).workspace,
    'ws',
    'listing 必须带工作区显示名（面包屑根用；前端拿不到绝对路径）',
  );
  const listing = JSON.parse(body) as {
    path: string;
    parent: string | null;
    entries: { name: string; path: string; kind: string; hidden: boolean; size?: number }[];
    truncated: boolean;
  };
  assert.equal(listing.path, '');
  assert.equal(listing.parent, null);
  assert.equal(listing.truncated, false);
  const byName = new Map(listing.entries.map((e) => [e.name, e]));
  assert.equal(byName.get('a.md')?.kind, 'file');
  assert.equal(byName.get('a.md')?.size, Buffer.byteLength(MD_CONTENT, 'utf8'));
  assert.equal(byName.get('a.md')?.path, 'a.md');
  assert.equal(byName.get('sub')?.kind, 'dir');
  assert.equal(byName.get('sub')?.path, 'sub');
  assert.equal(byName.get('.hidden.txt')?.hidden, true);
  assert.equal(byName.get('Makefile')?.kind, 'file'); // 无扩展名文件可枚举
  assert.equal(byName.has('node_modules'), false); // 默认忽略
  assert.equal(byName.has('link-out'), false); // symlink 不枚举
  // 目录在前、文件在后
  const firstFileIdx = listing.entries.findIndex((e) => e.kind === 'file');
  const lastDirIdx = listing.entries.reduce((acc, e, i) => (e.kind === 'dir' ? i : acc), -1);
  assert.ok(lastDirIdx < firstFileIdx, '目录应排在文件之前');
});

test('tree includeIgnored=true：node_modules 可见', async () => {
  const { status, body } = await getPreview('tree', { includeIgnored: 'true' });
  assert.equal(status, 200);
  const listing = JSON.parse(body) as { entries: { name: string }[] };
  assert.ok(listing.entries.some((e) => e.name === 'node_modules'));
});

test('tree 子目录：parent 语义', async () => {
  const { status, body } = await getPreview('tree', { path: 'sub' });
  assert.equal(status, 200);
  const listing = JSON.parse(body) as {
    path: string;
    parent: string | null;
    entries: { name: string }[];
  };
  assert.equal(listing.path, 'sub');
  assert.equal(listing.parent, '');
  assert.deepEqual(
    listing.entries.map((e) => e.name),
    ['nested.txt'],
  );
});

test('tree 深层 parent：a/b/c → a/b', async () => {
  fs.mkdirSync(path.join(wsRoot, 'x', 'y'), { recursive: true });
  const { body } = await getPreview('tree', { path: 'x/y' });
  const listing = JSON.parse(body) as { parent: string | null };
  assert.equal(listing.parent, 'x');
});

test('tree 截断：501 个文件 → truncated + 500 条', async () => {
  const { status, body } = await getPreview('tree', { path: 'many' });
  assert.equal(status, 200);
  const listing = JSON.parse(body) as { entries: unknown[]; truncated: boolean };
  assert.equal(listing.truncated, true);
  assert.equal(listing.entries.length, 500);
});

test('tree 路径错误：不存在 404 / 穿越 400 / 文件当目录 400', async () => {
  const missing = await getPreview('tree', { path: 'nope' });
  assert.equal(missing.status, 404);
  assert.equal(jsonBody(missing.body).error, 'not_found');

  const traversal = await getPreview('tree', { path: '../outside' });
  assert.equal(traversal.status, 400);
  assert.equal(jsonBody(traversal.body).error, 'invalid_path');

  const fileAsDir = await getPreview('tree', { path: 'a.md' });
  assert.equal(fileAsDir.status, 400);
  assert.equal(jsonBody(fileAsDir.body).error, 'invalid_path');
});

test('tree symlink 逃逸：403 outside_workspace', async () => {
  const { status, body } = await getPreview('tree', { path: 'link-out' });
  assert.equal(status, 403);
  assert.equal(jsonBody(body).error, 'outside_workspace');
});

// ---- 文件读取：四类分发 ----

test('file 文本：text/plain + utf8 原样返回', async () => {
  const { status, body, contentType } = await getPreview('file', { path: 'a.md' });
  assert.equal(status, 200);
  assert.match(contentType ?? '', /^text\/plain; charset=utf-8$/);
  assert.equal(body, MD_CONTENT);
});

test('file 无扩展名（Makefile）按文本返回', async () => {
  const { status, body } = await getPreview('file', { path: 'Makefile' });
  assert.equal(status, 200);
  assert.match(body, /echo hi/);
});

test('file 图片：image/png 二进制原样', async () => {
  const resp = await fetch(`${baseUrl}/preview/file?path=img.png`);
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-type') ?? '', /^image\/png$/);
  const buf = Buffer.from(await resp.arrayBuffer());
  assert.ok(buf.equals(PNG_BYTES), '图片字节应原样返回');
});

test('file PDF：application/pdf', async () => {
  const { status, contentType } = await getPreview('file', { path: 'data.pdf' });
  assert.equal(status, 200);
  assert.equal(contentType, 'application/pdf');
});

test('file docx/xlsx：office MIME', async () => {
  const docx = await getPreview('file', { path: 'doc.docx' });
  assert.equal(docx.status, 200);
  assert.match(docx.contentType ?? '', /wordprocessingml/);
  const xlsx = await getPreview('file', { path: 'sheet.xlsx' });
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.contentType ?? '', /spreadsheetml/);
});

test('file 已知二进制：415 unsupported', async () => {
  const { status, body } = await getPreview('file', { path: 'archive.zip' });
  assert.equal(status, 415);
  assert.equal(jsonBody(body).error, 'unsupported');
});

test('file 大小上限：文本 2MB / 图片 8MB → 413 too_large 带 limit', async () => {
  const text = await getPreview('file', { path: 'big.txt' });
  assert.equal(text.status, 413);
  const textBody = jsonBody(text.body);
  assert.equal(textBody.error, 'too_large');
  assert.equal(textBody.limit, MAX_TEXT_BYTES);

  const image = await getPreview('file', { path: 'huge.png' });
  assert.equal(image.status, 413);
  assert.equal(jsonBody(image.body).limit, MAX_IMAGE_BYTES);
});

test('file 路径错误：不存在 404 / 空路径 400 / 目录 400 / symlink 逃逸 403', async () => {
  const missing = await getPreview('file', { path: 'missing.txt' });
  assert.equal(missing.status, 404);
  assert.equal(jsonBody(missing.body).error, 'not_found');

  const empty = await getPreview('file');
  assert.equal(empty.status, 400);
  assert.equal(jsonBody(empty.body).error, 'invalid_path');

  const dir = await getPreview('file', { path: 'sub' });
  assert.equal(dir.status, 400);
  assert.equal(jsonBody(dir.body).error, 'invalid_path');

  const symlink = await getPreview('file', { path: 'link-out/secret.txt' });
  assert.equal(symlink.status, 403);
  assert.equal(jsonBody(symlink.body).error, 'outside_workspace');
});

test('file 绝对路径输入按工作区相对语义降格（/etc/passwd → etc/passwd → 404）', async () => {
  const { status, body } = await getPreview('file', { path: '/etc/passwd' });
  assert.equal(status, 404);
  assert.equal(jsonBody(body).error, 'not_found');
});

// ---- stat ----

test('stat：文件元数据 / 目录 kind', async () => {
  const file = await getPreview('stat', { path: 'a.md' });
  assert.equal(file.status, 200);
  const fileStat = JSON.parse(file.body) as {
    name: string;
    path: string;
    kind: string;
    size: number;
    mtimeMs: number;
  };
  assert.equal(fileStat.name, 'a.md');
  assert.equal(fileStat.path, 'a.md');
  assert.equal(fileStat.kind, 'file');
  assert.equal(fileStat.size, Buffer.byteLength(MD_CONTENT, 'utf8'));
  assert.ok(fileStat.mtimeMs > 0);

  const dir = await getPreview('stat', { path: 'sub' });
  assert.equal(JSON.parse(dir.body).kind, 'dir');
});

// ---- 域级契约 ----

test('M1 只读：POST /preview/tree → 404；未知子路径 → 404', async () => {
  const post = await fetch(`${baseUrl}/preview/tree`, { method: 'POST' });
  assert.equal(post.status, 404);
  const bogus = await getPreview('bogus');
  assert.equal(bogus.status, 404);
});

test('Origin 校验：不可信 Origin → 400 bad_request', async () => {
  const { status, body } = await getPreview('tree', {}, { Origin: 'http://evil.example' });
  assert.equal(status, 400);
  assert.equal(jsonBody(body).error, 'bad_request');
});

test('no_workspace：未选工作区 → 409（随后恢复）', async () => {
  clearWorkspace();
  try {
    const tree = await getPreview('tree');
    assert.equal(tree.status, 409);
    assert.equal(jsonBody(tree.body).error, 'no_workspace');
    const file = await getPreview('file', { path: 'a.md' });
    assert.equal(file.status, 409);
  } finally {
    setWorkspace(wsRoot);
  }
});

// ---- 会话级作用域（?runId=）----
// 意义：Host 的"当前工作区"是进程内状态（重启即丢），而用户经常直接点开一条
// 历史会话看文件。此时面板必须能按**那条会话 Run 的工作区**取文件，而不是报
// no_workspace，更不能悄悄回落到当前工作区（看 A 会话却拿到 B 工作区的文件）。

test('runId 作用域：按该 Run 的工作区取树，与当前工作区无关', async () => {
  // 会话 B 的工作区（与当前工作区 wsRoot 完全不同）
  const wsB = path.join(base, 'ws-b');
  fs.mkdirSync(wsB, { recursive: true });
  fs.writeFileSync(path.join(wsB, 'only-b.md'), '# B\n', 'utf8');
  fs.writeFileSync(path.join(wsB, 'b.txt'), 'B workspace\n', 'utf8');
  const original = manager.getWorkspaceRoot.bind(manager);
  manager.getWorkspaceRoot = (runId: string): string | null =>
    runId === 'run-b' ? fs.realpathSync.native(wsB) : original(runId);
  try {
    const tree = await getPreview('tree', { runId: 'run-b' });
    assert.equal(tree.status, 200);
    const listing = JSON.parse(tree.body) as { entries: { name: string }[] };
    const names = listing.entries.map((entry) => entry.name).sort();
    assert.deepEqual(names, ['b.txt', 'only-b.md']);
    // 当前工作区的文件不得出现（作用域必须是"替换"而不是"叠加"）
    assert.ok(!names.includes('a.md'));

    const file = await getPreview('file', { path: 'only-b.md', runId: 'run-b' });
    assert.equal(file.status, 200);
    assert.equal(file.body, '# B\n');

    const stat = await getPreview('stat', { path: 'b.txt', runId: 'run-b' });
    assert.equal(stat.status, 200);
    assert.equal((JSON.parse(stat.body) as { path: string }).path, 'b.txt');
  } finally {
    manager.getWorkspaceRoot = original;
  }
});

test('runId 作用域：Run 解析不到 → 409 no_workspace，绝不回落到当前工作区', async () => {
  const tree = await getPreview('tree', { runId: 'no-such-run' });
  assert.equal(tree.status, 409);
  assert.equal(jsonBody(tree.body).error, 'no_workspace');
  const file = await getPreview('file', { path: 'a.md', runId: 'no-such-run' });
  assert.equal(file.status, 409);
  assert.equal(jsonBody(file.body).error, 'no_workspace');
});

test('runId 作用域：路径穿越仍被拒（作用域不放松路径校验）', async () => {
  const wsB = path.join(base, 'ws-b');
  fs.mkdirSync(wsB, { recursive: true });
  const original = manager.getWorkspaceRoot.bind(manager);
  manager.getWorkspaceRoot = (runId: string): string | null =>
    runId === 'run-b' ? fs.realpathSync.native(wsB) : original(runId);
  try {
    const traversal = await getPreview('tree', { path: '../outside', runId: 'run-b' });
    assert.equal(traversal.status, 400);
    assert.equal(jsonBody(traversal.body).error, 'invalid_path');
    // 会话作用域下读另一工作区的文件同样 404（不是 200，也不是 403 幻觉）
    const cross = await getPreview('file', { path: 'a.md', runId: 'run-b' });
    assert.equal(cross.status, 404);
    assert.equal(jsonBody(cross.body).error, 'not_found');
  } finally {
    manager.getWorkspaceRoot = original;
  }
});

test('错误码封闭集合：PREVIEW_ERROR_CODES 恰好 7 个且 message===code', () => {
  assert.deepEqual(
    [...PREVIEW_ERROR_CODES],
    [
      'invalid_path',
      'outside_workspace',
      'not_found',
      'too_large',
      'unsupported',
      'permission_denied',
      'no_workspace',
    ],
  );
  for (const code of PREVIEW_ERROR_CODES) {
    const err = new PreviewError(code);
    assert.equal(err.message, code, 'message 必须等于 code（禁止散文消息）');
    assert.equal(err.name, 'PreviewError');
    assert.ok(err.status >= 400 && err.status <= 416, `${code} 的 HTTP 状态应落在 4xx`);
  }
  // detail 只携带机器可读字段
  const tooLarge = new PreviewError('too_large', { limit: 1024 });
  assert.equal(tooLarge.detail?.limit, 1024);
});

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
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(`\npreview-api 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

void main();
