// 在临时安装目录实际安装已发布 0.4.22，然后用候选 NSIS 完成更新、重启与就绪核验。
// 仅用于一次性 Windows 桌面验收机：会建立 HKCU 安装记录和当前用户快捷方式。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

assert.equal(process.platform, 'win32');
assert.ok(
  process.argv.includes('--allow-test-install'),
  '仅在专用 Windows 验收机的普通用户桌面运行，并显式传入 --allow-test-install',
);
const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'payaso-upgrade-')));
const probe = path.join(dir, 'UpdateProbe.exe');
const compiler = path.join(
  process.env.WINDIR,
  'Microsoft.NET',
  'Framework64',
  'v4.0.30319',
  'csc.exe',
);
const run = (exe, args, timeout = 240000) => {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout });
  if (r.status !== 0) {
    for (const file of [
      path.join(process.env.LOCALAPPDATA, 'PayasoAgent/logs/windows-install.log'),
      path.join(process.env.APPDATA, 'PayasoAgent/logs/updater.log'),
    ])
      if (existsSync(file)) console.error(readFileSync(file, 'utf8').slice(-12000));
  }
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout.trim();
};
run(compiler, [
  '/nologo',
  '/platform:x64',
  '/define:PAYASO_TESTING',
  '/reference:System.Web.Extensions.dll',
  `/out:${probe}`,
  path.resolve('apps/desktop/windows/PayasoUpdate.cs'),
]);
const old = path.join(dir, 'old-0.4.22.exe');
run('curl.exe', [
  '--fail',
  '--location',
  '--retry',
  '3',
  '--output',
  old,
  'https://github.com/lwl2225144701-cmd/PayasoAgent/releases/download/v0.4.22/PayasoAgent-0.4.22-setup.exe',
]);
const installed = path.join(dir, 'Installed App');
run(probe, ['test-install', old, `/S /D=${installed}`]);
const exe = path.join(installed, 'PayasoAgent.exe');
assert.ok(existsSync(exe), '旧版必须真实安装成功');
const version = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8')).version;
const candidate = path.resolve(`apps/desktop/release/PayasoAgent-${version}-setup.exe`);
run(probe, ['test-install', candidate, `/S --updated --force-run /D=${installed}`]);
const log = readFileSync(
  path.join(process.env.LOCALAPPDATA, 'PayasoAgent/logs/windows-install.log'),
  'utf8',
);
const lines = log.split(/\r?\n/).filter((line) => line.includes(' READY '));
assert.ok(lines.length > 0, '安装器必须得到真实窗口就绪回执');
const ready = JSON.parse(lines.at(-1).split(' READY ')[1]);
assert.equal(ready.version, version);
assert.equal(realpathSync.native(ready.exe).toLowerCase(), realpathSync.native(exe).toLowerCase());
const titles = JSON.parse(run(probe, ['test-dialogs']));
assert.ok(
  !titles.some((title) => /Problem with Shortcut|快捷方式存在问题/i.test(title)),
  JSON.stringify(titles),
);
const links = [
  path.join(process.env.USERPROFILE, 'Desktop/PayasoAgent.lnk'),
  path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/PayasoAgent.lnk'),
];
const helper = path.join(installed, 'resources/PayasoUpdate.exe');
for (const link of links) {
  const observed = JSON.parse(run(helper, ['inspect', link]));
  assert.equal(
    realpathSync.native(observed.target).toLowerCase(),
    realpathSync.native(exe).toLowerCase(),
  );
  assert.equal(observed.flags & 0x140100, 0x140100);
}
await new Promise((resolve) => setTimeout(resolve, 30000));
const laterTitles = JSON.parse(run(probe, ['test-dialogs']));
assert.ok(
  !laterTitles.some((title) => /Problem with Shortcut|快捷方式存在问题/i.test(title)),
  JSON.stringify(laterTitles),
);
for (const link of links)
  assert.equal(JSON.parse(run(helper, ['inspect', link])).flags & 0x140100, 0x140100);
run('taskkill.exe', ['/PID', String(ready.pid), '/T', '/F']);
console.log(
  `PASS actual 0.4.22 NSIS -> ${version}: installed, automatically ready, no shortcut error dialog, links stable after 30s`,
);
