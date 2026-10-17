// 模块: 桌面端「检查更新 / 自更新」契约 —— 纯逻辑单测 + 壳侧与 CI 的源码契约。
// 用法: npx tsx tests/desktop-update.test.ts
//
// 为什么这么切：electron-updater 的接线（coordinator.ts）import electron，跑不进
// 这个进程，所以分两层锁 ——
//   1. 纯逻辑（version/schedule/activeTasks）直接跑真函数；
//   2. 接线与打包配置（autoDownload 等开关、开发版门禁、安装前交接、CI 上传
//      latest*.yml）按源码/配置文本锁，改名或漏配立刻红。
//
// 背景：docs/plans/auto-update-调研报告.md §5（DSH 逆向结论 + 裁剪方案）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareVersions,
  describeUpdateFailure,
  isNetworkFailure,
  isNewerVersion,
  nextCheckDelay,
  parseVersion,
} from '../apps/desktop/src/update/policy';
import { ACTIVE_RUN_STATUSES, activeTasks } from '../apps/desktop/src/update/tasks';
import { isCancellable } from '../src/host/run-types';

const shellSource = (relative: string): string =>
  fs.readFileSync(path.join('apps', 'desktop', relative), 'utf8');

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

/**
 * 解析 release.yml 的 job 块 —— 只取 `jobs:` 之后，别把 `on: push:` 当成 job。
 * 背景（真事故）：2026-10-17 重组 workflow 时，两个 build job 里那条没有 `- name:`
 * 的 `- uses: actions/checkout@v4` 被整条丢掉 → 工作区为空 → setup-node 报
 * "The specified node version file … .nvmrc does not exist"，两个 job 3~4 秒就失败。
 */
function parseJobs(wf: string): string[] {
  const section = wf.slice(wf.indexOf('\njobs:'));
  return section
    .split(/\n {2}(?=[a-z0-9-]+:\n)/)
    .filter((block) => /^[a-z0-9-]+:$/.test(block.split('\n')[0]));
}

function jobNameOf(block: string): string {
  return block.split('\n')[0].replace(':', '');
}

// ── 版本门禁 ────────────────────────────────────────────────────────────────

test('parseVersion：核心段 + 预发布后缀', () => {
  assert.deepEqual(parseVersion('0.4.6'), { numbers: [0, 4, 6], prerelease: '' });
  assert.deepEqual(parseVersion('v1.2.3'), { numbers: [1, 2, 3], prerelease: '' });
  assert.deepEqual(parseVersion('0.2.0-rc.2'), { numbers: [0, 2, 0], prerelease: 'rc.2' });
  // 非法段按 0（宁可判成旧，也不要抛异常打断检查流程）
  assert.deepEqual(parseVersion('x.y.z'), { numbers: [0, 0, 0], prerelease: '' });
});

test('compareVersions：数值比较、位数补齐、预发布恒小于同号正式版', () => {
  assert.ok(compareVersions('0.4.6', '0.4.5') > 0);
  assert.ok(compareVersions('0.4.5', '0.4.6') < 0);
  assert.equal(compareVersions('0.4.6', '0.4.6'), 0);
  assert.ok(compareVersions('0.4.10', '0.4.9') > 0, '数字段不是字典序');
  assert.ok(compareVersions('1.0', '0.9.9') > 0, '位数不同要补齐');
  assert.ok(compareVersions('0.2.0', '0.2.0-rc.2') > 0, '正式版大于预发布版');
  assert.ok(compareVersions('0.2.0-rc.3', '0.2.0-rc.2') > 0);
});

test('isNewerVersion：只认严格更新（降级/相同一律否）', () => {
  assert.equal(isNewerVersion('0.4.7', '0.4.6'), true);
  assert.equal(isNewerVersion('0.4.6', '0.4.6'), false);
  assert.equal(isNewerVersion('0.4.5', '0.4.6'), false, 'allowDowngrade=false 之外的双保险');
  assert.equal(isNewerVersion('', '0.4.6'), false);
});

// ── 轮询节奏 ────────────────────────────────────────────────────────────────

const schedule = (attempt: number, random = () => 0.5) =>
  nextCheckDelay({
    attempt,
    baseMs: 10 * 60 * 1000,
    maxMs: 6 * 60 * 60 * 1000,
    jitterRatio: 0.2,
    random,
  });

test('nextCheckDelay：基础间隔 / 指数退避 / 上限', () => {
  assert.equal(schedule(0), 10 * 60 * 1000);
  assert.equal(schedule(1), 20 * 60 * 1000);
  assert.equal(schedule(2), 40 * 60 * 1000);
  assert.equal(schedule(20), 6 * 60 * 60 * 1000, '退避夹在上限');
  assert.equal(schedule(-3), 10 * 60 * 1000, '负数当 0');
});

test('nextCheckDelay：±jitter 抖动且不越界', () => {
  const low = schedule(0, () => 0);
  const high = schedule(0, () => 1);
  assert.equal(low, Math.round(10 * 60 * 1000 * 0.8));
  assert.equal(high, Math.round(10 * 60 * 1000 * 1.2));
  assert.ok(low < 10 * 60 * 1000 && high > 10 * 60 * 1000, '抖动要真的打散');
  assert.ok(schedule(20, () => 1) <= 6 * 60 * 60 * 1000 * 1.2);
});

// ── 错误分类 ────────────────────────────────────────────────────────────────

test('isNetworkFailure：认网络类错误串，不冤枉别的', () => {
  assert.equal(isNetworkFailure('net::ERR_INTERNET_DISCONNECTED'), true);
  assert.equal(isNetworkFailure('getaddrinfo ENOTFOUND api.github.com'), true);
  assert.equal(isNetworkFailure('connect ETIMEDOUT 140.82.112.5:443'), true);
  assert.equal(isNetworkFailure('Error: sha512 mismatch'), false);
});

test('describeUpdateFailure：网络问题与安装失败分开说', () => {
  assert.match(describeUpdateFailure('check', 'net::ERR_TIMED_OUT'), /网络不可用/);
  assert.match(describeUpdateFailure('download', 'ECONNRESET'), /网络不可用/);
  assert.equal(describeUpdateFailure('check', 'sha512 mismatch'), '检查更新失败');
  assert.equal(describeUpdateFailure('install', 'EPERM'), '安装更新失败');
});

// ── 在跑任务判定（与 Host 权威定义对齐）────────────────────────────────────

test('ACTIVE_RUN_STATUSES 与 Host isCancellable() 完全一致', () => {
  // 状态全集来自 src/host/persistence/store.ts 的 StoredRunStatus
  const allStatuses = ['running', 'stopping', 'completed', 'failed', 'stopped', 'interrupted'];
  for (const status of allStatuses) {
    assert.equal(
      ACTIVE_RUN_STATUSES.includes(status),
      isCancellable(status as Parameters<typeof isCancellable>[0]),
      `壳与 Host 对 ${status} 的判定必须一致 —— 不一致会导致装更新时误判"没任务"`,
    );
  }
});

test('activeTasks：只挑在跑的，形状不对不炸', () => {
  const payload = {
    runs: [
      { runId: 'a', status: 'running', task: '写文档' },
      { runId: 'b', status: 'stopping', task: '改代码' },
      { runId: 'c', status: 'completed', task: '早跑完了' },
      { runId: 'd', status: 'failed', task: '挂了' },
      { runId: 'e' },
    ],
  };
  assert.deepEqual(activeTasks(payload), [
    { runId: 'a', task: '写文档' },
    { runId: 'b', task: '改代码' },
  ]);
  assert.deepEqual(activeTasks({ runs: 'nope' }), []);
  assert.deepEqual(activeTasks(null), []);
  assert.deepEqual(activeTasks(undefined), []);
});

// ── 壳侧接线契约（coordinator.ts / main.ts）───────────────────────────────

test('coordinator：不自动下载/退出不自动装/不降级，且挂了 error 监听', () => {
  const src = shellSource(path.join('src', 'update', 'coordinator.ts'));
  assert.match(src, /autoUpdater\.autoDownload = false/, '下载必须用户点');
  assert.match(src, /autoUpdater\.autoInstallOnAppQuit = false/, '退出时不许偷偷装');
  assert.match(src, /autoUpdater\.allowDowngrade = false/);
  assert.match(
    src,
    /autoUpdater\.on\('error'/,
    "未监听的 'error' 会让 EventEmitter 直接抛 —— 必须挂监听",
  );
  assert.match(src, /isNewerVersion\(version, options\.currentVersion\)/, '版本门禁要真的用上');
});

test('coordinator：开发版门禁 = 打包 + app-update.yml 存在', () => {
  const src = shellSource(path.join('src', 'update', 'coordinator.ts'));
  assert.match(src, /return app\.isPackaged && existsSync\(appUpdateConfigPath\(\)\)/);
  assert.match(src, /path\.join\(process\.resourcesPath, 'app-update\.yml'\)/);
});

test('coordinator：安装前交接顺序 —— 查任务 → 确认 → 停后端 → quitAndInstall，失败回滚', () => {
  const src = shellSource(path.join('src', 'update', 'coordinator.ts'));
  const order = ['listActiveTasks', 'showMessageBox(@@)', 'backend.stop', 'quitAndInstall'];
  // 顺序断言：查任务在停后端之前，停后端在 quitAndInstall 之前
  const iTasks = src.indexOf('options.backend.listActiveTasks()');
  const iStop = src.indexOf('await options.backend.stop()');
  const iQuit = src.indexOf('autoUpdater.quitAndInstall(true, true)');
  assert.ok(iTasks > 0 && iStop > iTasks && iQuit > iStop, `顺序不对：${order.join(' → ')}`);
  assert.match(src, /TASKS_TIMEOUT_MS = 10_000/, '查任务必须超时（DSH 同款 10s）');
  assert.match(src, /if \(response !== 0\) return;/, '取消路径不许授予安装许可');
  assert.match(
    src,
    /catch \(error\) \{[\s\S]{0,400}await options\.backend\.start\(\)/,
    '后端已停但没进安装流程时必须回滚重拉',
  );
});

test('main.ts：后端桥接现成端点 —— GET /runs + 优雅关停，后端零改动', () => {
  const src = shellSource(path.join('src', 'main.ts'));
  assert.match(src, /fetch\(`\$\{BACKEND_URL\}\/runs`/);
  assert.match(src, /return activeTasks\(await res\.json\(\)\)/);
  assert.match(src, /listActiveTasks,\n\s+stop: stopBackend,\n\s+start: startBackend/s);
  assert.match(src, /label: '检查更新…'/, '菜单要有手动入口');
  assert.match(src, /updates = createUpdateCoordinator\(/, 'boot 里要真的建协调器');
  assert.match(src, /updates\.startAutoCheck\(\)/);
  // 已经停过后端时退出别再 preventDefault（否则会拖住 quitAndInstall 的替换时机）
  assert.match(src, /if \(quitting \|\| backend === null\) return;/);
});

// ── 打包与 CI 契约（feed 没了 = 永远查不到更新）──────────────────────────

test('electron-builder：GitHub provider + updaterCacheDirName', () => {
  const yml = shellSource('electron-builder.yml');
  assert.match(yml, /publish:\n\s+provider: github/, '没配 provider 就不生成 app-update.yml');
  assert.match(yml, /owner: lwl2225144701-cmd/);
  assert.match(yml, /repo: PayasoAgent/);
  assert.match(yml, /releaseType: release/, 'draft 不会被 latest release 命中');
  // 缓存目录名：v26 由 appInfo 从包名派生，配置无效；根级写它会让打包校验直接失败
  // （本地打包实测），所以这里锁“别写”，并锁注释里说明了派生规则。
  assert.ok(
    !/^updaterCacheDirName:/m.test(yml),
    '根级 updaterCacheDirName 会让 electron-builder 校验失败',
  );
  assert.match(yml, /派生自包名/, '要在注释里写明派生规则，免得后人又去加配置');
  assert.ok(!/^publish: null$/m.test(yml), '旧的 publish: null 必须清掉');
});

// ── 打包产物自检：运行时依赖必须真的进包（v0.4.8 / v0.4.9 装完起不来）────────
//
// 真事故（2026-10-17 用户实装复现）：electron-builder.yml 的 files 里写了
// `!node_modules/**`。`files` 里的 `!` 模式会被 electron-builder 当成「连生产依赖
// 一起排除」的规则（fileMatcher.js getNodeModuleFileMatcher 只收 exclude），
// 而 devDependencies 本来就不会进包。结果 electron-updater 及其 15 个依赖全被排掉，
// main.js 静态 import 抛 ERR_MODULE_NOT_FOUND —— 打包成功、上传成功、用户一启动整个壳崩。
// 现在两道锁：配置层不排 node_modules + 打包后 verify-package.mjs 按产物实测。

test('打包配置：files 不得排除 node_modules（会把生产依赖连坐排掉）', () => {
  const yml = shellSource('electron-builder.yml');
  const lines = yml.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'files:');
  assert.ok(start >= 0, 'electron-builder.yml 里找不到 files: 段');
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+-\s+(.+)$/.exec(line);
    if (!match) break;
    patterns.push(match[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  assert.ok(patterns.length > 0, 'files: 段解析为空');
  const excludes = patterns.filter((p) => p.startsWith('!') && p.includes('node_modules'));
  assert.deepEqual(
    excludes,
    [],
    `files 里不能排除 node_modules（会把 electron-updater 这类生产依赖一起排掉）: ${excludes.join(', ')}`,
  );
});

test('打包脚本：每个 dist 入口都要跑 verify-package 产物自检', () => {
  const pkg = JSON.parse(shellSource('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  // electron-updater 是运行时依赖：必须在 dependencies（devDependencies 不进包）
  assert.ok(pkg.dependencies?.['electron-updater'], 'electron-updater 必须在 dependencies');
  assert.equal(
    pkg.devDependencies?.['electron-updater'],
    undefined,
    'electron-updater 不能在 devDependencies',
  );

  const scripts = pkg.scripts ?? {};
  assert.equal(scripts['verify:package'], 'node scripts/verify-package.mjs');
  assert.ok(
    fs.existsSync(path.join('apps', 'desktop', 'scripts', 'verify-package.mjs')),
    'scripts/verify-package.mjs 不存在',
  );
  assert.match(String(scripts['dist:mac']), /verify-package\.mjs/);
  // dmg / win 会出 feed：自检要把 app-update.yml 也一起卡住
  assert.match(String(scripts['dist:dmg']), /verify-package\.mjs --require-feed/);
  assert.match(String(scripts['dist:win']), /verify-package\.mjs --require-feed/);
});

test('release.yml：每个 job 第一步必须是 checkout（漏了 setup-node 读不到 .nvmrc）', () => {
  const wf = fs.readFileSync(path.join('.github', 'workflows', 'release.yml'), 'utf8');
  // 真事故：2026-10-17 重组 workflow 时，两个 build job 里那条没有 `- name:` 的
  // `- uses: actions/checkout@v4` 被整条丢掉 → 工作区为空 → setup-node 报
  // "The specified node version file … .nvmrc does not exist"，两个 job 3~4 秒失败。
  const jobs = parseJobs(wf);
  assert.ok(jobs.length >= 2, `解析到 ${jobs.length} 个 job`);
  for (const block of jobs) {
    const jobName = jobNameOf(block);
    const afterSteps = block.slice(block.indexOf('    steps:') + '    steps:'.length);
    const firstStep = afterSteps.split('\n').find((line) => line.trimStart().startsWith('- '));
    assert.match(
      String(firstStep ?? ''),
      /-\s*uses:\s*actions\/checkout@/,
      `${jobName} 的第一步不是 checkout（后面 setup-node 的 node-version-file 会直接失败）`,
    );
  }
});

test('release.yml：两个平台各自发布本平台资产（分开走，互不阻塞）', () => {
  const wf = fs.readFileSync(path.join('.github', 'workflows', 'release.yml'), 'utf8');
  const byName = new Map(parseJobs(wf).map((b) => [jobNameOf(b), b]));
  // 2026-10-17 决策：撤回"统一 publish job" —— 一个平台挂不该拖住另一个平台出货。
  // 代价是可能出现只含单平台的 release（v0.4.7 那种），补救 = Actions 一键 Re-run failed jobs。
  // 因此这里锁的是"各自独立"：每个 job 自己发、只发自己平台的文件、只认自己的 feed。
  assert.ok(!/\n {2}publish:\n/.test(wf), '不再有统一 publish job');
  assert.ok(!/download-artifact/.test(wf), '分开走：不该有跨平台 artifact 依赖');
  for (const [name, block] of byName) {
    const publishes = (block.match(/softprops\/action-gh-release/g) ?? []).length;
    assert.equal(publishes, 1, `${name} 应有且只有一个 Publish 步骤（实际 ${publishes}）`);
    assert.match(
      block,
      /if: startsWith\(github\.ref, 'refs\/tags\/'\)/,
      `${name} 的发布步骤只能在 tag 上触发（手动触发只出 artifact）`,
    );
  }
  // 各平台只发自己的文件：mac 带 DMG/ZIP/latest-mac.yml，win 带 exe/zip/latest.yml
  const mac = String(byName.get('build-macos-dmg'));
  const win = String(byName.get('build-windows'));
  assert.match(mac, /apps\/desktop\/release\/latest-mac\.yml/);
  assert.match(mac, /apps\/desktop\/release\/\*\.dmg/);
  assert.match(win, /apps\/desktop\/release\/latest\.yml/);
  assert.match(win, /apps\/desktop\/release\/\*\.exe/);
  // cask 只跟 mac（DMG 的 sha256 是它的输入）
  assert.match(mac, /Sync Homebrew cask/);
  assert.ok(!/Sync Homebrew cask/.test(win), 'cask 不该出现在 windows job');
});

test('CI：latest-mac.yml / latest.yml 必须跟着上传（差一个等于没更新）', () => {
  const wf = fs.readFileSync(path.join('.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(wf, /apps\/desktop\/release\/latest-mac\.yml/);
  assert.match(wf, /apps\/desktop\/release\/latest\.yml/);
  // artifact 与 Release 两处都要有：只挂 artifact 的话用户端拿不到 feed
  const macCount = wf.match(/latest-mac\.yml/g)?.length ?? 0;
  const winCount = wf.match(/latest\.yml/g)?.length ?? 0;
  assert.ok(macCount >= 2, `latest-mac.yml 出现 ${macCount} 次，artifact + Release 都要`);
  assert.ok(winCount >= 2, `latest.yml 出现 ${winCount} 次，artifact + Release 都要`);
});

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${(err as Error).message}`);
      failed++;
    }
  }
  console.log(`\ndesktop-update 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

void main();
