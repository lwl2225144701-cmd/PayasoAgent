// Host-owned current Workspace. The canonical absolute root is never exposed
// through Tool Schemas or accepted from LLM arguments.

import { execFile } from 'node:child_process';
import path from 'node:path';
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
// - darwin：osascript choose folder（现状不变）
// - win32：Windows PowerShell 5.1 + FolderBrowserDialog（-STA 必需；pwsh/PS7
//   是 .NET Core 不带 WinForms，不能用于此）；输出显式 UTF-8 防中文路径乱码
export async function openWorkspacePicker(): Promise<Workspace | null> {
  if (process.platform === 'darwin') {
    return openPickerViaOsascript();
  }
  if (process.platform === 'win32') {
    return openPickerViaPowerShell();
  }
  throw new Error('当前版本仅支持 macOS/Windows 本地文件夹选择器');
}

async function openPickerViaOsascript(): Promise<Workspace | null> {
  const script = 'POSIX path of (choose folder with prompt "选择 PayasoAgent Workspace")';
  return await new Promise<Workspace | null>((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        if (/user canceled/i.test(String(stderr))) {
          resolve(null);
          return;
        }
        reject(new Error('无法打开本地文件夹选择器'));
        return;
      }
      try {
        resolve(setWorkspace(String(stdout).trim()));
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

// Windows PowerShell 5.1 固定路径（Win7+ 均有；绝不用 pwsh——.NET Core 无 WinForms）
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

// FolderBrowserDialog 脚本：取消时无输出；选中时输出一行绝对路径（UTF-8）。
const FOLDER_PICKER_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$d.Description = '选择 PayasoAgent Workspace'",
  '$d.ShowNewFolderButton = $true',
  'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
  '  [Console]::WriteLine($d.SelectedPath)',
  '}',
].join('; ');

async function openPickerViaPowerShell(): Promise<Workspace | null> {
  return await new Promise<Workspace | null>((resolve, reject) => {
    execFile(
      WINDOWS_POWERSHELL,
      ['-NoProfile', '-STA', '-Command', FOLDER_PICKER_SCRIPT],
      { timeout: 120_000 },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(
              new Error(
                '无法打开文件夹选择器：未找到 Windows PowerShell。请改用 Workspace 名称创建。',
              ),
            );
            return;
          }
          // 用户直接关掉对话框（无选路径、无错）→ 按取消处理
          if (!String(stderr).trim() && String(stdout).trim().length === 0) {
            resolve(null);
            return;
          }
          reject(new Error('无法打开本地文件夹选择器'));
          return;
        }
        const selected = String(stdout).trim();
        if (!selected) {
          resolve(null); // 取消
          return;
        }
        try {
          // 与 darwin 同一校验链：isAbsolute + exists + isDirectory + realpath
          resolve(setWorkspace(selected));
        } catch (cause) {
          reject(cause);
        }
      },
    );
  });
}

// Public UI projection: do not keep the full host path on screen or in normal
// Run payloads. The canonical root remains available only to Host/Runtime.
export function workspacePublicView(workspace: Workspace | null): { name: string } | null {
  return workspace ? { name: workspace.name } : null;
}
