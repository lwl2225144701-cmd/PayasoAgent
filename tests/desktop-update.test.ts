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
