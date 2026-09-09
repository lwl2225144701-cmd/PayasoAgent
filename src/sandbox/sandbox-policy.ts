// 统一 Sandbox Policy：把“允许访问哪些真实路径”从具体执行器中抽出来。
// Policy 只接受 Runtime 生成的路径；LLM 提供的路径必须先经过 SandboxManager。

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../permission-mode.js';
import { isShellScratchPath } from './shell-scratch.js';

export type SandboxPolicy = {
  workspaceRoot: string;
  readableRoots: string[];
  /** Verified symlink/request paths needed by dynamic loaders (target is canonical). */
  readablePathAliases: Array<{ path: string; canonicalPath: string }>;
  /** Roots from which descendants may execute files; read roots alone do not imply exec. */
  executableRoots: string[];
  writableRoots: string[];
  /**
   * Managed, ephemeral scratch roots (HOME/TMPDIR for Shell) that are writable
   * in every permission mode, including Read Only, and always live outside the
   * Workspace. Never derived from LLM input.
   */
  scratchRoots: string[];
  permissionMode: PermissionMode;
  // v1.6 Network Capability Separation：网络是与文件系统严格分离的独立能力。
  // fail-closed 默认 false；shell 永远显式 false。未来 Browser/Network 类
  // capability 由各自的 provider/policy 显式开启，绝不从 shell 继承或由 LLM 参数决定。
  networkAccess: boolean;
};

function canonicalizeExisting(input: string): string {
  const abs = path.resolve(input);
  try {
    return fs.realpathSync.native(abs);
  } catch (err) {
    throw new Error(`sandbox policy path does not exist: ${abs}`, { cause: err });
  }
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

function canonicalAliases(paths: string[]): Array<{ path: string; canonicalPath: string }> {
  const aliases: Array<{ path: string; canonicalPath: string }> = [];
  const seen = new Set<string>();
  for (const input of paths) {
    const absolute = path.resolve(input);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    aliases.push({ path: absolute, canonicalPath: canonicalizeExisting(absolute) });
  }
  return aliases;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Create a fail-closed policy. Writable roots must be inside workspaceRoot;
 * readable roots may include explicitly approved system paths.
 * networkAccess defaults to false (deny) — 安全默认必须是 deny，调用方漏传即拒绝。
 */
export function createSandboxPolicy(
  workspaceRoot: string,
  options: {
    readableRoots?: string[];
    readablePathAliases?: string[];
    executableRoots?: string[];
    writableRoots?: string[];
    /** Managed ephemeral roots (Shell HOME/TMPDIR). Validated against shellScratchRoot(). */
    scratchRoots?: string[];
    permissionMode?: PermissionMode;
    networkAccess?: boolean;
  } = {},
): SandboxPolicy {
  const root = canonicalizeExisting(workspaceRoot);
  const permissionMode = options.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const scratchRoots = unique((options.scratchRoots ?? []).map(canonicalizeExisting));
  for (const scratch of scratchRoots) {
    // fail-closed：只有 shell-scratch 模块自己创建的受管根目录可以被写成"工作区外可写"。
    if (!isShellScratchPath(scratch)) {
      throw new Error(
        'sandbox policy scratch roots must live under the managed shell scratch root',
      );
    }
  }
  const readableRoots = unique([
    root,
    ...(options.readableRoots ?? []).map(canonicalizeExisting),
    ...scratchRoots,
  ]);
  const executableRoots = unique([
    ...(options.executableRoots ?? []).map(canonicalizeExisting),
    ...scratchRoots,
  ]);
  for (const executableRoot of executableRoots) {
    if (!readableRoots.includes(executableRoot)) readableRoots.push(executableRoot);
  }
  const readablePathAliases = canonicalAliases(options.readablePathAliases ?? []);
  const writableRoots = unique([
    ...(options.writableRoots ?? (permissionMode === 'workspace-write' ? [root] : [])).map(
      canonicalizeExisting,
    ),
    ...scratchRoots,
  ]);

  for (const writable of writableRoots) {
    if (isInside(root, writable)) continue;
    // 工作区外唯一允许的可写根：受管 scratch（read-only 模式下命令仍需要缓存目录）。
    if (isShellScratchPath(writable)) continue;
    throw new Error('sandbox policy writable roots must be inside workspace root');
  }

  return {
    workspaceRoot: root,
    readableRoots,
    readablePathAliases,
    executableRoots,
    writableRoots,
    scratchRoots,
    permissionMode,
    networkAccess: options.networkAccess ?? false,
  };
}

export function canonicalizeSandboxPath(input: string): string {
  return canonicalizeExisting(input);
}

export function isSandboxPathInside(root: string, target: string): boolean {
  return isInside(canonicalizeSandboxPath(root), canonicalizeSandboxPath(target));
}
