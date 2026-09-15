// Shell 载体发现与跨平台进程执行（docs/windows-mac-compat.md §3）。
// 设计要点：
// - 「载体」与「沙箱」解耦：macOS 由 runtime-tools 走 MacOSSandbox（Seatbelt 是
//   增强而非前提）；本模块只负责"找到可用的解释器" + 提供无沙箱路径的
//   进程执行/整树终止。安全放行决策（approve 权限 / PAYASO_SHELL_UNSANDBOXED）
//   由 runtime-tools 负责，这里不越权。
// - **载体运行时族（runtime）是一等概念**：Windows 上并非所有 bash 都能在受限
//   令牌内启动。MSYS2（依赖 msys-2.0.dll）在 DLL 初始化时必须以写访问打开自己的
//   命名信号管道，而 WRITE_RESTRICTED 令牌下命名管道的默认 SD 模板不含 restricting
//   SID → 打开被拒 → STATUS_DLL_INIT_FAILED (0xC0000142)，命令一条都跑不起来；
//   WSL 的 bash.exe 在受限令牌下无法创建服务实例（E_ACCESSDENIED）。
//   因此 ACL 沙箱只接受 runtime==='native' 的原生 PE 载体（见 discoverNativeShellHost）。
// - 平台分支全部支持 options.platform 注入（与 toolchain-manager 同款可测模式）。
// - 进程树终止：win32 → taskkill /F /T；unix → 进程组 SIGKILL，失败退单进程。

import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_SHELL_OUTPUT, SHELL_TIMEOUT_MS } from './macos-sandbox.js';

/** 命令语言族：决定如何把命令字符串交给解释器。 */
export type ShellCarrierKind = 'posix' | 'powershell' | 'cmd';

/**
 * 载体运行时族：决定它能否在 Windows ACL 的 WRITE_RESTRICTED 受限令牌内启动。
 * - native：原生 Windows PE（或 unix 原生），无 Cygwin 运行时依赖 → 可用
 * - msys2：Git for Windows 的 MSYS2 程序（bash.exe / usr\bin\*）→ **不可用**
 * - wsl：legacy WSL 的 bash.exe（Windows 服务实例）→ **不可用**
 */
export type ShellRuntime = 'native' | 'msys2' | 'wsl';

export type ShellHostSource =
  | 'powershell'
  | 'cmd'
  | 'git-bash'
  | 'wsl-bash'
  | 'system-bash'
  | 'path-bash'
  | 'sh-fallback';

export interface ShellHost {
  /** 实际平台（注入或 process.platform） */
  platform: NodeJS.Platform;
  /** 解释器可执行文件绝对路径 */
  shellPath: string;
  /** 发现来源，用于调试与报错引导 */
  source: ShellHostSource;
  /** 命令语言族，决定 argv 形状 */
  carrier: ShellCarrierKind;
  /** 运行时族，决定能否用于受限令牌沙箱 */
  runtime: ShellRuntime;
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

/** Git for Windows 注册表安装路径（InstallPath 指向安装根，如 D:\Git\Git）。 */
const GIT_FOR_WINDOWS_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\GitForWindows',
  'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
];

/**
 * 系统根目录（%SystemRoot%）。
 *
 * **测试注入 fake env 时绝不回落到宿主真实的 `C:\Windows`** —— 否则探测会穿出
 * fake env 去命中跑测机器上的真实文件，测试结果随"跑测机装了什么"变化（假绿/假红）。
 * 真实运行下 `process.env` 恒有 SystemRoot，回落分支只服务极少数残缺环境，
 * 因此用 `env === process.env` 作为"这是真实环境吗"的判据（与 registryGitBashCandidates 同款）。
 */
function systemRootOf(env: Record<string, string | undefined>): string | null {
  const fromEnv = env.SystemRoot?.trim();
  if (fromEnv) return fromEnv;
  return env === process.env ? 'C:\\Windows' : null;
}

/** 原生 PE 载体：PowerShell（唯一在所有支持版本上都存在的原生 shell）。 */
const POWERSHELL_CANDIDATES = (env: Record<string, string | undefined>): string[] => {
  const root = systemRootOf(env);
  if (!root) return [];
  return [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    // 少数环境下 System32 被重定向（如 32 位宿主探测），补 PowerShell 原生目录
    path.join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
};

/**
 * 读取 Git for Windows 的注册表安装路径。
 * 仅在"真实 env + 真实 win32"下执行 —— 测试注入 fake env 时绝不触碰真实注册表，
 * 否则测试结果会依赖跑测机器上装没装 Git（假绿/假红）。
 */
function registryGitBashCandidates(env: Record<string, string | undefined>): string[] {
  if (process.platform !== 'win32' || env !== process.env) return [];
  const found: string[] = [];
  for (const key of GIT_FOR_WINDOWS_REGISTRY_KEYS) {
    try {
      const result = execFileSyncSafe('reg.exe', ['query', key, '/v', 'InstallPath']);
      const installPath = /InstallPath\s+REG_SZ\s+(.+)/.exec(result)?.[1]?.trim();
      if (installPath) found.push(path.join(installPath, 'bin', 'bash.exe'));
    } catch {
      /* 键不存在或 reg 不可用 */
    }
  }
  return found;
}

function execFileSyncSafe(cmd: string, args: string[]): string {
  // 同步是刻意的：载体发现发生在执行前的一次性路径上，且本函数只在真实 win32
  // 环境下被调用；timeout 防止 reg 挂起拖住启动。
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  if (res.error || res.status !== 0) throw new Error('reg query failed');
  return String(res.stdout);
}

async function lookupInPath(
  name: string,
  env: Record<string, string | undefined>,
  whereCmd: string,
): Promise<string | null> {
  const pathValue = env.PATH ?? '';
  // 先本机 PATH 逐项 existsSync 探测（跨平台、无子进程）；win32 再用 where 兜底。
  // where 兜底只在**真实 env** 下走：注入 fake env 时拉起子进程既无意义（PATH 已逐项扫过）
  // 又会让结果掺入宿主状态，破坏测试确定性（与 systemRootOf 同一原则）。
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续 */
    }
  }
  if (process.platform === 'win32' && env === process.env) {
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
 * 发现可用的 POSIX bash 载体（无沙箱路径用）。找不到返回 null（调用方负责引导安装）。
 * 平台分支全部可由 options.platform 注入（单测在 macOS 上覆盖三平台逻辑分支）。
 *
 * win32 顺序（自 2026-09-14 真机验收修订）：
 *   ProgramFiles\Git → ProgramFiles(x86)\Git → 注册表 InstallPath → PATH bash.exe → legacy WSL
 * 修订原因：原顺序把 legacy WSL 排在 PATH 之前。只要机器装了 WSL，
 * `System32\bash.exe` 就先命中，装了 Git for Windows（尤其在非默认路径）也永远选不到它；
 * 而 WSL 在受限令牌下不可用（E_ACCESSDENIED）。Git Bash 的可用面严格大于 WSL。
 */
export async function discoverShellHost(options: ShellHostOptions = {}): Promise<ShellHost | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform === 'win32') {
    const gitCandidates = [
      ...GIT_BASH_CANDIDATES(env),
      ...registryGitBashCandidates(env),
    ];
    for (const candidate of gitCandidates) {
      if (fs.existsSync(candidate))
        return {
          platform,
          shellPath: candidate,
          source: 'git-bash',
          carrier: 'posix',
          runtime: 'msys2',
        };
    }
    const inPath = await lookupInPath('bash.exe', env, 'where');
    if (inPath)
      return {
        platform,
        shellPath: inPath,
        source: 'path-bash',
        carrier: 'posix',
        // PATH 上的 bash.exe 在 Windows 上几乎总是 Git for Windows 的 MSYS2 程序；
        // 保守判为 msys2（不可用于 ACL 沙箱），宁可 fail-closed 也不放行错载体。
        runtime: 'msys2',
      };
    // 老 WSL：System32\bash.exe → bash -s + stdin（放在 Git Bash 与 PATH 之后）
    // 路径严格由 env.SystemRoot 派生：绝不硬编码 C:\Windows，
    // 否则注入 fake env 的测试会命中跑测机上的真实 WSL（见 systemRootOf 注释）。
    const root = systemRootOf(env);
    if (root) {
      const wslBash = path.join(root, 'System32', 'bash.exe');
      if (fs.existsSync(wslBash))
        return {
          platform,
          shellPath: wslBash,
          source: 'wsl-bash',
          carrier: 'posix',
          runtime: 'wsl',
        };
    }
    return null;
  }

  // unix（darwin / linux）：/bin/bash → PATH bash → /bin/sh
  if (fs.existsSync('/bin/bash'))
    return { platform, shellPath: '/bin/bash', source: 'system-bash', carrier: 'posix', runtime: 'native' };
  const inPath = await lookupInPath('bash', env, 'which');
  if (inPath)
    return { platform, shellPath: inPath, source: 'path-bash', carrier: 'posix', runtime: 'native' };
  if (fs.existsSync('/bin/sh'))
    return { platform, shellPath: '/bin/sh', source: 'sh-fallback', carrier: 'posix', runtime: 'native' };
  return null;
}

/**
 * 发现可用于 **Windows ACL 受限令牌沙箱** 的原生 PE 载体。
 *
 * 为什么必须单独一个函数：ACL 沙箱只接受 runtime==='native' 的载体 —— MSYS2 与 WSL
 * 载体在受限令牌下必然在 DLL 初始化阶段死亡（见文件头注释），不是配置问题。
 * 因此这里刻意**不**回落到 bash，宁可返回 null 让上层 fail-closed 并给出准确诊断。
 *
 * 顺序：PowerShell → cmd.exe。两者都是原生 PE。
 * 非 win32 返回 null（ACL 沙箱本身是 win32 专用）。
 */
export async function discoverNativeShellHost(
  options: ShellHostOptions = {},
): Promise<ShellHost | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return null;
  const env = options.env ?? process.env;

  for (const candidate of POWERSHELL_CANDIDATES(env)) {
    if (fs.existsSync(candidate))
      return {
        platform,
        shellPath: candidate,
        source: 'powershell',
        carrier: 'powershell',
        runtime: 'native',
      };
  }
  const root = systemRootOf(env);
  if (!root) return null;
  const cmdPath = path.join(root, 'System32', 'cmd.exe');
  if (fs.existsSync(cmdPath))
    return { platform, shellPath: cmdPath, source: 'cmd', carrier: 'cmd', runtime: 'native' };
  return null;
}

/**
 * 命令调用形状：`[exe, ...args]`，由载体语言与运行时共同决定。
 * - posix + WSL(legacy)：`['-s']`，命令经 stdin 传入（避免 Windows 层转义 argv）
 * - posix + 其他：`['-c', command]`
 * - powershell：`['-NoProfile', '-NonInteractive', '-Command', command]`
 *   （`-c` 是 `-Command` 的合法缩写，但显式写全长更不易被误读）
 * - cmd：`['/d', '/s', '/c', command]`
 */
export function buildShellInvocation(host: ShellHost, command: string): string[] {
  switch (host.carrier) {
    case 'powershell':
      return [host.shellPath, '-NoProfile', '-NonInteractive', '-Command', command];
    case 'cmd':
      return [host.shellPath, '/d', '/s', '/c', command];
    case 'posix':
      return host.runtime === 'wsl' ? [host.shellPath, '-s'] : [host.shellPath, '-c', command];
  }
}

/** 该载体是否把命令经 stdin 传入（legacy WSL），而非 argv。 */
export function usesStdinCommand(host: ShellHost): boolean {
  return host.carrier === 'posix' && host.runtime === 'wsl';
}

/**
 * 该载体能否在 Windows ACL 的 WRITE_RESTRICTED 受限令牌内启动。
 * 只有 native 可以 —— msys2/wsl 必然在 DLL 初始化或服务实例创建阶段失败。
 */
export function isAclCompatibleCarrier(host: ShellHost): boolean {
  return host.runtime === 'native';
}

/** Windows ACL 实验开关的环境变量名（gate）。单一来源，避免各处硬编码字符串不一致。 */
export const WINDOWS_ACL_GATE_ENV = 'PAYASO_SHELL_WINDOWS_ACL';

/** Windows ACL 实验开关是否打开。 */
export function isWindowsAclEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[WINDOWS_ACL_GATE_ENV] === '1';
}

/**
 * 当前平台 shell 实际使用的**命令语言**，用于写入环境上下文提示词。
 *
 * 存在这个函数的原因：Windows 上语言不是固定的 —— ACL 沙箱（gate 开）只能用
 * 原生 PE 载体，因此是 PowerShell；无沙箱路径（gate 关）走 Git Bash，是 POSIX。
 * 模型必须知道这一点，否则会写出另一种语言里语法不通的命令（例如 PowerShell 5.1
 * 不支持 `&&` 串联）。宁可把差异显式告诉模型，也不让它盲猜。
 */
export function describeShellLanguage(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === 'darwin') return 'bash (POSIX) under macOS Seatbelt';
  if (platform === 'win32') {
    return isWindowsAclEnabled(env)
      ? 'PowerShell (Windows ACL sandbox; native PE carrier)'
      : 'bash (POSIX, Git Bash) when PAYASO_SHELL_UNSANDBOXED=1';
  }
  return 'bash (POSIX) when PAYASO_SHELL_UNSANDBOXED=1';
}

/** ACL 沙箱遇到不兼容载体时的准确诊断（不要误导用户去"安装 Git for Windows"）。 */
export function describeAclIncompatibleCarrier(host: ShellHost): string {
  const reason =
    host.runtime === 'msys2'
      ? 'MSYS2/Cygwin 运行时在 DLL 初始化时必须以写访问打开自己的命名信号管道；' +
        'WRITE_RESTRICTED 受限令牌下命名管道的默认安全描述符模板不携带 restricting SID，' +
        '该打开被拒绝（Win32 error 5），进程以 STATUS_DLL_INIT_FAILED (0xC0000142) 退出——' +
        '在任何命令执行之前。这是后端固有属性，改安装路径或发现顺序都无效。'
      : 'legacy WSL 的 bash.exe 在受限令牌下无法创建 WSL 服务实例（Bash/Service/CreateInstance/E_ACCESSDENIED）。';
  return (
    `Windows ACL sandbox cannot use the discovered shell carrier (${host.source}: ${host.shellPath}). ` +
    `${reason} ` +
    'The ACL executor requires a native Windows PE carrier (PowerShell).'
  );
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
  const stdinCommand = usesStdinCommand(host);

  return new Promise<ShellRunResult>((resolve, reject) => {
    const invocation = buildShellInvocation(host, command);
    const child = spawn(invocation[0], invocation.slice(1), {
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

    if (stdinCommand) {
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
