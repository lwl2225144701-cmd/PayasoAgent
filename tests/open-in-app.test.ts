// 模块: open-in-app 契约测试 —— /open-in-app/apps 与 /open-in-app/open。
// 两种目标两套数据源：文件目标问操作系统（macOS LaunchServices，其它平台回落
// 白名单），目录目标走编译期白名单。路径越界一律拒；用不存在的 app id 收尾，
// 因此不会真正启动任何应用。
// 用法: npx tsx tests/open-in-app.test.ts（或随 npm run test:all 运行）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLaunchInvocation } from '../src/host/open-in-app/invocation.js';
import { filterAppsForTarget, openableKindForPath } from '../src/host/open-in-app/openable.js';
import { queryFileAssociations } from '../src/host/open-in-app/os-assoc.js';
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

// ---- 启动参数推导（纯函数）----

test('buildLaunchInvocation：Windows 终端用 -d，绝不把目录当命令传（真机 0x80070005）', () => {
  const ws = 'D:\\Iragent';
  // 真机现象：`wt.exe D:\Iragent` → Windows Terminal 把裸路径当"要启动的程序"，
  // 报 0x80070005（启动"D:\Iragent"时）。必须走 -d。
  assert.deepEqual(
    buildLaunchInvocation({
      appId: 'terminal',
      executablePath: 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
      target: ws,
      platform: 'win32',
      targetIsDirectory: true,
    }),
    { args: ['-d', ws], cwd: ws },
  );
  // cmd.exe：不带参数，落点由 cwd 决定
  assert.deepEqual(
    buildLaunchInvocation({
      appId: 'terminal',
      executablePath: 'C:\\Windows\\System32\\cmd.exe',
      target: ws,
      platform: 'win32',
      targetIsDirectory: true,
    }),
    { args: [], cwd: ws },
  );
  // 编辑器/浏览器：参数就是目标本身；cwd 取父目录（文件不能当 cwd）
  assert.deepEqual(
    buildLaunchInvocation({
      appId: 'vscode',
      executablePath: 'C:\\Users\\x\\AppData\\Local\\Programs\\VS Code\\Code.exe',
      target: 'D:\\Iragent\\main.ts',
      platform: 'win32',
      targetIsDirectory: false,
    }),
    { args: ['D:\\Iragent\\main.ts'], cwd: 'D:\\Iragent' },
  );
});

test('buildLaunchInvocation：目录目标 cwd 用它自己，文件目标用父目录', () => {
  assert.deepEqual(
    buildLaunchInvocation({
      appId: 'terminal',
      executablePath: '/opt/homebrew/bin/foot',
      target: '/Users/x/ws',
      platform: 'darwin',
      targetIsDirectory: true,
    }),
    { args: ['/Users/x/ws'], cwd: '/Users/x/ws' },
  );
  assert.deepEqual(
    buildLaunchInvocation({
      appId: 'vscode',
      executablePath: '/usr/local/bin/code',
      target: '/Users/x/ws/readme.md',
      platform: 'darwin',
      targetIsDirectory: false,
    }),
    { args: ['/Users/x/ws/readme.md'], cwd: '/Users/x/ws' },
  );
  // stat 失败（路径不存在）按"不是目录"处理：cwd 只能是父目录
  const fallback = buildLaunchInvocation({
    appId: 'chrome',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    target: '/Users/x/ws/gone.pdf',
    platform: 'darwin',
    targetIsDirectory: false,
  });
  assert.equal(fallback.cwd, '/Users/x/ws');
});

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
async function listApps(path?: string): Promise<{
  source: string;
  apps: {
    id: string;
    label: string;
    icon?: string | null;
    isDefault?: boolean;
    opens?: string[];
  }[];
}> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const resp = await fetch(`${baseUrl}/open-in-app/apps${qs}`);
  assert.equal(resp.status, 200);
  return (await resp.json()) as Awaited<ReturnType<typeof listApps>>;
}

test('apps 端点：文件目标问系统（macOS）/回落白名单（其它平台），目录目标恒走白名单', async () => {
  const isDarwin = process.platform === 'darwin';
  const pdf = await listApps('docs/a.pdf');
  assert.equal(pdf.source, isDarwin ? 'os' : 'catalog');
  if (pdf.source === 'os') {
    // 系统来源：id 是 .app 绝对路径，最多一个默认，图标是 32px PNG data URL 或 null
    for (const app of pdf.apps) {
      assert.ok(app.id.startsWith('/') && app.id.endsWith('.app'), `${app.id} 应是 .app 绝对路径`);
      assert.ok(app.label.length > 0);
      if (app.icon != null) assert.match(app.icon, /^data:image\/png;base64,/);
    }
    assert.ok(pdf.apps.filter((app) => app.isDefault === true).length <= 1, '最多一个默认应用');
  } else {
    for (const app of pdf.apps) {
      assert.ok(
        (app.opens ?? []).includes('pdf') || (app.opens ?? []).includes('any'),
        `${app.id} 不该出现在 PDF 的列表里`,
      );
    }
  }
  const folder = await listApps();
  assert.equal(folder.source, 'catalog', '目录目标恒走白名单（系统无目录关联机制）');
  for (const app of folder.apps) {
    assert.ok(
      (app.opens ?? []).includes('folder') || (app.opens ?? []).includes('any'),
      `${app.id} 打不开文件夹`,
    );
  }
});

test('queryFileAssociations：真机文件 → 结构化系统关联列表（仅 macOS）', async () => {
  if (process.platform !== 'darwin') return; // 其它平台无适配器，由白名单兜底
  const apps = await queryFileAssociations(path.join(wsRoot, 'a.md'));
  assert.ok(apps !== null, 'macOS 上应拿到系统关联列表');
  for (const app of apps ?? []) {
    assert.ok(app.id.startsWith('/') && app.id.endsWith('.app'), app.id);
    assert.ok(app.label.length > 0);
    assert.equal(typeof app.isDefault, 'boolean');
    if (app.icon !== null) assert.match(app.icon, /^data:image\/png;base64,/);
  }
  assert.ok((apps ?? []).filter((app) => app.isDefault).length <= 1, '最多一个默认应用');
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

test('open 带合法 path → 通过越界校验，倒在系统列表复验（不启动任何应用）', async () => {
  const { status, json } = await openApp({ id: NO_SUCH_APP, path: 'sub/nested.txt' });
  assert.equal(status, 400);
  // 路径合法 → 走到"用最新系统关联列表复验 id"这一步；伪造 id 在此被拒
  assert.match(String(json.message), /该应用不能打开此文件/, '合法路径必须被接受并走到复验');
});

test('open action=reveal 缺 path → 400', async () => {
  const { status, json } = await openApp({ action: 'reveal' });
  assert.equal(status, 400);
  assert.match(String(json.message), /显示文件位置需要 path/);
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
