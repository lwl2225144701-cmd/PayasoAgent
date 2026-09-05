import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertInsideRoot, resolveWorkspacePath } from '../sandbox/sandbox-manager.js';

type BrowserOpener = (fileUrl: string) => Promise<void>;

function systemBrowserOpener(fileUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [fileUrl], { timeout: 10_000, maxBuffer: 64 * 1024 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

export async function openFileInDefaultBrowser(
  workspaceRoot: string,
  relativePath: string,
  options: { opener?: BrowserOpener; platform?: NodeJS.Platform } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('default browser opening is only available on macOS');
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
  await (options.opener ?? systemBrowserOpener)(pathToFileURL(realTarget).href);
}
