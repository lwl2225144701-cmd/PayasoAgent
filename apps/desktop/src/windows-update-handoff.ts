import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';

export function updateHandoffToken(argv: readonly string[]): string | null {
  const value = argv.find((arg) => arg.startsWith('--payaso-update-token='))?.split('=')[1];
  return value && /^[a-f0-9]{32}$/.test(value) ? value : null;
}

/** 只在后端可用、窗口已加载后发送，由独立 helper 核验本轮 token/版本/路径/PID。 */
export function reportWindowsUpdateReady(options: {
  token: string;
  version: string;
  exe: string;
  pid: number;
  connect?: typeof createConnection;
}): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(options.token))
    return Promise.reject(new Error('Invalid update token'));
  return new Promise((resolve, reject) => {
    const socket = (options.connect ?? createConnection)(
      `\\\\.\\pipe\\PayasoAgent-update-${options.token}`,
    );
    socket.setTimeout(5000);
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('Update readiness pipe timed out')));
    socket.once('connect', () => {
      socket.end(
        `${JSON.stringify({ token: options.token, version: options.version, exe: options.exe, pid: options.pid })}\n`,
        () => resolve(),
      );
    });
  });
}

/** 与安装器共用原生创建方式；只修已有链接，不补回用户主动删除的图标。 */
export function repairInstalledWindowsShortcuts(
  helper: string,
  exe: string,
  links: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(helper, ['repair', exe, ...links], { timeout: 15000, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
