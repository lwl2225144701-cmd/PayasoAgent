// Host-owned current Workspace. The canonical absolute root is never exposed
// through Tool Schemas or accepted from LLM arguments.

import { execFile, fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeWorkspaceRoot } from '../sandbox/sandbox-manager.js';

export type Workspace = {
  rootPath: string;
  name: string;
};

let currentWorkspace: Workspace | null = null;

export function setWorkspace(rootPath: string): Workspace {
  const canonical = canonicalizeWorkspaceRoot(rootPath);
  currentWorkspace = {
    rootPath: canonical,
    name: path.basename(canonical) || canonical,
  };
  return { ...currentWorkspace };
}

export function getWorkspace(): Workspace | null {
  return currentWorkspace ? { ...currentWorkspace } : null;
}

export function clearWorkspace(): void {
  currentWorkspace = null;
}

// Rename the display label of the Host's current Workspace (root path unchanged).
// New sessions created while this Workspace is active inherit the new label.
export function renameWorkspaceLabel(name: string): void {
  if (currentWorkspace) currentWorkspace = { ...currentWorkspace, name };
}

// Browsers intentionally do not reveal an arbitrary folder's absolute host
// path. The local Host therefore owns the native picker and authorizes
// only the directory the user explicitly chooses.
//
// 两条平台实现都**不经过 shell 里的慢路径**：
// - darwin：osascript `choose folder`（实测进程开销 40~100ms）
// - win32：koffi 直驱 COM `IFileOpenDialog` 的子进程
//   （旧实现走 PowerShell 5.1 + WinForms：冷启动 + 程序集加载 1.5~4 秒，真机反馈很慢）
export async function openWorkspacePicker(): Promise<Workspace | null> {
  if (process.platform === 'darwin') {
    return openPickerViaOsascript();
  }
  if (process.platform === 'win32') {
    return openPickerViaWin32Dialog();
  }
  throw new Error('当前版本仅支持 macOS/Windows 本地文件夹选择器');
}

/**
 * osascript 报的"用户取消"是不是取消？
 *
 * **判据必须与语言无关**：中文 macOS 下 osascript 输出的是
 * `execution error: 用户已取消。 (-128)`，只匹配英文 "user canceled" 会把
 * 取消误判成失败（曾经如此：点取消弹 `API 400 无法打开本地文件夹选择器`）。
 * `-128` 是 `errAEEventCancelled`，各语言下都在。
 */
export function isAppleScriptCancelled(stderr: string): boolean {
  return /\(-128\)/.test(stderr) || /user canceled|用户已取消/i.test(stderr);
}

async function openPickerViaOsascript(): Promise<Workspace | null> {
  const script = 'POSIX path of (choose folder with prompt "选择 PayasoAgent Workspace")';
  return await new Promise<Workspace | null>((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        // 用户取消 → 按 null 处理（不是错误，不该弹 toast）
        if (isAppleScriptCancelled(String(stderr))) {
          resolve(null);
          return;
        }
        reject(new Error('无法打开本地文件夹选择器'));
        return;
      }
      const selected = String(stdout).trim();
      if (!selected) {
        resolve(null); // 无输出也按取消处理
        return;
      }
      try {
        resolve(setWorkspace(selected));
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

// Windows：koffi 直驱 COM `IFileOpenDialog` 的子进程（见
// win32-folder-dialog-worker.mjs 的文件头，含为什么不用 PowerShell）。
// 子进程通过 IPC 汇报：showing（即将阻塞）→ done(path) / error(message)。
const WIN32_DIALOG_WORKER = fileURLToPath(
  new URL('./win32-folder-dialog-worker.mjs', import.meta.url),
);

const WIN32_DIALOG_TIMEOUT_MS = 120_000;

async function openPickerViaWin32Dialog(): Promise<Workspace | null> {
  return await new Promise<Workspace | null>((resolve, reject) => {
    const child = fork(WIN32_DIALOG_WORKER, [], {
      // 子进程只负责弹框；把标题经环境变量传过去（argv 与路径无关，避免注入面）
      env: { ...process.env, PAYASO_DIALOG_TITLE: '选择 PayasoAgent Workspace' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      // 对话框归子进程所有，杀进程即关闭窗口；不要留它挂在屏幕上
      if (child.connected) child.disconnect();
      child.kill();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error('文件夹选择器超时未响应')));
    }, WIN32_DIALOG_TIMEOUT_MS);

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });

    child.on('message', (message: unknown) => {
      const msg = message as { kind?: string; path?: string | null; message?: string };
      if (msg?.kind === 'showing') return; // 已进入阻塞 Show，等结果即可
      if (msg?.kind === 'done') {
        const selected = typeof msg.path === 'string' ? msg.path.trim() : '';
        finish(() => {
          if (!selected) {
            resolve(null); // 用户取消
            return;
          }
          try {
            // 与 darwin 同一校验链：isAbsolute + exists + isDirectory + realpath
            resolve(setWorkspace(selected));
          } catch (cause) {
            reject(cause);
          }
        });
        return;
      }
      if (msg?.kind === 'error') {
        finish(() => reject(new Error(msg.message ?? '无法打开本地文件夹选择器')));
      }
    });

    child.on('error', (err) => {
      finish(() => reject(new Error(`无法启动文件夹选择器：${err.message}`)));
    });

    child.on('exit', (code) => {
      finish(() => {
        // 未收到 done/error 就退出：按取消处理（用户直接关掉对话框），
        // 但非 0 退出且带 stderr 时给出更有用的信息
        if (code !== 0 && stderr.trim()) {
          reject(new Error(`无法打开本地文件夹选择器：${stderr.trim().slice(0, 300)}`));
          return;
        }
        resolve(null);
      });
    });
  });
}

// Public UI projection: do not keep the full host path on screen or in normal
// Run payloads. The canonical root remains available only to Host/Runtime.
export function workspacePublicView(workspace: Workspace | null): { name: string } | null {
  return workspace ? { name: workspace.name } : null;
}
