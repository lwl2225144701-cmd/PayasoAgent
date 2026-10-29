// 候选包烟测：真实 Electron + 自带后端 + 前端挂载，经原生命名管道确认窗口就绪。
// headless runner 使用测试构建跳过管理员降权；不替代真实旧版安装升级。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

assert.equal(process.platform, 'win32');
const dir = mkdtempSync(path.join(os.tmpdir(), 'payaso-window-ready-'));
const probe = path.join(dir, 'UpdateProbe.exe');
const compiler = path.join(
  process.env.WINDIR,
  'Microsoft.NET',
  'Framework64',
  'v4.0.30319',
  'csc.exe',
);
const compile = spawnSync(
  compiler,
  [
    '/nologo',
    '/platform:x64',
    '/define:PAYASO_TESTING',
    '/reference:System.Web.Extensions.dll',
    `/out:${probe}`,
    path.resolve('apps/desktop/windows/PayasoUpdate.cs'),
  ],
  { encoding: 'utf8' },
);
assert.equal(compile.status, 0, compile.stdout + compile.stderr);
const exe = path.resolve('apps/desktop/release/win-unpacked/PayasoAgent.exe');
const version = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8')).version;
const result = spawnSync(probe, ['test-launch', exe, version, '90000'], {
  encoding: 'utf8',
  timeout: 190000,
  windowsHide: true,
  env: {
    ...process.env,
    PORT: '4699',
    PAYASO_HOME: path.join(dir, 'home'),
    ELECTRON_ENABLE_LOGGING: '1',
    ELECTRON_LOG_FILE: path.join(dir, 'electron.log'),
  },
});
if (result.status !== 0) {
  for (const file of [
    path.join(process.env.APPDATA, 'PayasoAgent', 'logs', 'updater.log'),
    path.join(process.env.LOCALAPPDATA, 'PayasoAgent', 'logs', 'windows-install.log'),
    path.join(dir, 'electron.log'),
  ])
    if (existsSync(file)) console.error(`${file}\n${readFileSync(file, 'utf8').slice(-8000)}`);
}
assert.equal(result.status, 0, result.stdout + result.stderr);
const ready = JSON.parse(result.stdout.trim());
assert.equal(ready.version, version);
assert.equal(ready.exe.toLowerCase(), exe.toLowerCase());
assert.ok(ready.pid > 0);
const stopped = spawnSync('taskkill.exe', ['/PID', String(ready.pid), '/T', '/F'], {
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
console.log(`PASS packaged Electron window and backend ready: version=${version} pid=${ready.pid}`);
