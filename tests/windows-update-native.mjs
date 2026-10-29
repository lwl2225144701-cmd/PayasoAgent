// 只在 Windows 跑真实 Shell COM/文件移动/进程与命名管道，不模拟链接 API。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Run native update tests on Windows');
const root = process.cwd();
const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'payaso 更新测试 ')));
const helper = path.join(root, 'apps', 'desktop', 'build', 'PayasoUpdate.exe');
const compiler = path.join(
  process.env.WINDIR,
  'Microsoft.NET',
  'Framework64',
  'v4.0.30319',
  'csc.exe',
);
const run = (exe, args, expected = 0, env = process.env) => {
  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
  assert.equal(
    result.status,
    expected,
    `${exe} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
};

try {
  run(process.execPath, ['apps/desktop/scripts/build-windows-helper.mjs']);
  const exe = path.join(dir, 'PayasoAgent.exe');
  const desktop = path.join(dir, 'Desktop', 'PayasoAgent.lnk');
  const menu = path.join(dir, 'StartMenu', 'PayasoAgent.lnk');
  const state = path.join(dir, 'snapshot.json');
  run(helper, ['prepare', state, exe, desktop, menu]);
  copyFileSync(path.join(process.env.WINDIR, 'System32', 'whoami.exe'), exe);
  run(helper, ['finish', state, exe]);
  const flags = 0x140100;
  const inspect = (file) => JSON.parse(run(helper, ['inspect', file]));
  for (const link of [desktop, menu]) {
    const actual = inspect(link);
    assert.equal(actual.target.toLowerCase(), exe.toLowerCase());
    assert.equal(actual.flags & flags, flags);
  }
  const backup = readFileSync(desktop);
  run(helper, ['prepare', state, exe, desktop, menu]);
  assert.equal(existsSync(desktop), false, '旧文件移动前必须已分离链接');
  assert.equal(existsSync(menu), false);
  run(helper, ['restore', state]);
  assert.deepEqual(readFileSync(desktop), backup, '失败回滚恢复旧链接快照');
  run(helper, ['prepare', state, exe, desktop, menu]);
  mkdirSync(path.join(dir, 'old-install'));
  renameSync(exe, path.join(dir, 'old-install', 'PayasoAgent.exe'));
  copyFileSync(path.join(process.env.WINDIR, 'System32', 'cmd.exe'), exe);
  run(helper, ['finish', state, exe]);
  assert.equal(inspect(desktop).target.toLowerCase(), exe.toLowerCase());
  assert.equal(inspect(desktop).flags & flags, flags);
  rmSync(desktop);
  run(helper, ['prepare', state, exe, desktop, menu]);
  run(helper, ['finish', state, exe]);
  assert.equal(existsSync(desktop), false, '升级不恢复用户主动删除的图标');
  run(helper, ['repair', exe, desktop, menu]);
  assert.equal(existsSync(desktop), false);
  console.log(
    'PASS native shortcut flags / detach-before-move / rollback / deleted-icon preservation',
  );

  // 测试构建只跳过 CI runner 的管理员降权分支；生产二进制不包含 test-launch 命令。
  const probe = path.join(dir, 'UpdateProbe.exe');
  run(compiler, [
    '/nologo',
    '/platform:x64',
    '/define:PAYASO_TESTING',
    '/reference:System.Web.Extensions.dll',
    `/out:${probe}`,
    path.join(root, 'apps/desktop/windows/PayasoUpdate.cs'),
  ]);
  run(probe, ['test-install', path.join(process.env.WINDIR, 'System32', 'whoami.exe'), '']);
  console.log('PASS headless installer test uses a restricted current-user process');
  const fixture = path.join(dir, 'Fixture.cs');
  const fixtureExe = path.join(dir, 'Fixture.exe');
  writeFileSync(
    fixture,
    `using System; using System.IO; using System.IO.Pipes; using System.Text; using System.Diagnostics; using System.Threading;
class Fixture {
  static void Main(string[] args) {
    if (Environment.GetEnvironmentVariable("PAYASO_FIXTURE_MODE") == "exit") return;
    string token = null;
    foreach(string arg in args) if(arg.StartsWith("--payaso-update-token=")) token = arg.Substring("--payaso-update-token=".Length);
    using(var pipe = new NamedPipeClientStream(".", "PayasoAgent-update-" + token, PipeDirection.InOut)) {
      pipe.Connect(5000);
      string version = Environment.GetEnvironmentVariable("PAYASO_FIXTURE_MODE") == "wrong" ? "0.0.0" : "0.4.23";
      string exe = Process.GetCurrentProcess().MainModule.FileName.Replace("\\\\", "\\\\\\\\");
      string payload = "{\\"token\\":\\"" + token + "\\",\\"version\\":\\"" + version + "\\",\\"exe\\":\\"" + exe + "\\",\\"pid\\":" + Process.GetCurrentProcess().Id + "}\\n";
      byte[] data = Encoding.UTF8.GetBytes(payload); pipe.Write(data,0,data.Length); pipe.Flush();
    }
    Thread.Sleep(1500);
  }
}`,
  );
  run(compiler, ['/nologo', '/platform:x64', `/out:${fixtureExe}`, fixture]);
  run(probe, ['test-launch', fixtureExe, '0.4.23', '5000']);
  run(probe, ['test-launch', fixtureExe, '0.4.23', '5000'], 1, {
    ...process.env,
    PAYASO_FIXTURE_MODE: 'wrong',
  });
  run(probe, ['test-launch', fixtureExe, '0.4.23', '500'], 1, {
    ...process.env,
    PAYASO_FIXTURE_MODE: 'exit',
  });
  console.log('PASS native direct process launch / version and PID readiness / early-exit timeout');
} finally {
  // 失败场景的子进程最多停留 1.5 秒，稍后由系统临时目录回收；不能掩盖测试错误。
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows executable may still be open. */
  }
}
