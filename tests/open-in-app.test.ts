// 模块: open-in-app 契约测试 —— /open-in-app/apps 与 /open-in-app/open 的
// path 目标校验（越界拒、合法路径到达应用阶段；用不存在的 app id 收尾，
// 因此不会真正启动任何应用）。
// 用法: npx tsx tests/open-in-app.test.ts（或随 npm run test:all 运行）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
