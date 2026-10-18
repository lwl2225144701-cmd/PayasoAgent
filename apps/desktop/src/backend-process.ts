import { type ChildProcess, execFile } from 'node:child_process';
import { withTimeout } from './update/lifecycle.js';

/** 成功确认退出才允许调用方清除引用；失败时由调用方继续持有进程。 */
export async function stopManagedBackend(
  child: ChildProcess,
  options: {
    platform?: NodeJS.Platform;
    killTree?: (pid: number) => Promise<void>;
    graceMs?: number;
    killGraceMs?: number;
  } = {},
): Promise<void> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return;
  let resolveExit!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const onExit = () => resolveExit();
  child.on('exit', onExit);
  const wait = (ms: number) => withTimeout(done, ms, '后端进程仍未退出');
  try {
    if ((options.platform ?? process.platform) === 'win32') {
      if (child.pid === undefined) throw new Error('后端进程没有有效 PID，无法确认关停');
      const killTree =
        options.killTree ??
        ((pid: number) =>
          new Promise<void>((resolve, reject) => {
            execFile(
              'taskkill',
              ['/PID', String(pid), '/T', '/F'],
              { windowsHide: true, timeout: 5_000 },
              (error) => {
                if (error) reject(error);
                else resolve();
              },
            );
          }));
      let killError: unknown;
      try {
        await killTree(child.pid);
      } catch (error) {
        killError = error;
      }
      if (!exited()) {
        try {
          await wait(options.killGraceMs ?? 5_000);
        } catch {
          throw new Error(
            `无法关停 Windows 后端进程树，已取消安装并保留当前进程${killError ? `：${String(killError)}` : ''}`,
          );
        }
      }
      return;
    }
    child.kill('SIGTERM');
    try {
      await wait(options.graceMs ?? 10_000);
    } catch {
      child.kill('SIGKILL');
      await wait(options.killGraceMs ?? 5_000);
    }
  } finally {
    child.off('exit', onExit);
  }
}
