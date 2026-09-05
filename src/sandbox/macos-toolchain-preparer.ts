// macOS Host-level toolchain preparation.
//
// This module is intentionally not called from the Shell Sandbox. Installing a
// package manager formula must write to the user's package-manager area, so it
// is a separate, explicit Host capability that is reached only after a UI/Host
// approval. The command is argv-based and selected from a fixed plan; no model
// command or path is passed to the installer.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshMacOSToolchain } from './toolchain-manager.js';
import type {
  ToolchainPreparationObserver,
  ToolchainPreparationPlan,
  ToolchainPreparationResult,
} from './toolchain-preparation.js';

const HOMEBREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'] as const;
const PREPARATION_TIMEOUT_MS = 180_000;
// 安装前磁盘门槛：低于此值明确失败，而不是装到一半磁盘写满留下残留
export const MIN_INSTALL_FREE_BYTES = 512 * 1024 * 1024;

// 安装前检查：目标目录所在卷剩余空间是否充足。
// statfs 不可用/失败时返回 true（不阻塞安装；后续安装失败本身会给出结果）。
export function hasSufficientDiskSpace(
  directory: string,
  minFreeBytes: number = MIN_INSTALL_FREE_BYTES,
): boolean {
  try {
    const stats = fs.statfsSync(directory);
    return stats.bavail * stats.bsize >= minFreeBytes;
  } catch {
    return true;
  }
}

function executableAt(candidate: string): string | undefined {
  try {
    if (!fs.statSync(candidate).isFile()) return undefined;
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.realpathSync.native(candidate);
  } catch {
    return undefined;
  }
}

function homebrewExecutable(): string | undefined {
  for (const candidate of HOMEBREW_CANDIDATES) {
    const executable = executableAt(candidate);
    if (executable !== undefined) return executable;
  }
  return undefined;
}

function preparationMessage(status: ToolchainPreparationResult['status']): string {
  switch (status) {
    case 'unavailable':
      return 'No supported macOS package manager is available for this dependency.';
    case 'aborted':
      return 'Dependency preparation was cancelled.';
    case 'timed_out':
      return 'Dependency preparation timed out. Review the host package manager and try again.';
    case 'failed':
      return 'Dependency preparation failed. Review the host package manager and try again.';
    default:
      return 'Dependency preparation was not completed.';
  }
}

/**
 * Prepare one allowlisted macOS tool. The caller is responsible for obtaining
 * user approval before entering this function.
 */
export async function prepareMacOSToolchain(
  plan: ToolchainPreparationPlan,
  signal?: AbortSignal,
  onPhase?: ToolchainPreparationObserver,
): Promise<ToolchainPreparationResult> {
  if (process.platform !== 'darwin') {
    return {
      approved: true,
      prepared: false,
      status: 'unavailable',
      message: preparationMessage('unavailable'),
    };
  }

  const brew = homebrewExecutable();
  if (brew === undefined) {
    return {
      approved: true,
      prepared: false,
      status: 'unavailable',
      message: preparationMessage('unavailable'),
    };
  }
  if (signal?.aborted) {
    return {
      approved: true,
      prepared: false,
      status: 'aborted',
      message: preparationMessage('aborted'),
    };
  }

  const brewDirectory = path.dirname(brew);

  // 安装前检查：磁盘空间不足 → 明确失败，而不是装到一半写满磁盘留下残留
  if (!hasSufficientDiskSpace(brewDirectory)) {
    return {
      approved: true,
      prepared: false,
      status: 'unavailable',
      message: `Insufficient disk space on the Homebrew volume (need at least ${Math.round(MIN_INSTALL_FREE_BYTES / (1024 * 1024))} MB free).`,
    };
  }

  const home = process.env.HOME;
  const env: NodeJS.ProcessEnv = {
    // Keep the installer environment small and deterministic. In particular,
    // do not forward API keys or arbitrary model-provided environment values.
    PATH: [brewDirectory, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    ...(home ? { HOME: home } : {}),
    TMPDIR: os.tmpdir(),
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    HOMEBREW_NO_AUTO_UPDATE: '1',
    HOMEBREW_NO_INSTALL_CLEANUP: '1',
    CI: '1',
  };

  onPhase?.('installing');
  const result = await new Promise<{
    status: number | null;
    aborted: boolean;
    timedOut: boolean;
  }>((resolve) => {
    let child: ReturnType<typeof spawn>;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: { status: number | null; aborted: boolean }) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ...value, timedOut: false });
    };
    const kill = () => {
      if (child?.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }, 500).unref?.();
    };
    const onAbort = () => {
      kill();
      settle({ status: null, aborted: true });
    };
    timer = setTimeout(() => {
      kill();
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve({ status: null, aborted: false, timedOut: true });
    }, PREPARATION_TIMEOUT_MS);
    timer.unref?.();
    try {
      child = spawn(brew, ['install', plan.packageName], {
        cwd: os.tmpdir(),
        env,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.once('error', () => settle({ status: null, aborted: false }));
      child.once('exit', (status) => settle({ status, aborted: false }));
    } catch {
      settle({ status: null, aborted: false });
    }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  if (result.aborted) {
    return {
      approved: true,
      prepared: false,
      status: 'aborted',
      message: preparationMessage('aborted'),
    };
  }
  if (result.timedOut) {
    return {
      approved: true,
      prepared: false,
      status: 'timed_out',
      message: preparationMessage('timed_out'),
    };
  }
  if (result.status !== 0) {
    return {
      approved: true,
      prepared: false,
      status: 'failed',
      message: preparationMessage('failed'),
    };
  }

  // Refresh only after the fixed installer succeeds. Existing Sandbox objects
  // keep their original policy; future Shell calls/new Runs see the snapshot.
  onPhase?.('verifying');
  const refreshed = refreshMacOSToolchain();
  const available = refreshed.tools[plan.toolName]?.source !== 'missing';
  return available
    ? { approved: true, prepared: true, status: 'prepared' }
    : { approved: true, prepared: false, status: 'failed', message: preparationMessage('failed') };
}
