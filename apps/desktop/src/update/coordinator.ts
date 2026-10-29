// Electron 接线与自动检查调度；更新状态机见 flow.ts。
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  app,
  type BrowserWindow,
  dialog,
  autoUpdater as nativeUpdater,
  powerMonitor,
  shell,
} from 'electron';
import electronUpdater from 'electron-updater';
import { createResumingHttpExecutor } from './download-resume.js';
import { createUpdateFlow, type UpdateBackendBridge } from './flow.js';
import { requiresManualMacInstall, waitForUpdateEvent } from './lifecycle.js';
import { isNetworkFailure, nextCheckDelay } from './policy.js';
import { clampPercent, type UpdateStatus } from './status.js';
import { GuardedNsisUpdater } from './windows-installer.js';

const autoUpdater =
  process.platform === 'win32' ? new GuardedNsisUpdater() : electronUpdater.autoUpdater;
const BASE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const MAX_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_JITTER_RATIO = 0.2;
const FIRST_CHECK_DELAY_MS = 20 * 1000;
const RESUME_CHECK_DELAY_MS = 5_000;
const INSTALL_TIMEOUT_MS = 60_000;
/** 全量下载遇 GitHub 断线时自动重试；每次从 0 开始（electron-updater 无断点续传）。 */
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 3_000;

export interface UpdateCoordinatorOptions {
  currentVersion: string;
  window: () => BrowserWindow | null;
  backend: UpdateBackendBridge;
  log?: (message: string) => void;
  onStatus?: (status: UpdateStatus) => void;
}

export interface UpdateCoordinator {
  checkInteractively: () => Promise<void>;
  /** 根据当前状态下载更新，或继续安装已下载的更新。 */
  downloadNow: () => Promise<void>;
  startAutoCheck: () => void;
  dispose: () => void;
}

export function appUpdateConfigPath(): string {
  return path.join(process.resourcesPath, 'app-update.yml');
}

export function updatesEnabled(): boolean {
  return app.isPackaged && existsSync(appUpdateConfigPath());
}

export function updateLogger(message: string): void {
  console.log(`[updates] ${message}`);
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    const file = path.join(dir, 'updater.log');
    mkdirSync(dir, { recursive: true });
    if (existsSync(file) && statSync(file).size > 1024 * 1024) renameSync(file, `${file}.1`);
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // 日志目录不可写不应影响更新。
  }
}

export function createUpdateCoordinator(options: UpdateCoordinatorOptions): UpdateCoordinator {
  const log = options.log ?? updateLogger;
  // Windows 的 NSIS 更新包下载换成带 Range 续传 + 真实进度的实现。
  // disableDifferentialDownload=true 保证只会调 download()，鸭子类型注入足够。
  // Mac 走上游 MacUpdater（zip + Squirrel），不动。
  // `httpExecutor` 在上游标了 @internal，公开 d.ts 里查不到，按结构注入。
  if (autoUpdater instanceof GuardedNsisUpdater) {
    (autoUpdater as unknown as { httpExecutor: unknown }).httpExecutor = createResumingHttpExecutor(
      {
        log: (message) => log(message),
      },
    );
  }
  let timer: NodeJS.Timeout | null = null;
  let firstTimer: NodeJS.Timeout | null = null;
  let resumeTimer: NodeJS.Timeout | null = null;
  let started = false;
  let disposed = false;
  let manualInstall: Promise<boolean> | null = null;
  let nativePrepared = false;
  let focusWindow: BrowserWindow | undefined;

  function parent(): BrowserWindow | undefined {
    const win = options.window();
    return win && !win.isDestroyed() ? win : undefined;
  }

  async function messageBox(box: Electron.MessageBoxOptions): Promise<number> {
    const win = parent();
    const result = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box);
    return result.response;
  }

  function detectManualInstall(): Promise<boolean> {
    if (process.platform !== 'darwin') return Promise.resolve(false);
    manualInstall ??= new Promise<boolean>((resolve) => {
      execFile(
        '/usr/bin/codesign',
        ['-dv', '--verbose=4', process.execPath],
        { timeout: 5_000 },
        (error, stdout, stderr) => {
          const manual = !!error || requiresManualMacInstall(`${stdout}\n${stderr}`);
          log(
            `macOS installation mode: ${manual ? 'manual (no stable signing identity)' : 'native'}`,
          );
          resolve(manual);
        },
      );
    });
    return manualInstall;
  }

  const flow = createUpdateFlow({
    currentVersion: options.currentVersion,
    enabled: updatesEnabled,
    backend: options.backend,
    log,
    say: async (type, message, detail) => {
      await messageBox({ type, title: 'PayasoAgent', message, detail, buttons: ['好'] });
    },
    ask: (question) => messageBox({ ...question, title: 'PayasoAgent', defaultId: 0, cancelId: 1 }),
    status: (status) => {
      try {
        options.onStatus?.(status);
      } catch (error) {
        log(`status relay failed: ${String(error)}`);
      }
    },
    progress: (percent) => parent()?.setProgressBar(percent < 0 ? -1 : clampPercent(percent) / 100),
    source: {
      check: async () => (await autoUpdater.checkForUpdates())?.updateInfo.version ?? '',
      requiresManualInstall: detectManualInstall,
      download: async (progress) => {
        // 进度说真话：上游 ProgressCallbackTransform 会在流提前结束时无条件报 100%
        // （percent/transferred 直接写成 total），网络一断就是「假 100% → 校验失败 →
        // 归零重来」。这里自己按 已接收/总长 算，并且只在两者相等时才可能是 100。
        const onProgress = (value: { percent?: number; transferred?: number; total?: number }) => {
          const { transferred, total } = value;
          if (
            typeof transferred === 'number' &&
            typeof total === 'number' &&
            Number.isFinite(total) &&
            total > 0
          ) {
            progress(Math.min(100, (transferred / total) * 100));
            return;
          }
          if (typeof value.percent === 'number') progress(value.percent);
        };
        autoUpdater.on('download-progress', onProgress);
        nativePrepared = false;
        try {
          let lastError: unknown;
          for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
            try {
              // 不再 progress(0)：续传在 downloadWithResume 内部完成，进度只增不减。
              return await autoUpdater.downloadUpdate();
            } catch (error) {
              lastError = error;
              const message = error instanceof Error ? error.message : String(error);
              if (!isNetworkFailure(message) || attempt >= DOWNLOAD_ATTEMPTS) throw error;
              log(
                `download interrupted (${message}); retry ${attempt}/${DOWNLOAD_ATTEMPTS - 1} after ${DOWNLOAD_RETRY_DELAY_MS}ms`,
              );
              await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_RETRY_DELAY_MS));
            }
          }
          throw lastError;
        } finally {
          autoUpdater.off('download-progress', onProgress);
        }
      },
      prepareInstall: async () => {
        if (process.platform !== 'darwin' || nativePrepared) return;
        // autoInstallOnAppQuit=false 时，downloadUpdate 仅下载 zip，并未让 Squirrel 验签。
        await waitForUpdateEvent({
          errors: nativeUpdater,
          success: nativeUpdater,
          event: 'update-downloaded',
          trigger: () => nativeUpdater.checkForUpdates(),
          timeoutMs: INSTALL_TIMEOUT_MS,
          timeoutMessage: '系统准备更新超时，已保留更新包，请重试安装',
        });
        nativePrepared = true;
      },
      install: async () => {
        try {
          await waitForUpdateEvent({
            errors: autoUpdater,
            success: app,
            event: 'will-quit',
            trigger: () => autoUpdater.quitAndInstall(true, true),
            timeoutMs: INSTALL_TIMEOUT_MS,
            timeoutMessage: '安装器没有完成重启交接，已恢复当前版本，可以重试安装',
          });
        } catch (error) {
          if (autoUpdater instanceof GuardedNsisUpdater) autoUpdater.resetInstallAttempt();
          throw error;
        }
      },
      openPackage: async (file) => {
        const error = await shell.openPath(file);
        if (error) throw new Error(error);
      },
    },
  });

  function schedule(): void {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        void flow.check(false).finally(schedule);
      },
      nextCheckDelay({
        attempt: flow.failureCount(),
        baseMs: BASE_CHECK_INTERVAL_MS,
        maxMs: MAX_CHECK_INTERVAL_MS,
        jitterRatio: CHECK_JITTER_RATIO,
        random: Math.random,
      }),
    );
    timer.unref?.();
  }

  const onError = (error: Error) => log(`updater error: ${error.message}`);
  const onFocus = () => {
    void flow.check(false);
  };
  const onResume = () => {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      void flow.check(false);
    }, RESUME_CHECK_DELAY_MS);
    resumeTimer.unref?.();
  };

  return {
    checkInteractively: () => flow.check(true),
    downloadNow: () => flow.downloadNow(),
    startAutoCheck: () => {
      if (started || disposed) return;
      started = true;
      if (!updatesEnabled()) {
        log('自更新未启用（开发模式或缺少 app-update.yml）');
        return;
      }
      autoUpdater.on('error', onError);
      autoUpdater.logger = {
        info: (message) => log(String(message)),
        warn: (message) => log(String(message)),
        error: (message) => log(String(message)),
      };
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowDowngrade = false;
      // 差分以本机缓存的旧安装包为底；它与线上旧版不一致时（本地打包安装、缓存被清），
      // 差分会下满 100% 才校验失败，再从 0 全量重下。直接全量下载。
      autoUpdater.disableDifferentialDownload = true;
      log(`updater started; current version ${options.currentVersion}`);
      firstTimer = setTimeout(() => {
        void flow.check(false);
      }, FIRST_CHECK_DELAY_MS);
      firstTimer.unref?.();
      schedule();
      focusWindow = parent();
      focusWindow?.on('focus', onFocus);
      powerMonitor.on('resume', onResume);
    },
    dispose: () => {
      disposed = true;
      flow.dispose();
      if (timer) clearTimeout(timer);
      if (firstTimer) clearTimeout(firstTimer);
      if (resumeTimer) clearTimeout(resumeTimer);
      focusWindow?.off('focus', onFocus);
      powerMonitor.off('resume', onResume);
      autoUpdater.off('error', onError);
      parent()?.setProgressBar(-1);
    },
  };
}
