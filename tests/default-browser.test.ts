import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openFileInDefaultBrowser } from '../src/host/default-browser.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-browser-open-'));
const workspace = path.join(base, 'workspace');
const outside = path.join(base, 'outside.html');
fs.mkdirSync(path.join(workspace, 'site'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'site', 'index.html'), '<h1>ok</h1>');
fs.writeFileSync(path.join(workspace, 'note.txt'), 'not html');
fs.writeFileSync(outside, 'outside');

let openedUrl = '';
const opener = async (url: string) => {
  openedUrl = url;
};

try {
  await openFileInDefaultBrowser(workspace, 'site/index.html', { opener, platform: 'darwin' });
  assert.match(openedUrl, /^file:\/\//);
  assert.ok(openedUrl.endsWith('/site/index.html'));
  console.log('  [PASS] Workspace 内 HTML 交给 file URL 默认处理器');

  await openFileInDefaultBrowser(workspace, 'note.txt', { opener, platform: 'darwin' });
  assert.ok(openedUrl.endsWith('/note.txt'));
  console.log('  [PASS] 非 HTML 文件也可打开（交给系统默认应用）');

  await assert.rejects(
    () => openFileInDefaultBrowser(workspace, '../outside.html', { opener, platform: 'darwin' }),
    /invalid preview path/,
  );
  console.log('  [PASS] 路径穿越被拒绝');

  fs.symlinkSync(outside, path.join(workspace, 'escape.html'));
  await assert.rejects(
    () => openFileInDefaultBrowser(workspace, 'escape.html', { opener, platform: 'darwin' }),
    /symlink|逃出/,
  );
  console.log('  [PASS] 指向 Workspace 外的 symlink 被拒绝');

  await assert.rejects(
    () => openFileInDefaultBrowser(workspace, 'site/index.html', { opener, platform: 'linux' }),
    /only available on macOS/,
  );
  console.log('  [PASS] 非 macOS 平台 fail-closed');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('\nDefault browser tests: 5 PASS / 0 FAIL');
