// 保留 electron-updater 的下载、验签、NSIS 参数与提权回退，只修正退出时机。
import { type StdioOptions, spawn } from 'node:child_process';
import path from 'node:path';
import electronUpdater from 'electron-updater';

const { NsisUpdater } = electronUpdater;

export function launchInstallerProcess(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stdio?: StdioOptions;
    timeoutMs?: number;
    spawnProcess?: typeof spawn;
  } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const elevated = path.win32.basename(command).toLowerCase() === 'elevate.exe';
    const child = (options.spawnProcess ?? spawn)(command, args, {
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: options.stdio ?? 'ignore',
      env: options.env,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('spawn', onSpawn);
      child.off('exit', onExit);
      // 保留 error 监听直到 child 被回收，避免后续事件变成未处理异常。
      if (error) reject(error);
      else {
        child.unref();
        resolve();
      }
    };
    const onSpawn = () => {
      // 提权帮助器启动不等于用户已授权；等它结束才能判定交接。
      if (!elevated) finish();
    };
    const onExit = (code: number | null) => {
      if (elevated && code === 0) finish();
      else
        finish(
          new Error(
            `安装器未能启动或管理员授权被取消（退出码 ${code ?? '未知'}），当前版本会继续运行`,
          ),
        );
    };
    const timer = setTimeout(() => {
      finish(new Error('等待 Windows 安装器启动超时，已取消本次交接'));
      child.kill();
    }, options.timeoutMs ?? 45_000);
    timer.unref?.();
    child.on('error', finish);
    child.on('spawn', onSpawn);
    child.on('exit', onExit);
  });
}

export class GuardedNsisUpdater extends NsisUpdater {
  private launching = false;

  private readonly launchFailed = () => {
    this.launching = false;
    this.quitAndInstallCalled = false;
    this.off('error', this.launchFailed);
  };

  override quitAndInstall(isSilent = false, isForceRunAfter = false): void {
    if (this.launching || this.quitAndInstallCalled) return;
    this.launching = true;
    this.on('error', this.launchFailed);
    // BaseUpdater.quitAndInstall 会在 doInstall 返回 true 后直接排队退出，
    // 此时异步 CreateProcess / UAC 还可能失败。这里只发起 install，成功启动后再退出。
    const accepted = this.install(
      isSilent,
      isSilent ? isForceRunAfter : this.autoRunAppAfterInstall,
    );
    if (!accepted) this.launchFailed();
  }

  protected launchInstaller(
    command: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
    stdio?: StdioOptions,
  ): Promise<void> {
    return launchInstallerProcess(command, args, { env, stdio });
  }

  protected override async spawnLog(
    command: string,
    args: string[] = [],
    env?: NodeJS.ProcessEnv,
    stdio: StdioOptions = 'ignore',
  ): Promise<boolean> {
    try {
      await this.launchInstaller(command, args, env, stdio);
    } catch (error) {
      // 上游 ENOENT 分支用 shell.openPath，但忽略其返回的错误字符串，会永久等不到反馈。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw Object.assign(new Error('下载的安装器不存在，可能已被清理或隔离，请重新下载更新'), {
          code: 'ERR_UPDATER_INSTALLER_MISSING',
          cause: error,
        });
      }
      throw error; // EACCES / UNKNOWN 保留上游的 elevate.exe 回退。
    }
    if (this.launching) {
      this.launching = false;
      this.off('error', this.launchFailed);
      setImmediate(() => this.app.quit());
    }
    return true;
  }
}
