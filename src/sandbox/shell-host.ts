// Shell 载体发现与跨平台进程执行（docs/windows-mac-compat.md §3）。
// 设计要点：
// - 「载体」与「沙箱」解耦：macOS 由 runtime-tools 走 MacOSSandbox（Seatbelt 是
//   增强而非前提）；本模块只负责"找到可用的 bash 解释器" + 提供无沙箱路径的
//   进程执行/整树终止。安全放行决策（approve 权限 / PAYASO_SHELL_UNSANDBOXED）
//   由 runtime-tools 负责，这里不越权。
// - 平台分支全部支持 options.platform 注入（与 toolchain-manager 同款可测模式）。
// - Windows 固定找 Git for Windows 的 bash.exe；老 WSL（System32\bash.exe）
//   识别后走 bash -s + stdin 通道，避免 argv 转义。
// - 进程树终止：win32 → taskkill /F /T；unix → 进程组 SIGKILL，失败退单进程。

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_SHELL_OUTPUT, SHELL_TIMEOUT_MS } from './macos-sandbox.js';

export interface ShellHost {
  /** 实际平台（注入或 process.platform） */
  platform: NodeJS.Platform;
  /** bash 可执行文件绝对路径 */
  shellPath: string;
  /** 发现来源，用于调试与报错引导 */
  source: 'git-bash' | 'wsl-bash' | 'system-bash' | 'path-bash' | 'sh-fallback';
  /** 老 WSL：需要 bash -s + stdin 传命令 */
  wslLegacy: boolean;
}

export interface ShellHostOptions {
  platform?: NodeJS.Platform;
  /** 测试注入：模拟 %ProgramFiles% / PATH 等 */
  env?: Record<string, string | undefined>;
}

const GIT_BASH_CANDIDATES = (env: Record<string, string | undefined>): string[] => {
  const list: string[] = [];
  // %ProgramFiles%\Git\bin\bash.exe → %ProgramFiles(x86)%\Git\bin\bash.exe
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const base = env[key]?.trim();
    if (base) list.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  }
  return list;
};

const WSL_LEGACY_BASH = 'C:\\Windows\\System32\\bash.exe';

async function lookupInPath(
  name: string,
  env: Record<string, string | undefined>,
  whereCmd: string,
): Promise<string | null> {
  const pathValue = env.PATH ?? '';
  // 先本机 PATH 逐项 existsSync 探测（跨平台、无子进程）；win32 再用 where 兜底
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续 */
    }
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(whereCmd, [name], env);
      const first = String(stdout).trim().split(/\r?\n/)[0];
      if (first) return first;
    } catch {
      /* where 不可用或未命中 */
    }
  }
  return null;
}

function execFileAsync(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { env: env as NodeJS.ProcessEnv, timeout: 15_000 },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * 发现可用的 bash 载体。找不到返回 null（调用方负责引导用户安装）。
 * 平台分支全部可由 options.platform 注入（单测在 macOS 上覆盖三平台逻辑分支）。
 */
export async function discoverShellHost(options: ShellHostOptions = {}): Promise<ShellHost | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform === 'win32') {
    for (const candidate of GIT_BASH_CANDIDATES(env)) {
      if (fs.existsSync(candidate))
        return { platform, shellPath: candidate, source: 'git-bash', wslLegacy: false };
    }
    // 老 WSL：System32\bash.exe → bash -s + stdin
    if (typeof env.SystemRoot === 'string' || fs.existsSync(WSL_LEGACY_BASH)) {
      const wslBash = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'bash.exe');
      if (fs.existsSync(wslBash))
        return { platform, shellPath: wslBash, source: 'wsl-bash', wslLegacy: true };
    }
    const inPath = await lookupInPath('bash.exe', env, 'where');
    if (inPath) return { platform, shellPath: inPath, source: 'path-bash', wslLegacy: false };
    return null;
  }

  // unix（darwin / linux）：/bin/bash → PATH bash → /bin/sh
  if (fs.existsSync('/bin/bash'))
    return { platform, shellPath: '/bin/bash', source: 'system-bash', wslLegacy: false };
  const inPath = await lookupInPath('bash', env, 'which');
  if (inPath) return { platform, shellPath: inPath, source: 'path-bash', wslLegacy: false };
  if (fs.existsSync('/bin/sh'))
    return { platform, shellPath: '/bin/sh', source: 'sh-fallback', wslLegacy: false };
  return null;
}

/**
 * 终止整个进程树（超时 / abort 用）。
 * - win32：taskkill /F /T（taskkill 本身异步执行，不阻塞调用方）
 * - unix：进程组 SIGKILL（需要 spawn 时 detached），失败退回单进程 kill
 */
export function terminateProcessTree(
  pid: number,
  options: { platform?: NodeJS.Platform } = {},
): void {
  // pid 缺失/非法时直接返回：unix 上 kill(-1) 会波及整个进程组（含自己），必须防
  if (!pid || pid <= 0) return;
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    spawn('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }).on(
      'error',
      () => void 0,
    );
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export interface ShellRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 无沙箱路径无权限判定，恒 false（与 MacOSSandboxResult 契约对齐） */
  denied: false;
}

export interface ShellRunOptions {
  cwd: string;
  home: string;
  tmpdir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 测试注入 platform（决定 detached / taskkill 分支），默认 process.platform */
  platform?: NodeJS.Platform;
  // v2.3 增量输出：stdout/stderr 数据到达即回调（后台作业滚动词法缓冲用）。
  onOutput?: (text: string) => void;
}

/**
 * 无沙箱路径的 shell 执行（Windows / Linux），返回契约与 MacOSSandbox.run 一致，
 * 让 runtime-tools 的调用方代码无需分叉。超时 / abort 均整树终止。
 */
export function runUncontainedShell(
  host: ShellHost,
  command: string,
  options: ShellRunOptions,
): Promise<ShellRunResult> {
  const platform = options.platform ?? process.platform;
  const timeout = options.timeoutMs ?? SHELL_TIMEOUT_MS;
  // Windows 不 detached（避免孤儿进程）；unix detached 成进程组以便整树 kill
  const detached = platform !== 'win32';

  return new Promise<ShellRunResult>((resolve, reject) => {
    const args = host.wslLegacy ? ['-s'] : ['-c', command];
    const child = spawn(host.shellPath, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? '',
        HOME: options.home,
        TMPDIR: options.tmpdir,
        LC_ALL: 'C',
      },
      detached,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    if (host.wslLegacy) {
      // 老 WSL：stdin 传命令，避免 argv 中的引号/控制字符被 Windows 层转义
      child.stdin?.end(`${command}\n`);
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid ?? 0, { platform });
    }, timeout);

    const onAbort = (): void => {
      aborted = true;
      terminateProcessTree(child.pid ?? 0, { platform });
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_SHELL_OUTPUT * 4) stdout += String(chunk);
      options.onOutput?.(String(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_SHELL_OUTPUT * 4) stderr += String(chunk);
      options.onOutput?.(String(chunk));
    });

    child.on('error', (err) => {
      settle(() => reject(err));
    });

    child.on('close', (code, signalTerm) => {
      settle(() => {
        if (aborted && (signalTerm !== null || code !== 0)) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        resolve({
          exitCode: code,
          signal: signalTerm ?? null,
          stdout: outputLimit(stdout),
          stderr: outputLimit(stderr),
          timedOut,
          denied: false,
        });
      });
    });
  });
}

function outputLimit(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_SHELL_OUTPUT) return value;
  const buf = Buffer.from(value, 'utf8');
  return `${buf.subarray(0, MAX_SHELL_OUTPUT).toString('utf8')}\n...[输出已截断]`;
}
