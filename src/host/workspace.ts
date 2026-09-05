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
// path. The local Host therefore owns the native macOS picker and authorizes
// only the directory the user explicitly chooses.
export async function openWorkspacePicker(): Promise<Workspace | null> {
  if (process.platform !== 'darwin') {
    throw new Error('当前版本仅支持 macOS 本地文件夹选择器');
  }

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

// Public UI projection: do not keep the full host path on screen or in normal
// Run payloads. The canonical root remains available only to Host/Runtime.
export function workspacePublicView(workspace: Workspace | null): { name: string } | null {
  return workspace ? { name: workspace.name } : null;
}
