// 模块: 桌面端「检查更新 / 自更新」契约 —— 纯逻辑单测 + 壳侧与 CI 的源码契约。
// 用法: npx tsx tests/desktop-update.test.ts
//
// 流程在 flow.ts 中直接运行：检查/下载/安装/异步失败恢复使用可控服务与事件源；
// 版本/退避/任务状态跑纯函数。只有 Electron IPC 和发布打包配置保留接线契约。
//
// 背景：docs/plans/auto-update-调研报告.md §5（DSH 逆向结论 + 裁剪方案）。

import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync, type spawn as spawnType } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';
import { stopManagedBackend } from '../apps/desktop/src/backend-process';
import { createUpdateFlow, type UpdateFlowOptions } from '../apps/desktop/src/update/flow';
import {
  requiresManualMacInstall,
  waitForUpdateEvent,
  withTimeout,
} from '../apps/desktop/src/update/lifecycle';
import {
  compareVersions,
  describeUpdateFailure,
  isNetworkFailure,
  isNewerVersion,
  nextCheckDelay,
  parseVersion,
} from '../apps/desktop/src/update/policy';
import {
  availableStatus,
  clampPercent,
  downloadingStatus,
  IDLE_UPDATE_STATUS,
  isUpdateStatus,
  readyStatus,
  type UpdateStatus,
} from '../apps/desktop/src/update/status';
import { ACTIVE_RUN_STATUSES, activeTasks } from '../apps/desktop/src/update/tasks';
import {
  GuardedNsisUpdater,
  launchInstallerProcess,
} from '../apps/desktop/src/update/windows-installer';
import {
  planShortcutRepair,
  repairWindowsShortcut,
  sameWindowsPath,
  shouldRestoreMissingShortcut,
  startWindowsShortcutRepair,
  WINDOWS_APP_USER_MODEL_ID,
  windowsShortcutDetails,
} from '../apps/desktop/src/windows-shortcut';
import {
  reportWindowsUpdateReady,
  updateHandoffToken,
} from '../apps/desktop/src/windows-update-handoff';
import { isCancellable } from '../src/host/run-types';
import { normalizeUpdateStatus } from '../web/src/update-status';

const shellSource = (relative: string): string =>
  fs.readFileSync(path.join('apps', 'desktop', relative), 'utf8');

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待测试安装器调用超时');
    await new Promise(setImmediate);
  }
}

function updateFixture() {
  const states: UpdateStatus[] = [];
  const events: string[] = [];
  const questions: Parameters<UpdateFlowOptions['ask']>[0][] = [];
  const replies: number[] = [];
  const options: UpdateFlowOptions = {
    currentVersion: '0.4.13',
    enabled: () => true,
    backend: {
      listActiveTasks: async () => {
        events.push('tasks');
        return [];
      },
      stop: async () => {
        events.push('stop');
      },
      start: async () => {
        events.push('restore');
      },
    },
    source: {
      check: async () => {
        events.push('check');
        return '0.4.15';
      },
      download: async (progress) => {
        events.push('download');
        progress(42);
        return ['/tmp/update.zip'];
      },
      requiresManualInstall: async () => false,
      prepareInstall: async () => {
        events.push('prepare');
      },
      install: async () => {
        events.push('install');
      },
      openPackage: async (file) => {
        events.push(`open:${file}`);
      },
    },
    ask: async (question) => {
      questions.push(question);
      events.push('ask');
      return replies.shift() ?? 1;
    },
    say: async (_type, message) => {
      events.push(`say:${message}`);
    },
    status: (status) => {
      states.push(status);
    },
    progress: () => {},
    log: () => {},
  };
  return { options, flow: createUpdateFlow(options), states, events, questions, replies };
}

class FakeChild extends EventEmitter {
  pid = 501;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  unreferenced = false;
  killed = false;
  unref() {
    this.unreferenced = true;
    return this;
  }
  kill() {
    this.killed = true;
    return true;
  }
  exit(code: number) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

function windowsUpdaterFixture() {
  const exits = new EventEmitter();
  const calls: { command: string; args: string[] }[] = [];
  const launches: ReturnType<typeof deferred<void>>[] = [];
  const errors: Error[] = [];
  let quitCount = 0;
  let unlockCount = 0;
  class Probe extends GuardedNsisUpdater {
    override get installerPath() {
      return 'C:\\Users\\测试 用户\\Downloads\\setup.exe';
    }
    seed(admin = false) {
      this.downloadedUpdateHelper = {
        packageFile: null,
        downloadedFileInfo: { isAdminRightsRequired: admin },
      } as NonNullable<typeof this.downloadedUpdateHelper>;
    }
    protected override launchInstaller(command: string, args: string[]): Promise<void> {
      calls.push({ command, args });
      const gate = deferred<void>();
      launches.push(gate);
      return gate.promise;
    }
  }
  // AppAdapter 无 releaseSingleInstanceLock；真机走 ElectronAppAdapter.app，测试挂嵌套 app。
  const updater = new Probe(undefined, {
    version: '0.4.13',
    name: 'PayasoAgent',
    isPackaged: true,
    appUpdateConfigPath: '/tmp/app-update.yml',
    userDataPath: '/tmp',
    baseCachePath: '/tmp',
    whenReady: async () => {},
    relaunch: () => {},
    onQuit: () => {},
    quit: () => {
      quitCount++;
      exits.emit('will-quit');
    },
    app: {
      releaseSingleInstanceLock: () => {
        unlockCount++;
      },
    },
  } as ConstructorParameters<typeof GuardedNsisUpdater>[1]);
  updater.logger = null;
  updater.autoInstallOnAppQuit = false;
  updater.on('error', (error) => errors.push(error));
  updater.seed();
  return {
    updater,
    exits,
    calls,
    launches,
    errors,
    quitCount: () => quitCount,
    unlockCount: () => unlockCount,
  };
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
  // 真机现场（v0.4.10）：合盖唤醒瞬间 macOS 挂起网络 I/O，updater 报这个
  assert.equal(isNetworkFailure('net::ERR_NETWORK_IO_SUSPENDED'), true);
  assert.equal(isNetworkFailure('Error: sha512 mismatch'), false);
});

test('describeUpdateFailure：网络问题与安装失败分开说', () => {
  assert.match(describeUpdateFailure('check', 'net::ERR_TIMED_OUT'), /网络不可用/);
  assert.match(describeUpdateFailure('download', 'ECONNRESET'), /网络不可用/);
  assert.equal(describeUpdateFailure('check', 'sha512 mismatch'), '检查更新失败');
  assert.equal(describeUpdateFailure('install', 'EPERM'), '安装更新未完成，更新包已保留');
  assert.equal(isNetworkFailure('fetch failed'), true);
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

test('activeTasks：只挑在跑的，异常响应不能误判为没有任务', () => {
  const payload = {
    runs: [
      { runId: 'a', status: 'running', task: '写文档' },
      { runId: 'b', status: 'stopping', task: '改代码' },
      { runId: 'c', status: 'completed', task: '早跑完了' },
      { runId: 'd', status: 'failed', task: '挂了' },
    ],
  };
  assert.deepEqual(activeTasks(payload), [
    { runId: 'a', task: '写文档' },
    { runId: 'b', task: '改代码' },
  ]);
  assert.deepEqual(activeTasks({ runs: [] }), []);
  for (const invalid of [{ runs: 'nope' }, null, undefined, { runs: [{}] }]) {
    assert.throws(() => activeTasks(invalid), /状态响应异常/);
  }
});

// ── 壳侧接线契约（coordinator.ts / main.ts）───────────────────────────────

test('coordinator：不自动下载/退出不自动装/不降级，且挂了 error 监听', () => {
  const src = shellSource(path.join('src', 'update', 'coordinator.ts'));
  assert.match(src, /autoUpdater\.autoDownload = false/, '下载必须用户点');
  assert.match(src, /autoUpdater\.autoInstallOnAppQuit = false/, '退出时不许偷偷装');
  assert.match(src, /autoUpdater\.allowDowngrade = false/);
  assert.match(
    src,
    /autoUpdater\.disableDifferentialDownload = true/,
    '避免差分假 100% 再全量重下',
  );
  assert.match(src, /DOWNLOAD_ATTEMPTS/, '下载断线自动重试');
  assert.match(src, /isNetworkFailure\(message\)/, '只对网络失败重试');
  assert.match(src, /resetInstallAttempt/, '安装超时后须释放 NSIS 安装门闩');
  const main = shellSource(path.join('src', 'main.ts'));
  assert.match(main, /quitForUpdate/, '装更新时 before-quit 不得 preventDefault');
  assert.match(
    src,
    /autoUpdater\.on\('error'/,
    "未监听的 'error' 会让 EventEmitter 直接抛 —— 必须挂监听",
  );
  const flow = shellSource(path.join('src', 'update', 'flow.ts'));
  assert.match(flow, /isNewerVersion\(version, options\.currentVersion\)/, '版本门禁要真的用上');
});

test('coordinator：开发版门禁 = 打包 + app-update.yml 存在', () => {
  const src = shellSource(path.join('src', 'update', 'coordinator.ts'));
  assert.match(src, /return app\.isPackaged && existsSync\(appUpdateConfigPath\(\)\)/);
  assert.match(src, /path\.join\(process\.resourcesPath, 'app-update\.yml'\)/);
});

test('安装器异步失败：先恢复后端再报错，保留 ready，重试不重新下载', async () => {
  const f = updateFixture();
  const updater = new EventEmitter();
  const app = new EventEmitter();
  f.options.source.install = () =>
    waitForUpdateEvent({
      errors: updater,
      success: app,
      event: 'will-quit',
      timeoutMs: 1_000,
      timeoutMessage: 'timeout',
      trigger: () => {
        f.events.push('install');
        queueMicrotask(() => updater.emit('error', new Error('签名校验失败')));
      },
    });
  f.replies.push(0);
  await f.flow.check(false);
  await f.flow.downloadNow();
  assert.deepEqual(f.events.slice(2, 8), ['prepare', 'tasks', 'ask', 'stop', 'install', 'restore']);
  assert.match(f.events[8], /^say:/, '必须恢复后端后才显示错误');
  assert.deepEqual(f.states.at(-1), readyStatus('0.4.15'));
  await f.flow.check(false);
  f.options.source.install = async () => {
    f.events.push('installed');
  };
  f.replies.push(0);
  await f.flow.downloadNow();
  assert.equal(f.events.filter((e) => e === 'download').length, 1);
  assert.equal(f.events.filter((e) => e === 'check').length, 1, '后台检查不能覆盖已下载状态');
  assert.equal(f.events.at(-1), 'installed');
});

test('main.ts：后端桥接现成端点 —— GET /runs + 优雅关停，后端零改动', () => {
  const src = shellSource(path.join('src', 'main.ts'));
  assert.match(src, /fetch\(`\$\{BACKEND_URL\}\/runs`/);
  assert.match(src, /return activeTasks\(await res\.json\(\)\)/);
  assert.match(src, /await stopBackend\(\);\n\s+quitForUpdate = true/);
  assert.match(src, /if \(ownsBackend && !\(await backendResponds\(\)\)\) await startBackend\(\)/);
  assert.match(src, /label: '检查更新…'/, '菜单要有手动入口');
  assert.match(src, /updates = createUpdateCoordinator\(/, 'boot 里要真的建协调器');
  assert.match(src, /updates\.startAutoCheck\(\)/);
  // 已经停过后端 / 装更新交接时退出别再 preventDefault（否则会拖住 will-quit）
  assert.match(src, /if \(quitting \|\| backend === null \|\| quitForUpdate\) return;/);
});

test('coordinator：后台检查失败不弹窗 + 唤醒补查要推迟', () => {
  const src = shellSource(path.join('src', 'update', 'coordinator.ts'));
  // 真机事故（v0.4.10，用户截图）：合盖唤醒后的自动检查必失败
  // （net::ERR_NETWORK_IO_SUSPENDED），旧代码在 catch 里无条件 reportFailure →
  // 用户什么都没点，却弹「检查更新失败：网络不可用」。后台检查必须只记日志。
  // 唤醒瞬间网络 I/O 还挂着：必须推迟几秒再查，否则每次都撞同一个错
  assert.match(src, /const RESUME_CHECK_DELAY_MS = 5_000;/, '唤醒补查延迟常量');
  assert.match(src, /resumeTimer = setTimeout\(\(\) => \{/, '唤醒后走延迟定时器');
  assert.match(src, /if \(resumeTimer\) clearTimeout\(resumeTimer\)/, '重复唤醒只留一个待跑');
  assert.match(src, /flow\.dispose\(\)/);
});

// ── 下载进度可见：侧边栏条目（v0.4.11 真机反馈：下载期间界面零反馈）──────────

test('clampPercent / 状态构造函数：脏输入不炸，百分比夹紧', () => {
  assert.equal(clampPercent(45.6), 46);
  assert.equal(clampPercent(-10), 0);
  assert.equal(clampPercent(250), 100);
  assert.equal(clampPercent(Number.NaN), 0);
  assert.deepEqual(availableStatus('0.4.12'), {
    phase: 'available',
    version: '0.4.12',
    percent: 0,
  });
  assert.deepEqual(downloadingStatus('0.4.12', 150), {
    phase: 'downloading',
    version: '0.4.12',
    percent: 100,
  });
  assert.deepEqual(IDLE_UPDATE_STATUS, { phase: 'idle', version: '', percent: 0 });
});

test('isUpdateStatus：只认已定义阶段 + 字符串版本 + 数字百分比', () => {
  assert.equal(isUpdateStatus({ phase: 'available', version: '0.4.12', percent: 0 }), true);
  assert.equal(isUpdateStatus({ phase: 'downloading', version: '0.4.12', percent: 42 }), true);
  assert.equal(isUpdateStatus({ phase: 'idle', version: '', percent: 0 }), true);
  assert.equal(isUpdateStatus({ phase: 'nope', version: '1', percent: 0 }), false);
  assert.equal(isUpdateStatus({ phase: 'available', version: 1, percent: 0 }), false);
  assert.equal(isUpdateStatus(null), false);
  assert.equal(isUpdateStatus('x'), false);
});

test('页面侧状态归一：非法值退化成 idle，百分比夹紧', () => {
  assert.deepEqual(
    normalizeUpdateStatus({ phase: 'downloading', version: '0.4.12', percent: 250 }),
    {
      phase: 'downloading',
      version: '0.4.12',
      percent: 100,
    },
  );
  assert.deepEqual(normalizeUpdateStatus({ phase: 'available', version: '0.4.12' }), {
    phase: 'available',
    version: '0.4.12',
    percent: 0,
  });
  assert.equal(normalizeUpdateStatus({ phase: 'available', version: '' }).phase, 'idle');
  assert.equal(normalizeUpdateStatus(undefined).phase, 'idle');
  assert.equal(normalizeUpdateStatus({ phase: 'what', version: '1' }).phase, 'idle');
});

test('下载后点稍后：保留已下载入口，下次点击直接安装', async () => {
  const f = updateFixture();
  await f.flow.check(false);
  await f.flow.downloadNow();
  assert.deepEqual(f.states.at(-1), readyStatus('0.4.15'));
  assert.ok(f.states.some((s) => s.phase === 'downloading' && s.percent === 42));
  assert.ok(!f.events.includes('stop'));
  f.replies.push(0);
  await f.flow.downloadNow();
  assert.equal(f.events.filter((e) => e === 'download').length, 1);
  assert.equal(f.events.at(-1), 'install');
});

test('自动检查静默：有版本只显示条目，失败只退避，不下载也不弹窗', async () => {
  const f = updateFixture();
  await f.flow.check(false);
  assert.deepEqual(f.states.at(-1), availableStatus('0.4.15'));
  assert.deepEqual(f.events, ['check']);
  assert.equal(f.questions.length, 0);
  f.options.source.check = async () => {
    throw new Error('fetch failed');
  };
  await f.flow.check(false);
  assert.deepEqual(f.states.at(-1), availableStatus('0.4.15'));
  assert.equal(f.flow.failureCount(), 1);
  assert.ok(!f.events.some((e) => e.startsWith('say:')));
  await f.flow.check(true);
  assert.match(f.events.at(-1) ?? '', /检查更新失败：网络不可用/);
});

test('壳 ↔ 页面：ipc 通道与 preload 桥对齐（改名即断）', () => {
  const mainSrc = shellSource(path.join('src', 'main.ts'));
  const preload = shellSource(path.join('src', 'preload.cts'));
  assert.match(mainSrc, /win\.webContents\.send\('payaso:updateStatus', status\)/);
  assert.match(
    mainSrc,
    /win\.webContents\.send\('payaso:updateStatus', lastUpdateStatus\)/,
    '页面刷新后要补发状态',
  );
  assert.match(mainSrc, /ipcMain\.on\('payaso:updateDownload'/, '页面点下载的入口');
  assert.match(mainSrc, /ipcMain\.handle\('payaso:getAppVersion'/, '页面读当前版本');
  assert.match(mainSrc, /onStatus: pushUpdateStatus/);
  assert.match(preload, /ipcRenderer\.on\(channel, handler\)/);
  assert.match(preload, /ipcRenderer\.send\('payaso:updateDownload'\)/);
  assert.match(preload, /ipcRenderer\.invoke\('payaso:getAppVersion'\)/);
  assert.match(preload, /channel = 'payaso:updateStatus'/);
  assert.match(preload, /ipcRenderer\.send\('payaso:updateStatusRequest'\)/);
  assert.match(mainSrc, /ipcMain\.on\('payaso:updateStatusRequest'/);
});

test('页面：侧边栏条目 + i18n 都在（浏览器里没有桥 → 不显示）', () => {
  const row = fs.readFileSync(
    path.join('web', 'src', 'components', 'UpdateStatus', 'index.tsx'),
    'utf8',
  );
  assert.match(row, /t\('shell\.update\.available'\)/, '有新版本时显示「新版本」');
  assert.match(row, /`\$\{status\.percent\}%`/, '下载中按百分比显示');
  assert.match(
    row,
    /shell\.update\.availableHint', \{ version: status\.version \}/,
    'tooltip 带版本号',
  );
  assert.match(row, /readAppVersion/, 'idle 时展示当前壳版本');
  assert.match(row, /v\{appVersion\}/, '格式为 v0.4.x');
  const sidebar = fs.readFileSync(
    path.join('web', 'src', 'components', 'Sidebar', 'index.tsx'),
    'utf8',
  );
  assert.match(sidebar, /<UpdateStatusRow \/>/, '条目要挂在侧边栏（设置旁边）');
  const messages = fs.readFileSync(path.join('web', 'src', 'i18n', 'messages', 'shell.ts'), 'utf8');
  for (const key of [
    'shell.update.currentVersionHint',
    'shell.update.available',
    'shell.update.availableHint',
    'shell.update.downloadingHint',
  ]) {
    assert.ok(messages.includes(key), `缺 i18n key: ${key}`);
  }
});

// ── 打包与 CI 契约（feed 没了 = 永远查不到更新）──────────────────────────

test('Windows 快捷方式：更新后目标被改到临时路径时要重写，平时缺失不补建', () => {
  const exe = 'C:\\Users\\小六\\AppData\\Local\\Programs\\@payasodesktop\\PayasoAgent.exe';
  const temp = 'C:\\Users\\小六\\AppData\\Local\\Temp\\nsis\\old-install\\PayasoAgent.exe';
  assert.equal(sameWindowsPath(exe, exe.toLowerCase()), true);
  assert.equal(
    planShortcutRepair({
      existing: { target: temp, icon: temp, cwd: path.win32.dirname(temp) },
      execPath: exe,
      appUserModelId: 'com.payaso.agent',
      restoreIfMissing: false,
    }).action,
    'write',
  );
  assert.equal(
    planShortcutRepair({
      existing: null,
      execPath: exe,
      appUserModelId: 'com.payaso.agent',
      restoreIfMissing: false,
    }).action,
    'skip',
  );
  assert.deepEqual(
    planShortcutRepair({
      existing: null,
      execPath: exe,
      appUserModelId: 'com.payaso.agent',
      restoreIfMissing: true,
    }),
    { action: 'write', reason: 'missing' },
  );
  assert.equal(
    planShortcutRepair({
      existing: { target: exe, icon: exe, iconIndex: 0, cwd: path.win32.dirname(exe) },
      execPath: exe,
      appUserModelId: 'com.payaso.agent',
      restoreIfMissing: true,
    }).action,
    'skip',
  );
  assert.equal(
    planShortcutRepair({
      existing: { target: exe, icon: temp },
      execPath: exe,
      appUserModelId: 'com.payaso.agent',
      restoreIfMissing: false,
    }).action,
    'write',
  );
  const details = windowsShortcutDetails(exe, 'com.payaso.agent', 'PayasoAgent');
  assert.equal(details.target, exe);
  assert.equal(details.icon, exe);
  assert.equal(details.iconIndex, 0);
  assert.equal(details.cwd, path.win32.dirname(exe));
  assert.equal(
    shouldRestoreMissingShortcut({
      argv: ['PayasoAgent.exe', '--updated'],
      seenVersion: '0.4.17',
      currentVersion: '0.4.17',
    }),
    true,
  );
  assert.equal(
    shouldRestoreMissingShortcut({
      argv: ['PayasoAgent.exe'],
      seenVersion: null,
      currentVersion: '0.4.18',
    }),
    true,
  );
  assert.equal(
    shouldRestoreMissingShortcut({
      argv: ['PayasoAgent.exe'],
      seenVersion: '0.4.18',
      currentVersion: '0.4.18',
    }),
    false,
  );
});

function shortcutFixture() {
  const exe = 'C:\\Program Files\\PayasoAgent\\PayasoAgent.exe';
  const details = windowsShortcutDetails(exe, 'com.payaso.agent', 'PayasoAgent');
  let link: Parameters<typeof planShortcutRepair>[0]['existing'] = { ...details };
  const logs: string[] = [];
  let writes = 0;
  const options: Parameters<typeof repairWindowsShortcut>[0] = {
    file: 'C:\\Users\\测试\\Desktop\\PayasoAgent.lnk',
    details,
    restoreIfMissing: true,
    refreshExisting: false,
    read: () => link,
    write: (_file, value) => {
      writes++;
      link = { ...value };
      return true;
    },
    log: (message) => logs.push(message),
  };
  return {
    options,
    logs,
    writes: () => writes,
    corrupt: () => {
      link = { target: 'C:\\Temp\\old-install\\PayasoAgent.exe' };
    },
    remove: () => {
      link = null;
    },
  };
}

test('快捷方式：写入返回成功但读回仍旧目标，必须判失败并记录诊断', () => {
  const f = shortcutFixture();
  f.corrupt();
  f.options.write = () => true;
  assert.equal(repairWindowsShortcut(f.options), false);
  assert.match(f.logs[0], /actual=C:\\Temp\\old-install/);
  assert.ok(f.logs[0].includes(`expected=${f.options.details.target}`));
});

test('快捷方式：更新首次刷新正确路径，普通检查不反复重写', () => {
  const f = shortcutFixture();
  assert.equal(repairWindowsShortcut(f.options), true);
  assert.equal(f.writes(), 0);
  f.options.refreshExisting = true;
  assert.equal(repairWindowsShortcut(f.options), true);
  assert.equal(f.writes(), 1);
  f.options.refreshExisting = false;
  f.remove();
  f.options.restoreIfMissing = false;
  assert.equal(repairWindowsShortcut(f.options), true);
  assert.equal(f.writes(), 1, '普通启动不恢复用户主动删除的图标');
});

test('快捷方式：写入失败或读取异常不冒泡，也不能报告修复完成', () => {
  const f = shortcutFixture();
  f.corrupt();
  f.options.write = () => false;
  assert.equal(repairWindowsShortcut(f.options), false);
  f.options.read = () => {
    throw new Error('Access denied');
  };
  assert.equal(repairWindowsShortcut(f.options), false);
  assert.match(f.logs.at(-1) ?? '', /Access denied/);
});

function shortcutRetryFixture(afterUpdate = true) {
  const f = shortcutFixture();
  const pending: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  let remembered = 0;
  const cancel = startWindowsShortcutRepair({
    afterUpdate,
    repair: (restoreIfMissing, refreshExisting) =>
      repairWindowsShortcut({ ...f.options, restoreIfMissing, refreshExisting }),
    remember: () => {
      remembered++;
    },
    log: (message) => f.logs.push(message),
    schedule: (callback, delay) => {
      const item = { callback, delay, cancelled: false };
      pending.push(item);
      return () => {
        item.cancelled = true;
      };
    },
  });
  return { ...f, pending, cancel, remembered: () => remembered };
}

test('快捷方式：3 秒核验后再次变坏，10/30 秒仍修复并仅在末次成功记版本', () => {
  const f = shortcutRetryFixture();
  assert.deepEqual(
    f.pending.map((item) => item.delay),
    [3000, 10000, 30000],
  );
  f.pending[0].callback();
  assert.equal(f.remembered(), 0);
  f.corrupt();
  f.pending[1].callback();
  assert.equal(f.writes(), 2);
  f.corrupt();
  f.pending[2].callback();
  assert.equal(f.writes(), 3);
  assert.equal(f.remembered(), 1);
});

test('快捷方式：末次失败不记版本，退出取消复查，普通启动不创建定时器', () => {
  const f = shortcutRetryFixture();
  f.corrupt();
  f.options.write = () => false;
  f.pending[2].callback();
  assert.equal(f.remembered(), 0);
  assert.match(f.logs.at(-1) ?? '', /final verification failed/);
  f.cancel();
  assert.ok(f.pending.every((item) => item.cancelled));
  const before = f.writes();
  for (const item of f.pending) item.callback();
  assert.equal(f.writes(), before);
  assert.equal(f.remembered(), 0);
  assert.equal(shortcutRetryFixture(false).pending.length, 0);
});

test('更新就绪回执：只接受本轮格式正确的 token，包含版本、EXE 和 PID', async () => {
  const token = 'a'.repeat(32);
  assert.equal(updateHandoffToken([`--payaso-update-token=${token}`]), token);
  assert.equal(updateHandoffToken(['--payaso-update-token=../other']), null);
  await assert.rejects(
    reportWindowsUpdateReady({ token: 'bad', version: '0.4.23', exe: 'x', pid: 1 }),
    /Invalid/,
  );
  const events = new EventEmitter();
  let payload = '';
  const fake = Object.assign(events, {
    setTimeout: () => fake,
    end: (data: string, done: () => void) => {
      payload = data;
      done();
    },
    destroy: (error: Error) => {
      events.emit('error', error);
    },
  });
  const ready = reportWindowsUpdateReady({
    token,
    version: '0.4.23',
    exe: 'C:\\Programs\\PayasoAgent.exe',
    pid: 123,
    connect: ((pipe: string) => {
      assert.equal(pipe, `\\\\.\\pipe\\PayasoAgent-update-${token}`);
      return fake as unknown as Socket;
    }) as typeof import('node:net').createConnection,
  });
  events.emit('connect');
  await ready;
  assert.deepEqual(JSON.parse(payload), {
    token,
    version: '0.4.23',
    exe: 'C:\\Programs\\PayasoAgent.exe',
    pid: 123,
  });
});

test('Windows 安装器：旧卸载前分离链接，直接创建新进程并等待就绪', () => {
  const yml = shellSource('electron-builder.yml');
  assert.match(yml, /include:\s*build\/installer\.nsh/);
  assert.match(yml, /to: PayasoUpdate\.exe/);
  const result = spawnSync(
    process.execPath,
    ['apps/desktop/scripts/package-windows.mjs', '--check'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const nsh = shellSource(path.join('build', 'installer.nsh'));
  assert.match(nsh, /!macro payasoPrepareUpdate/);
  assert.match(nsh, /ExecWait.* prepare /);
  assert.match(nsh, /ExecWait.* finish /);
  assert.match(nsh, /ExecWait.* launch /);
  assert.ok(!nsh.includes('ExecShellAsUser'), '自动重启不得通过 Shell 解析快捷方式');
  const main = shellSource(path.join('src', 'main.ts'));
  assert.match(main, /setAppUserModelId\(WINDOWS_APP_USER_MODEL_ID\)/);
  assert.match(main, /reportWindowsUpdateReady/);
  assert.match(main, /repairInstalledWindowsShortcuts/);
  assert.ok(!main.includes('writeShortcutLink'), '程序兜底不能覆盖禁跟踪标志');
  if (process.platform === 'win32') {
    const native = spawnSync(process.execPath, ['tests/windows-update-native.mjs'], {
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(native.status, 0, native.stdout + native.stderr);
    console.log(native.stdout);
  }
});

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

test('Mac 临时签名：保留 ready 并打开更新包，全程不停止后端', async () => {
  const f = updateFixture();
  f.options.source.requiresManualInstall = async () => true;
  await f.flow.check(false);
  await f.flow.downloadNow();
  assert.deepEqual(f.states.at(-1), readyStatus('0.4.15', true));
  f.replies.push(0);
  await f.flow.downloadNow();
  assert.equal(f.events.at(-1), 'open:/tmp/update.zip');
  assert.ok(!f.events.some((e) => ['tasks', 'prepare', 'stop', 'install'].includes(e)));
  assert.equal(f.events.filter((e) => e === 'download').length, 1);
});

test('Mac 原生暂存失败 / 本地任务查询失败：都不能停止后端', async () => {
  for (const stage of ['prepareInstall', 'listActiveTasks'] as const) {
    const f = updateFixture();
    if (stage === 'prepareInstall')
      f.options.source.prepareInstall = async () => {
        throw new Error('签名校验失败');
      };
    else
      f.options.backend.listActiveTasks = async () => {
        throw new Error('fetch failed');
      };
    await f.flow.check(false);
    await f.flow.downloadNow();
    assert.ok(!f.events.includes('stop'));
    assert.deepEqual(f.states.at(-1), readyStatus('0.4.15'));
    assert.match(f.events.at(-1) ?? '', /更新包已保留/);
  }
});

test('手动检查加入后台检查：单次请求完成后仍显示结果', async () => {
  const f = updateFixture();
  const gate = deferred<string>();
  f.options.source.check = () => {
    f.events.push('check');
    return gate.promise;
  };
  const background = f.flow.check(false);
  const manual = f.flow.check(true);
  await Promise.resolve();
  gate.resolve('0.4.15');
  await Promise.all([background, manual]);
  assert.deepEqual(f.events, ['check', 'ask']);
  assert.equal(f.questions.length, 1);
  assert.match(f.questions[0].message, /0.4.15/);
  assert.ok(f.states.some((s) => s.phase === 'checking'));
});

test('版本相同或更旧：不下载，手动检查明确提示最新版', async () => {
  for (const version of ['0.4.13', '0.4.12', '']) {
    const f = updateFixture();
    f.options.source.check = async () => version;
    await f.flow.check(true);
    assert.match(f.events.at(-1) ?? '', /已是最新版 0.4.13/);
    assert.deepEqual(f.states.at(-1), IDLE_UPDATE_STATUS);
  }
});

test('后台检查与点击下载交错：等待检查完成后下载正确版本', async () => {
  const f = updateFixture();
  await f.flow.check(false);
  const gate = deferred<string>();
  f.options.source.check = () => gate.promise;
  const checking = f.flow.check(false);
  const action = f.flow.downloadNow();
  await Promise.resolve();
  assert.ok(!f.events.includes('download'));
  gate.resolve('0.4.16');
  await Promise.all([checking, action]);
  assert.deepEqual(f.states.at(-1), readyStatus('0.4.16'));
});

test('重复点击：下载、安装确认、交接都只执行一次', async () => {
  const f = updateFixture();
  const gate = deferred<string[]>();
  f.options.source.download = async () => {
    f.events.push('download');
    return gate.promise;
  };
  f.replies.push(0);
  await f.flow.check(false);
  const first = f.flow.downloadNow();
  const second = f.flow.downloadNow();
  await Promise.resolve();
  gate.resolve(['/tmp/update.zip']);
  await Promise.all([first, second]);
  assert.equal(f.events.filter((e) => e === 'download').length, 1);
  assert.equal(f.questions.length, 1);
  assert.equal(f.events.filter((e) => e === 'install').length, 1);
});

test('下载失败后仍可重试，运行中的任务会明确提示', async () => {
  const f = updateFixture();
  f.options.source.download = async () => {
    throw new Error('ECONNRESET');
  };
  await f.flow.check(false);
  await f.flow.downloadNow();
  assert.deepEqual(f.states.at(-1), availableStatus('0.4.15'));
  f.options.source.download = async () => ['/tmp/update.zip'];
  f.options.backend.listActiveTasks = async () => [{ runId: 'a', task: '生成方案' }];
  await f.flow.downloadNow();
  assert.equal(f.questions.at(-1)?.type, 'warning');
  assert.match(f.questions.at(-1)?.detail ?? '', /生成方案/);
  assert.ok(!f.events.includes('stop'));
});

test('安装交接：同步抛错、异步报错、超时都会拒绝，真正退出才成功', async () => {
  for (const mode of ['throw', 'error', 'timeout', 'exit'] as const) {
    const updater = new EventEmitter();
    const app = new EventEmitter();
    const operation = waitForUpdateEvent({
      errors: updater,
      success: app,
      event: 'will-quit',
      timeoutMs: 5,
      timeoutMessage: '没有退出',
      trigger: () => {
        if (mode === 'throw') throw new Error('sync');
        if (mode === 'error') queueMicrotask(() => updater.emit('error', new Error('async')));
        if (mode === 'exit') queueMicrotask(() => app.emit('will-quit'));
      },
    });
    if (mode === 'exit') await operation;
    else
      await Promise.all([
        assert.rejects(operation, mode === 'timeout' ? /没有退出/ : /sync/),
        new Promise((resolve) => setTimeout(resolve, 10)),
      ]);
    assert.equal(updater.listenerCount('error'), 0);
    assert.equal(app.listenerCount('will-quit'), 0);
  }
});

test('任务查询超时会拒绝，签名检测拒绝 ad-hoc 和未知身份', async () => {
  await Promise.all([
    assert.rejects(withTimeout(new Promise(() => {}), 5, '任务查询超时'), /任务查询超时/),
    new Promise((resolve) => setTimeout(resolve, 10)),
  ]);
  assert.equal(requiresManualMacInstall('Signature=adhoc'), true);
  assert.equal(requiresManualMacInstall(''), true);
  assert.equal(
    requiresManualMacInstall('Authority=Developer ID Application: Test\nTeamIdentifier=ABC'),
    false,
  );
});

test('新增更新状态：壳与页面保留 ready / 安装中 / 检查中', () => {
  for (const status of [
    readyStatus('0.4.15', true),
    readyStatus('0.4.15'),
    { phase: 'checking', version: '', percent: 0 },
    { phase: 'installing', version: '0.4.15', percent: 0 },
  ]) {
    assert.equal(isUpdateStatus(status), true);
    assert.deepEqual(normalizeUpdateStatus(status), status);
  }
});

test('Windows 真实 NSIS 接线：启动未确认前不退出，失败后可恢复并重试', async () => {
  const win = windowsUpdaterFixture();
  const f = updateFixture();
  f.options.source.install = () =>
    waitForUpdateEvent({
      errors: win.updater,
      success: win.exits,
      event: 'will-quit',
      timeoutMs: 1_000,
      timeoutMessage: 'timeout',
      trigger: () => win.updater.quitAndInstall(true, true),
    });
  f.replies.push(0);
  await f.flow.check(false);
  const first = f.flow.downloadNow();
  await waitUntil(() => win.launches.length > 0);
  assert.equal(win.quitCount(), 0, '尚未确认启动不能退出');
  win.launches[0].reject(Object.assign(new Error('被拦截'), { code: 'EPERM' }));
  await first;
  assert.equal(win.quitCount(), 0);
  assert.ok(f.events.includes('restore'));
  assert.equal(f.states.at(-1)?.phase, 'ready');
  f.replies.push(0);
  const retry = f.flow.downloadNow();
  await waitUntil(() => win.launches.length >= 2);
  win.launches[1].resolve();
  await retry;
  assert.equal(win.quitCount(), 1);
  assert.equal(win.unlockCount(), 1, '退出前须放开单实例锁，否则 --force-run 新进程会被顶回旧窗口');
  assert.deepEqual(win.calls[0].args, ['--updated', '/S', '--force-run']);
  assert.ok(win.calls[0].command.includes('测试 用户'), '中文和空格路径不能被 shell 重新解析');
});

test('Windows NSIS：安装超时后 resetInstallAttempt，再次点击才能真正重试', () => {
  const win = windowsUpdaterFixture();
  win.updater.quitAndInstall(true, true);
  assert.equal(win.launches.length, 1);
  // 模拟交接超时：不 resolve launch，直接复位（与 coordinator catch 路径一致）
  win.updater.resetInstallAttempt();
  win.updater.quitAndInstall(true, true);
  assert.equal(win.launches.length, 2, '复位后必须能再次发起安装');
});

test('Windows 缺失安装器：立即报错，保持客户端，不进入无反馈的 openPath 回退', async () => {
  const f = windowsUpdaterFixture();
  f.updater.quitAndInstall(true, true);
  f.launches[0].reject(Object.assign(new Error('not found'), { code: 'ENOENT' }));
  await new Promise(setImmediate);
  assert.equal(f.quitCount(), 0);
  assert.match(f.errors[0].message, /安装器不存在/);
  f.updater.quitAndInstall(true, true);
  assert.equal(f.launches.length, 2, '失败后必须释放安装许可供重试');
  f.launches[1].resolve();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(f.quitCount(), 1);
});

test('Windows NSIS 权限回退：等待提权成功，取消授权不退出；保留原安装目录参数', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', {
    value: 'C:\\PayasoAgent\\resources',
    configurable: true,
  });
  try {
    const f = windowsUpdaterFixture();
    f.updater.installDirectory = 'C:\\Program Files\\测试目录';
    f.updater.quitAndInstall(true, true);
    f.launches[0].reject(Object.assign(new Error('permission'), { code: 'EACCES' }));
    await new Promise(setImmediate);
    assert.equal(f.launches.length, 2);
    assert.match(f.calls[1].command, /elevate\.exe$/);
    assert.equal(f.quitCount(), 0);
    assert.deepEqual(f.calls[1].args, [
      f.calls[0].command,
      '--updated',
      '/S',
      '--force-run',
      '/D=C:\\Program Files\\测试目录',
    ]);
    f.launches[1].reject(new Error('用户取消管理员授权'));
    await new Promise(setImmediate);
    assert.equal(f.quitCount(), 0);
    assert.match(f.errors[0].message, /取消/);
  } finally {
    if (original) Object.defineProperty(process, 'resourcesPath', original);
    else Reflect.deleteProperty(process, 'resourcesPath');
  }
});

test('Windows 进程启动确认：有 PID 仍须等待 spawn；提权须等待帮助器成功退出', async () => {
  for (const elevated of [false, true]) {
    const child = new FakeChild();
    let confirmed = false;
    const operation = launchInstallerProcess(
      elevated ? 'C:\\app\\elevate.exe' : 'C:\\测试 用户\\setup.exe',
      [],
      {
        spawnProcess: (() => child as unknown as ChildProcess) as typeof spawnType,
      },
    ).then(() => {
      confirmed = true;
    });
    await Promise.resolve();
    assert.equal(confirmed, false);
    child.emit('spawn');
    await Promise.resolve();
    if (elevated) {
      assert.equal(confirmed, false);
      child.exit(0);
    }
    await operation;
    assert.equal(confirmed, true);
    assert.equal(child.unreferenced, true);
  }
});

test('Windows 启动失败 / UAC 取消 / 无响应：都拒绝交接', async () => {
  for (const mode of ['error', 'uac', 'timeout'] as const) {
    const child = new FakeChild();
    const operation = launchInstallerProcess(mode === 'uac' ? 'elevate.exe' : 'setup.exe', [], {
      timeoutMs: 5,
      spawnProcess: (() => child as unknown as ChildProcess) as typeof spawnType,
    });
    const check = assert.rejects(operation);
    if (mode === 'error') child.emit('error', new Error('spawn failed'));
    if (mode === 'uac') {
      child.emit('spawn');
      child.exit(1);
    }
    await Promise.all([check, new Promise((resolve) => setTimeout(resolve, 10))]);
    if (mode === 'timeout') assert.equal(child.killed, true);
  }
});

test('Windows 关停失败：保留活进程，可用原对象重试关停；监听器均被清理', async () => {
  const child = new FakeChild();
  await Promise.all([
    assert.rejects(
      stopManagedBackend(child as unknown as ChildProcess, {
        platform: 'win32',
        killGraceMs: 5,
        killTree: async () => {
          throw new Error('Access denied');
        },
      }),
      /保留当前进程/,
    ),
    new Promise((resolve) => setTimeout(resolve, 10)),
  ]);
  assert.equal(child.exitCode, null);
  assert.equal(child.listenerCount('exit'), 0);
  await stopManagedBackend(child as unknown as ChildProcess, {
    platform: 'win32',
    killTree: async (pid) => {
      assert.equal(pid, child.pid);
      child.exit(0);
    },
  });
  assert.equal(child.listenerCount('exit'), 0);
});

test('Windows taskkill 报错但进程已自行退出：允许继续安装', async () => {
  const child = new FakeChild();
  await stopManagedBackend(child as unknown as ChildProcess, {
    platform: 'win32',
    killTree: async () => {
      child.exit(0);
      throw new Error('PID not found');
    },
  });
  assert.equal(child.exitCode, 0);
});

test('后端拒绝关停：不启动安装器，保留已下载入口', async () => {
  const f = updateFixture();
  f.options.backend.stop = async () => {
    throw new Error('taskkill failed');
  };
  f.replies.push(0);
  await f.flow.check(false);
  await f.flow.downloadNow();
  assert.ok(!f.events.includes('install'));
  assert.deepEqual(f.states.at(-1), readyStatus('0.4.15'));
});

// 只在真正的 Windows runner 执行，不把 mac 上的 mock 当成 Windows 实测。
if (process.platform === 'win32') {
  test('Windows OS：真实创建进程成功、缺失的 exe 必须拒绝', async () => {
    await launchInstallerProcess(process.execPath, ['-e', 'process.exit(0)']);
    await assert.rejects(launchInstallerProcess(`${process.execPath}.payaso-missing.exe`, []));
  });

  test('Windows OS：真实 taskkill /T 关停测试后端及其子进程', async () => {
    const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let leafPid = 0;
    try {
      leafPid = await withTimeout(
        new Promise<number>((resolve, reject) => {
          let output = '';
          child.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes('\n')) resolve(Number(output.split('\n')[0].trim()));
          });
          child.once('error', reject);
        }),
        5_000,
        '测试后端未启动',
      );
      assert.ok(Number.isInteger(leafPid) && leafPid > 0);
      await stopManagedBackend(child);
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      const deadline = Date.now() + 1_000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(leafPid, 0);
        } catch {
          alive = false;
        }
        if (alive) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(alive, false, '不能遗留测试后端的子进程');
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        await stopManagedBackend(child).catch(() => child.kill());
      if (leafPid > 0) {
        try {
          process.kill(leafPid);
        } catch {}
      }
    }
  });
}

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
