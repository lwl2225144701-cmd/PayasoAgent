// 不依赖 Electron 的更新流程，测试直接运行真实的检查、下载、安装与回滚分支。
import { withTimeout } from './lifecycle.js';
import { describeUpdateFailure, isNewerVersion, type UpdateOperation } from './policy.js';
import {
  availableStatus,
  downloadingStatus,
  IDLE_UPDATE_STATUS,
  readyStatus,
  type UpdateStatus,
} from './status.js';

const TASKS_TIMEOUT_MS = 10_000;
const CHECK_TIMEOUT_MS = 30_000;

export interface UpdateBackendBridge {
  listActiveTasks: () => Promise<{ runId: string; task: string }[]>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
}

export interface UpdateQuestion {
  type: 'info' | 'warning';
  message: string;
  detail: string;
  buttons: string[];
}

export interface UpdateFlowOptions {
  currentVersion: string;
  enabled: () => boolean;
  backend: UpdateBackendBridge;
  source: {
    check: () => Promise<string>;
    download: (progress: (percent: number) => void) => Promise<string[]>;
    requiresManualInstall: () => Promise<boolean>;
    prepareInstall: () => Promise<void>;
    install: () => Promise<void>;
    openPackage: (file: string) => Promise<void>;
  };
  ask: (question: UpdateQuestion) => Promise<number>;
  say: (type: 'info' | 'error', message: string, detail?: string) => Promise<void>;
  status: (status: UpdateStatus) => void;
  progress: (percent: number) => void;
  log: (message: string) => void;
}

export function createUpdateFlow(options: UpdateFlowOptions) {
  let status = IDLE_UPDATE_STATUS;
  let checking: Promise<void> | null = null;
  let interacting: Promise<void> | null = null;
  let acting: Promise<void> | null = null;
  let pendingVersion: string | null = null;
  let ready: { version: string; file: string; manual: boolean } | null = null;
  let failures = 0;
  let checkError: unknown = null;
  let disposed = false;

  function emit(next: UpdateStatus): void {
    status = next;
    if (!disposed) options.status(next);
  }

  function restore(): void {
    if (ready) emit(readyStatus(ready.version, ready.manual));
    else if (pendingVersion) emit(availableStatus(pendingVersion));
    else emit(IDLE_UPDATE_STATUS);
  }

  async function report(operation: UpdateOperation, error: unknown): Promise<void> {
    const raw = error instanceof Error ? error.message : String(error);
    options.log(`${operation} failed: ${raw}`);
    if (!disposed)
      await options.say('error', describeUpdateFailure(operation, raw), raw.slice(0, 800));
  }

  function singleAction(action: () => Promise<void>): Promise<void> {
    if (acting) return acting;
    acting = Promise.resolve()
      .then(action)
      .finally(() => {
        acting = null;
      });
    return acting;
  }

  async function installReady(): Promise<void> {
    const update = ready;
    if (!update || disposed) return;
    if (update.manual) {
      const response = await options.ask({
        type: 'info',
        message: `v${update.version} 已下载，请手动替换应用`,
        detail:
          '当前 Mac 版本使用临时签名，无法通过系统的自动替换校验。打开更新包解压后，退出 PayasoAgent，将新应用拖到「应用程序」文件夹并替换，再重新打开。当前工作区和历史记录会保留。',
        buttons: ['打开更新包', '稍后'],
      });
      if (response !== 0 || disposed) return;
      try {
        await options.source.openPackage(update.file);
        options.log(`opened update package ${update.version} for manual installation`);
      } catch (error) {
        await report('install', error);
      }
      return;
    }

    let stopped = false;
    emit({ phase: 'installing', version: update.version, percent: 0 });
    try {
      // macOS 先让 Squirrel 完成签名校验/暂存，成功前保持后端可用。
      await options.source.prepareInstall();
      const tasks = await withTimeout(
        options.backend.listActiveTasks(),
        TASKS_TIMEOUT_MS,
        '查询运行中的任务超时，请稍后重试',
      );
      options.log(`install preflight ${update.version}: ${tasks.length} active tasks`);
      const response = await options.ask({
        type: tasks.length > 0 ? 'warning' : 'info',
        message:
          tasks.length > 0
            ? `更新到 ${update.version} 需要重启，会停止 ${tasks.length} 个进行中的任务`
            : `${update.version} 已就绪，现在安装并重启？`,
        detail:
          tasks.length > 0
            ? `进行中：\n${tasks
                .slice(0, 3)
                .map((task) => `· ${task.task || task.runId}`)
                .join('\n')}`
            : '重启后会自动接着用当前工作区。',
        buttons: ['安装并重启', '稍后'],
      });
      if (response !== 0 || disposed) return;
      await options.backend.stop();
      stopped = true;
      options.log(`installing ${update.version} and waiting for application exit`);
      await options.source.install();
    } catch (error) {
      // 先恢复服务，再显示错误。不能让用户关掉对话框后才恢复后端。
      if (stopped) {
        try {
          await options.backend.start();
          options.log('backend restored after installation failure');
        } catch (restartError) {
          options.log(`rollback restart failed: ${String(restartError)}`);
          await report(
            'install',
            new Error(`${String(error)}\n后端恢复失败，请重新打开客户端：${String(restartError)}`),
          );
          return;
        }
      }
      await report('install', error);
    } finally {
      restore();
    }
  }

  async function download(version: string): Promise<void> {
    emit(downloadingStatus(version, 0));
    options.progress(0);
    try {
      const manual = await options.source.requiresManualInstall();
      const files = await options.source.download((percent) => {
        emit(downloadingStatus(version, percent));
        options.progress(percent);
      });
      const file = files[0];
      if (!file) throw new Error('更新包下载结束，但没有返回可安装的文件，请重新下载');
      ready = { version, file, manual };
      pendingVersion = null;
      options.log(`update ${version} downloaded; installation=${manual ? 'manual' : 'native'}`);
    } catch (error) {
      pendingVersion = version;
      restore();
      await report('download', error);
      return;
    } finally {
      options.progress(-1);
    }
    restore();
    await installReady();
  }

  async function check(): Promise<void> {
    if (checking) return checking;
    checkError = null;
    checking = Promise.resolve().then(async () => {
      try {
        const version = await withTimeout(
          options.source.check(),
          CHECK_TIMEOUT_MS,
          '检查更新超时，请稍后重试',
        );
        failures = 0;
        if (acting || ready || disposed) return;
        pendingVersion =
          version && isNewerVersion(version, options.currentVersion) ? version : null;
        options.log(
          pendingVersion ? `update available: ${version}` : `up to date: ${options.currentVersion}`,
        );
      } catch (error) {
        failures += 1;
        checkError = error;
        options.log(`check failed (auto, 退避后重试): ${String(error)}`);
      } finally {
        checking = null;
        if (!acting && !disposed) restore();
      }
    });
    return checking;
  }

  return {
    failureCount: () => failures,
    async check(interactive: boolean): Promise<void> {
      if (disposed) return;
      if (!options.enabled()) {
        if (interactive) await options.say('info', '当前构建不检查更新', '开发模式未启用自更新。');
        return;
      }
      if (!interactive) {
        if (!acting && !ready && !interacting) await check();
        return;
      }
      if (interacting) return interacting;
      interacting = Promise.resolve()
        .then(async () => {
          if (acting) {
            await options.say(
              'info',
              status.phase === 'downloading'
                ? `正在下载更新 ${status.percent}%`
                : '正在准备安装更新',
            );
            return;
          }
          if (ready) return singleAction(installReady);
          emit({ phase: 'checking', version: '', percent: 0 });
          await check(); // 手动检查加入后台检查后，仍须给用户结果。
          if (disposed) return;
          if (checkError) return report('check', checkError);
          const version = pendingVersion;
          if (!version) return options.say('info', `已是最新版 ${options.currentVersion}`);
          const response = await options.ask({
            type: 'info',
            message: `v${version} 可更新`,
            detail: `当前版本 ${options.currentVersion}。下载期间可以继续使用。`,
            buttons: ['下载更新', '稍后'],
          });
          if (response === 0 && !disposed) await singleAction(() => download(version));
        })
        .finally(() => {
          interacting = null;
        });
      return interacting;
    },
    downloadNow: async () => {
      // 检查可能更新 electron-updater 内部的目标版本，下载前须等它完成。
      if (checking) await checking;
      return singleAction(async () => {
        if (disposed || !options.enabled()) return;
        if (ready) await installReady();
        else if (pendingVersion) await download(pendingVersion);
      });
    },
    dispose: () => {
      disposed = true;
    },
  };
}
