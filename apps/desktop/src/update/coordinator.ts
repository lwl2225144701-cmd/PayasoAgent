// 模块: 桌面壳的「检查更新 / 自更新」协调器（electron 侧）。
//
// 照 DSH `DesktopUpdateCoordinator` 裁剪（docs/plans/auto-update-调研报告.md §5.2）：
// 保留 autoDownload=false / autoInstallOnAppQuit=false / 版本门禁 / 单飞 / 状态与
// 对话框；**删掉**自定义 httpExecutor、遥测 journal、独立更新对话框窗口 —— 原生
// 对话框够用，少一个 renderer 入口就少一份攻击面。
//
// 三条不变式（都是 DSH 真机踩出来的，别省）：
//   1. 下载与安装都必须用户显式点过 —— 绝不后台偷偷装；
//   2. 安装前必须确认没有在跑的任务，并把后端**优雅**停掉；停了却没装成要回滚；
//   3. 开发版（未打包 / 没有 app-update.yml）一律不检查，免得改完源码就弹更新。

import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, type BrowserWindow, dialog, powerMonitor } from 'electron';
import electronUpdater from 'electron-updater';
import {
  describeUpdateFailure,
  isNewerVersion,
  nextCheckDelay,
  type UpdateOperation,
} from './policy.js';
import {
  availableStatus,
  clampPercent,
  downloadingStatus,
  IDLE_UPDATE_STATUS,
  type UpdateStatus,
} from './status.js';

const { autoUpdater } = electronUpdater;

/** 默认节奏（DSH 同款）：10 分钟一轮，失败退避上限 6 小时，±20% 抖动。 */
const BASE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const MAX_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_JITTER_RATIO = 0.2;
/** 启动后首次检查延迟：别跟后端启动、首屏加载抢资源。 */
const FIRST_CHECK_DELAY_MS = 20 * 1000;
/**
 * 唤醒后补查的延迟。真机证据（v0.4.10）：合盖唤醒瞬间 macOS 的网络 I/O 还挂着，
 * electron-updater 直接报 `net::ERR_NETWORK_IO_SUSPENDED` —— 立刻查必失败，
 * 等几秒让网络回来再查才有意义。
 */
const RESUME_CHECK_DELAY_MS = 5_000;
/** 查"有没有在跑的任务"的超时（DSH 同款 10s）：查不出来就放弃本次安装。 */
const TASKS_TIMEOUT_MS = 10_000;
export interface UpdateBackendBridge {
  /** 查在跑任务：`GET /runs` 过滤 running/stopping。抛错 = 查不到。 */
  listActiveTasks: () => Promise<{ runId: string; task: string }[]>;
  /** 优雅关停后端（现成的分级关停：SIGTERM→SIGKILL / Windows taskkill /T）。 */
  stop: () => Promise<void>;
  /** 回滚用：安装失败后重新拉起后端，别把用户晾在没有后端的壳里。 */
  start: () => Promise<void>;
}

export interface UpdateCoordinatorOptions {
  /** 当前版本（`app.getVersion()`，CI 已把 tag 版本同步进 package.json）。 */
  currentVersion: string;
  /** 主窗口（对话框归属、任务栏进度）；窗口没了返回 null。 */
  window: () => BrowserWindow | null;
  /** 后端交互（查任务 / 停 / 回滚起）。 */
  backend: UpdateBackendBridge;
  /** 日志出口（默认 console；壳接到 stderr）。 */
  log?: (message: string) => void;
  /**
   * 状态出口：壳把「有新版本 / 下载中 x%」推给页面（侧边栏「设置」上方的条目）。
   * 页面入口见 web/src/update-status.ts，壳侧 relay 见 main.ts。
   */
  onStatus?: (status: UpdateStatus) => void;
}

export interface UpdateCoordinator {
  /** 菜单入口：检查 → 有新版问下载 → 下载完问安装重启。全程有反馈。 */
  checkInteractively: () => Promise<void>;
  /**
   * 页面入口（侧边栏「新版本」条目点了）：下载最近一次检查发现的新版本。
   * 没有待装版本 / 正在下载时是空操作。
   */
  downloadNow: () => Promise<void>;
  /** 启动自动检查 + 定时轮询 + 窗口 focus / 睡眠唤醒补查（幂等）。 */
  startAutoCheck: () => void;
  dispose: () => void;
}

/** app-update.yml 的路径（打包时由 electron-builder 按 publish 配置写进 Resources）。 */
export function appUpdateConfigPath(): string {
  return path.join(process.resourcesPath, 'app-update.yml');
}

/**
 * 开发版门禁：没打包、或没生成 feed 配置，就不启用自更新。
 * 打包后 `app-update.yml` 由 electron-builder 写入；缺它 = 打包配置漏了 publish。
 */
export function updatesEnabled(): boolean {
  return app.isPackaged && existsSync(appUpdateConfigPath());
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUpdateCoordinator(options: UpdateCoordinatorOptions): UpdateCoordinator {
  const log = options.log ?? ((message: string) => console.log(`[updates] ${message}`));
  let timer: NodeJS.Timeout | null = null;
  let firstTimer: NodeJS.Timeout | null = null;
  let resumeTimer: NodeJS.Timeout | null = null;
  let failures = 0;
  let disposed = false;
  /** 单飞：检查只允许一条在飞，重复调用 join 同一条（DSH 同款）。 */
  let checking: Promise<void> | null = null;
  let downloading = false;
  let resumeHandler: (() => void) | null = null;
  let focusHandler: (() => void) | null = null;
  /** 最近一次检查发现的新版本（页面「下载」用；下载完成或已是最新时清空）。 */
  let pendingVersion: string | null = null;

  /** 还活着的窗口（对话框有 owner 才不会跑到窗口后面去）。 */
  function parent(): BrowserWindow | undefined {
    const win = options.window();
    return win && !win.isDestroyed() ? win : undefined;
  }

  async function say(
    type: 'info' | 'warning' | 'error',
    message: string,
    detail?: string,
  ): Promise<void> {
    const win = parent();
    const box = {
      type,
      title: 'PayasoAgent',
      message,
      ...(detail ? { detail } : {}),
      buttons: ['好'],
    };
    if (win) await dialog.showMessageBox(win, box);
    else await dialog.showMessageBox(box);
  }

  async function ask(box: Electron.MessageBoxOptions): Promise<number> {
    const win = parent();
    const result = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box);
    return result.response;
  }

  async function reportFailure(operation: UpdateOperation, error: unknown): Promise<void> {
    const raw = errorText(error);
    log(`${operation} failed: ${raw}`);
    await say('error', describeUpdateFailure(operation, raw), raw.slice(0, 800));
  }

  /** 把状态推给页面（壳侧 relay 见 main.ts）。上报失败不影响更新流程。 */
  function emitStatus(status: UpdateStatus): void {
    try {
      options.onStatus?.(status);
    } catch (error) {
      log(`emit status failed: ${errorText(error)}`);
    }
  }

  /** Dock / 任务栏进度条（页面条目之外的补充；负值 = 清掉）。 */
  function setDockProgress(percent: number): void {
    parent()?.setProgressBar(percent < 0 ? -1 : clampPercent(percent) / 100);
  }

  /**
   * 安装前交接（调研 §1.4 的裁剪版）：查任务 → 确认 → 优雅停后端 → quitAndInstall。
   * 任何一步失败都不装；停成功了才算拿到安装许可。
   */
  async function installAndRestart(version: string): Promise<void> {
    let tasks: { runId: string; task: string }[];
    try {
      tasks = await Promise.race([
        options.backend.listActiveTasks(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('查询在跑任务超时')), TASKS_TIMEOUT_MS),
        ),
      ]);
    } catch (error) {
      // 查不到就不装（DSH 同款 tasks-unavailable）：宁可不更新，也别打断用户任务。
      await say(
        'error',
        '暂时无法确认是否有任务在运行，已取消本次安装',
        `${errorText(error)}\n\n稍后可以在菜单里再试一次。`,
      );
      return;
    }

    const response = await ask({
      type: tasks.length > 0 ? 'warning' : 'info',
      title: 'PayasoAgent',
      message:
        tasks.length > 0
          ? `更新到 ${version} 需要重启，会停止 ${tasks.length} 个进行中的任务`
          : `${version} 已就绪，现在安装并重启？`,
      detail:
        tasks.length > 0
          ? `进行中：\n${tasks
              .slice(0, 3)
              .map((task) => `· ${task.task || task.runId}`)
              .join('\n')}${tasks.length > 3 ? `\n…还有 ${tasks.length - 3} 个` : ''}`
          : '重启后会自动接着用当前工作区。',
      buttons: ['安装并重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return; // 任何取消路径都不授予安装许可

    try {
      await options.backend.stop();
    } catch (error) {
      // 关停不干净 → 拒绝安装（半死不活的后端比不更新更糟）。
      await reportFailure('install', error);
      return;
    }

    log(`installing ${version} and restarting`);
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      // 后端已经停了却没能进安装流程 → 必须把它拉回来，否则用户被晾在一个
      // 没有后端的壳里（DSH 同款回滚，调研 §1.4）。
      await reportFailure('install', error);
      try {
        await options.backend.start();
      } catch (restartError) {
        log(`rollback restart failed: ${errorText(restartError)}`);
      }
    }
  }

  async function download(version: string): Promise<void> {
    if (downloading) return;
    downloading = true;
    // 227MB 的包下载期间，界面上必须有可见进度（真机反馈：v0.4.11 什么都没有）
    emitStatus(downloadingStatus(version, 0));
    setDockProgress(0);
    const onProgress = (progress: { percent?: number }): void => {
      if (typeof progress.percent !== 'number') return;
      emitStatus(downloadingStatus(version, progress.percent));
      setDockProgress(progress.percent);
    };
    autoUpdater.on('download-progress', onProgress);
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      // 下载失败：退回「有新版本」，用户可以从侧边栏条目再点一次重试
      pendingVersion = version;
      emitStatus(availableStatus(version));
      await reportFailure('download', error);
      return;
    } finally {
      autoUpdater.off('download-progress', onProgress);
      downloading = false;
      setDockProgress(-1);
    }
    pendingVersion = null;
    emitStatus(IDLE_UPDATE_STATUS);
    await installAndRestart(version);
  }

  /** 跑一次检查。interactive=true 时无论有没有更新都有回话（菜单点的手要有反馈）。 */
  async function runCheck(interactive: boolean): Promise<void> {
    if (checking) return checking;
    if (!updatesEnabled()) {
      if (interactive) {
        await say(
          'info',
          '当前构建不检查更新',
          '开发模式（未打包，或打包时没生成 app-update.yml）不启用自更新。',
        );
      }
      return;
    }
    checking = (async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
        failures = 0;
        const version = result?.updateInfo?.version ?? '';
        // 版本门禁（调研 §1.2）：feed 写错或误点旧包都不许降级。
        if (!version || !isNewerVersion(version, options.currentVersion)) {
          pendingVersion = null;
          emitStatus(IDLE_UPDATE_STATUS);
          if (interactive) await say('info', `已是最新版 ${options.currentVersion}`);
          return;
        }
        log(`update available: ${version}（当前 ${options.currentVersion}）`);
        pendingVersion = version;
        emitStatus(availableStatus(version));
        const response = await ask({
          type: 'info',
          title: 'PayasoAgent',
          message: `发现新版本 ${version}（当前 ${options.currentVersion}）`,
          detail: '下载完成后需要重启应用安装；进行中的任务会在安装前先确认。',
          buttons: ['下载', '稍后'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response !== 0) return;
        await download(version);
      } catch (error) {
        failures += 1;
        // 后台检查失败**不弹窗**：用户没点任何东西，网络抖动 / 合盖唤醒都会失败，
        // 每次都弹「检查更新失败」纯属骚扰（v0.4.10 真机反馈：唤醒后弹
        // net::ERR_NETWORK_IO_SUSPENDED）。只有菜单手点的检查才需要给用户回话。
        if (interactive) await reportFailure('check', error);
        else log(`check failed (auto, 退避后重试): ${errorText(error)}`);
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  function schedule(): void {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        void runCheck(false).finally(schedule);
      },
      nextCheckDelay({
        attempt: failures,
        baseMs: BASE_CHECK_INTERVAL_MS,
        maxMs: MAX_CHECK_INTERVAL_MS,
        jitterRatio: CHECK_JITTER_RATIO,
        random: Math.random,
      }),
    );
    timer.unref?.();
  }

  return {
    checkInteractively: () => runCheck(true),

    downloadNow: async () => {
      const version = pendingVersion;
      if (!version || downloading) return;
      await download(version);
    },

    startAutoCheck: () => {
      if (!updatesEnabled()) {
        log('自更新未启用（开发模式或缺少 app-update.yml）');
        return;
      }
      // 未监听的 'error' 事件会让 EventEmitter 直接抛 → 必须先挂上（哪怕只记日志）。
      autoUpdater.on('error', (error: Error) => log(`updater error: ${error.message}`));
      // 只检查、不自动下载、退出时也不偷偷装：安装永远走显式确认。
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowDowngrade = false;

      firstTimer = setTimeout(() => void runCheck(false), FIRST_CHECK_DELAY_MS);
      firstTimer.unref?.();
      schedule();

      const win = parent();
      if (win) {
        focusHandler = () => void runCheck(false);
        win.on('focus', focusHandler);
      }
      resumeHandler = () => {
        // 唤醒瞬间查必失败（网络 I/O 还挂着）→ 推迟几秒，且只留一个待跑
        if (resumeTimer) clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          void runCheck(false);
        }, RESUME_CHECK_DELAY_MS);
        resumeTimer.unref?.();
      };
      powerMonitor.on('resume', resumeHandler);
    },

    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (firstTimer) clearTimeout(firstTimer);
      if (resumeTimer) clearTimeout(resumeTimer);
      timer = null;
      firstTimer = null;
      resumeTimer = null;
      setDockProgress(-1);
      emitStatus(IDLE_UPDATE_STATUS);
      if (focusHandler) parent()?.off('focus', focusHandler);
      if (resumeHandler) powerMonitor.off('resume', resumeHandler);
      focusHandler = null;
      resumeHandler = null;
    },
  };
}
