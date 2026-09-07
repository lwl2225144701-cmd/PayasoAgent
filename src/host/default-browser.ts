import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertInsideRoot, resolveWorkspacePath } from '../sandbox/sandbox-manager.js';

type BrowserOpener = (fileUrl: string) => Promise<void>;

function systemBrowserOpener(fileUrl: string, platform: NodeJS.Platform): Promise<void> {
  // 平台分支：darwin → open；win32 → rundll32 FileProtocolHandler（Windows 语义的
  // 「默认应用打开」）；linux → xdg-open。
  const [cmd, args] =
    platform === 'win32'
      ? ['rundll32.exe', ['url.dll', 'FileProtocolHandler', fileUrl]]
      : platform === 'linux'
        ? ['xdg-open', [fileUrl]]
        : ['/usr/bin/open', [fileUrl]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 64 * 1024 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

export async function openFileInDefaultBrowser(
  workspaceRoot: string,
  relativePath: string,
  options: { opener?: BrowserOpener; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    throw new Error('default browser opening is not supported on this platform');
  }
  if (!relativePath || relativePath === '.' || relativePath.split(/[\\/]+/).includes('..')) {
    throw new Error('invalid preview path');
  }
  const target = resolveWorkspacePath(workspaceRoot, relativePath);
  assertInsideRoot(workspaceRoot, target);
  const realTarget = fs.realpathSync.native(target);
  assertInsideRoot(workspaceRoot, realTarget);
  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) throw new Error('preview target must be a file');
  const opener = options.opener ?? ((url: string) => systemBrowserOpener(url, platform));
  await opener(pathToFileURL(realTarget).href);
}
