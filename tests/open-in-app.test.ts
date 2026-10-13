// 模块: open-in-app 契约测试 —— /open-in-app/apps 与 /open-in-app/open 的
// path 目标校验（越界拒、合法路径到达应用阶段；用不存在的 app id 收尾，
// 因此不会真正启动任何应用）。
// 用法: npx tsx tests/open-in-app.test.ts（或随 npm run test:all 运行）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterAppsForTarget, openableKindForPath } from '../src/host/open-in-app/openable.js';
import { createHostServer, RunManager } from '../src/host/server.js';
import { setWorkspace } from '../src/host/workspace.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-openinapp-test-'));
process.env.SANDBOX_ROOT = path.join(base, 'runtime-sandbox');
process.env.PAYASO_DB_PATH = path.join(base, 'payaso.db');

// ---- 工作区夹具：普通文件 + 嵌套 + 工作区外文件（symlink 逃逸用）----
const wsRoot = path.join(base, 'ws');
const outsideDir = path.join(base, 'outside');
fs.mkdirSync(path.join(wsRoot, 'sub'), { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
fs.writeFileSync(path.join(wsRoot, 'a.md'), '# hi\n', 'utf8');
fs.writeFileSync(path.join(wsRoot, 'sub', 'nested.txt'), 'nested\n', 'utf8');
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'OUTSIDE-SECRET', 'utf8');
fs.symlinkSync(outsideDir, path.join(wsRoot, 'link-out'));

setWorkspace(wsRoot);

const server = createHostServer(new RunManager());
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const addr = server.address();
assert.ok(addr && typeof addr === 'object');
const baseUrl = `http://127.0.0.1:${addr.port}`;

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

/** 不存在的 app id：路径校验通过后必倒在应用查找上（不会启动任何东西）。 */
const NO_SUCH_APP = 'no-such-app-xyz';

async function openApp(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const resp = await fetch(`${baseUrl}/open-in-app/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: (await resp.json()) as any };
}

// ---- 目标类别判定（纯函数）----

test('openableKindForPath：pdf/图片/office/文本/未识别', () => {
  assert.equal(openableKindForPath('a/b.pdf'), 'pdf');
  assert.equal(openableKindForPath('a/b.PNG'), 'image', '后缀大小写不敏感');
  assert.equal(openableKindForPath('a/b.docx'), 'word');
  assert.equal(openableKindForPath('a/b.xlsx'), 'sheet');
  assert.equal(openableKindForPath('a/b.csv'), 'sheet');
  assert.equal(openableKindForPath('a/b.pptx'), 'slides');
  assert.equal(openableKindForPath('a/b.ts'), 'text');
  assert.equal(openableKindForPath('a/Makefile'), 'text', '无扩展名走文本表');
  assert.equal(openableKindForPath('a/b.zip'), null, '未识别后缀 → null（只有 any 应用会列出）');
});

// ---- 按目标过滤（纯函数）----

const APPS = [
  { id: 'finder', label: '访达', opens: ['any' as const] },
  { id: 'cursor', label: 'Cursor', opens: ['text' as const, 'folder' as const] },
  { id: 'chrome', label: 'Chrome', opens: ['pdf' as const, 'image' as const, 'text' as const] },
  { id: 'word', label: 'Word', opens: ['word' as const] },
];

test('filterAppsForTarget：文件夹目标 → 只要 folder/any（IDE 与访达）', () => {
  assert.deepEqual(
    filterAppsForTarget(APPS, null).map((a) => a.id),
    ['finder', 'cursor'],
  );
});

test('filterAppsForTarget：文件目标 → 只要该类别/any（PDF 不该出现 Cursor/Word）', () => {
  assert.deepEqual(
    filterAppsForTarget(APPS, 'docs/a.pdf').map((a) => a.id),
    ['finder', 'chrome'],
  );
  assert.deepEqual(
    filterAppsForTarget(APPS, 'docs/a.docx').map((a) => a.id),
    ['finder', 'word'],
  );
  assert.deepEqual(
    filterAppsForTarget(APPS, 'src/a.ts').map((a) => a.id),
    ['finder', 'cursor', 'chrome'],
  );
  // 未识别后缀：只有 any（访达）
  assert.deepEqual(
    filterAppsForTarget(APPS, 'a.zip').map((a) => a.id),
    ['finder'],
  );
});

// ---- 端点：列表按目标过滤 ----

test('GET /open-in-app/apps → 200 + apps 数组', async () => {
  const resp = await fetch(`${baseUrl}/open-in-app/apps`);
  assert.equal(resp.status, 200);
  const body = (await resp.json()) as { apps: unknown };
  assert.ok(Array.isArray(body.apps));
  for (const app of body.apps) {
    assert.equal(typeof (app as { id: unknown }).id, 'string');
    assert.equal(typeof (app as { label: unknown }).label, 'string');
  }
});

/** 拉取（可选按目标过滤的）应用列表。 */
async function listApps(path?: string): Promise<{ apps: { id: string; opens: string[] }[] }> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const resp = await fetch(`${baseUrl}/open-in-app/apps${qs}`);
  assert.equal(resp.status, 200);
  return (await resp.json()) as { apps: { id: string; opens: string[] }[] };
}

test('apps 端点按目标过滤：PDF 只列 pdf/any，docx 只列 word/any，无 path 只列 folder/any', async () => {
  const pdf = await listApps('docs/a.pdf');
  for (const app of pdf.apps) {
    assert.ok(
      app.opens.includes('pdf') || app.opens.includes('any'),
      `${app.id} 不该出现在 PDF 的列表里`,
    );
  }
  const docx = await listApps('docs/a.docx');
  for (const app of docx.apps) {
    assert.ok(
      app.opens.includes('word') || app.opens.includes('any'),
      `${app.id} 不该出现在 docx 列表里`,
    );
  }
  const folder = await listApps();
  for (const app of folder.apps) {
    assert.ok(app.opens.includes('folder') || app.opens.includes('any'), `${app.id} 打不开文件夹`);
  }
  const unknown = await listApps('a.zip');
  for (const app of unknown.apps) {
    assert.ok(app.opens.includes('any'), `${app.id} 不该出现在未识别后缀的列表里`);
  }
});

test('open 缺 id → 400', async () => {
  const { status, json } = await openApp({});
  assert.equal(status, 400);
  assert.match(String(json.message), /缺少 id/);
});

test('open 无 path → 打开工作区根（到达应用阶段）', async () => {
  const { status, json } = await openApp({ id: NO_SUCH_APP });
  assert.equal(status, 400);
  assert.match(String(json.message), /应用未安装/);
});

test('open 带合法 path → 通过越界校验，到达应用阶段', async () => {
  const { status, json } = await openApp({ id: NO_SUCH_APP, path: 'sub/nested.txt' });
  assert.equal(status, 400);
  assert.match(String(json.message), /应用未安装/, '合法路径必须被接受并走到应用查找');
});

test('open 带 ../ 穿越 path → 400 路径无效（归一化层就拒，应用阶段之前）', async () => {
  const { status, json } = await openApp({ id: NO_SUCH_APP, path: '../outside/secret.txt' });
  assert.equal(status, 400);
  // .. 段在 normalizeRelPath 即判 invalid_path；symlink 逃逸才走 outside_workspace
  assert.match(String(json.message), /路径无效|路径越出工作区/);
});

test('open 带 symlink 逃逸 path → 400 路径越出工作区', async () => {
  const { status, json } = await openApp({ id: NO_SUCH_APP, path: 'link-out/secret.txt' });
  assert.equal(status, 400);
  assert.match(String(json.message), /路径越出工作区/);
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
    await new Promise<void>((r) => server.close(() => r()));
  }
  console.log(`\nopen-in-app 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

void main();
