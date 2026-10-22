// 模块: Shell Executor — 统一 Shell 执行入口与平台选择（跨平台沙箱改造）
// 设计（docs/sandbox/cross-platform-sandbox-plan.md §2）：
// - 「工具语义」「载体」「沙箱」三层解耦：runtime-tools 只管 scratch 生命周期与
//   denied/缺失工具等工具层错误语义；本模块负责"在哪个平台用哪种执行器跑命令"。
// - darwin → macOS Seatbelt（行为与既有版本完全一致，自 runtime-tools 原样搬运）
// - win32 且 PAYASO_SHELL_WINDOWS_ACL=1 → Windows ACL 受限令牌执行器（步骤 2 接入；
//   enforcement=partial：写入部分隔离，读与网络不受限——能力报告必须如实标注）
// - 其余（含 gate 关闭的 win32、linux）→ PAYASO_SHELL_UNSANDBOXED 门控的无沙箱路径
// - fail-closed 贯穿：沙箱不可用即拒绝执行，绝不静默降级到无沙箱。
// - 原生 process 入口 executeSandboxedProcess（check 协议，计划 §5.2）：复用上面
//   全套平台选择 / 工作区授权 / 受管 scratch / 网络策略 / 整树终止，唯一区别是
//   执行目标是「程序 + 字面 argv 数组」，永远不构造脚本；并额外提供截断前的
//   原始带流标记 chunk 回调。旧 Shell 接口与行为保持不变。

import fs from 'node:fs';
import { getNetworkMode, type NetworkMode } from '../network-mode.js';
import { type PermissionMode, storedPermissionMode } from '../permission-mode.js';
import { RequiredRuntimeToolUnavailableError, type ToolSandboxEvent } from '../tools/tools.js';
import {
  MacOSSandbox,
  type MacOSSandboxResult,
  type ProcessOutputStream,
  probeSandboxAvailability,
} from './macos-sandbox.js';
import {
  discoverNativeShellHost,
  discoverShellHost,
  isWindowsAclEnabled,
  lookupExecutableInPath,
  runUncontainedProcess,
  runUncontainedShell,
} from './shell-host.js';
import type { ShellScratch } from './shell-scratch.js';
import { getMacOSToolchain } from './toolchain-manager.js';
import { runWindowsAclProcess, runWindowsAclShell } from './windows-acl-sandbox.js';

/** 执行器种类（决定 enforcement 与能力报告）。 */
export type ShellExecutorKind = 'macos-seatbelt' | 'windows-acl' | 'uncontained-gated';

/** 隔离完整度：full=全部承诺的文件效应都被治理；partial=部分写入隔离；none=无 OS 级遏制。 */
export type ShellEnforcement = 'full' | 'partial' | 'none';

/**
 * Shell 隔离能力报告（诚实分级，方案文档 §3：partial 必须在 Host/Web 可见，
 * 无法兑现的权限要求明确返回不可用，不静默放宽）。
 * - writeIsolation：写入边界治理程度（ACL 的 Everyone/NTFS 硬链接例外 → partial）
 * - readIsolation：读取边界（ACL 受限令牌不限制读取 → none；Seatbelt 限制 readableRoots → full）
 * - networkIsolation：网络开关能否在 OS 层强制（ACL 不限制网络 → none；
 *   network.mode=off 时全局拒绝 shell，但那是 Host 层拒绝，不是 OS 隔离）
 */
export interface ShellIsolationCapabilities {
  executor: ShellExecutorKind;
  enforcement: ShellEnforcement;
  writeIsolation: 'full' | 'partial' | 'none';
  readIsolation: 'full' | 'none';
  networkIsolation: 'os-level' | 'none';
}

/** 当前平台实际的 Shell 隔离能力（纯函数，platform/env 可注入）。 */
export function shellIsolationCapabilities(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): ShellIsolationCapabilities {
  const executor = selectShellExecutor(platform, env);
  switch (executor) {
    case 'macos-seatbelt':
      return {
        executor,
        enforcement: 'full',
        writeIsolation: 'full',
        readIsolation: 'full',
        networkIsolation: 'os-level',
      };
    case 'windows-acl':
      return {
        executor,
        enforcement: 'partial',
        writeIsolation: 'partial',
        readIsolation: 'none',
        networkIsolation: 'none',
      };
    case 'uncontained-gated':
      return {
        executor,
        enforcement: 'none',
        writeIsolation: 'none',
        readIsolation: 'none',
        networkIsolation: 'none',
      };
  }
}

export interface ShellExecuteRequest {
  command: string;
  workspaceRoot: string;
  permissionMode?: PermissionMode;
  /** Run 注入的网络模式；缺省回退全局 getNetworkMode()（与既有行为一致）。 */
  networkMode?: NetworkMode;
  /** 受管 scratch（HOME/TMPDIR，所有权限模式下可写、workspace 外）；生命周期归调用方。 */
  scratch: ShellScratch;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 平台注入（测试）；缺省 process.platform。 */
  platform?: NodeJS.Platform;
  onOutput?: (text: string) => void;
  onSandboxEvent?: (event: ToolSandboxEvent) => void;
}

export type ShellExecuteResult = MacOSSandboxResult & {
  executor: ShellExecutorKind;
  enforcement: ShellEnforcement;
};

/**
 * 选择当前平台使用的 Shell 执行器。纯函数（平台与 env 均可注入）：
 * - darwin：Seatbelt（唯一候选，probe 在执行时做 fail-closed 拒绝）
 * - win32 + PAYASO_SHELL_WINDOWS_ACL=1：Windows ACL 受限令牌（部分写入隔离）
 * - 其余：无沙箱门控路径（PAYASO_SHELL_UNSANDBOXED 未设即拒绝）
 */
export function selectShellExecutor(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): ShellExecutorKind {
  if (platform === 'darwin') return 'macos-seatbelt';
  if (platform === 'win32' && isWindowsAclEnabled(env)) return 'windows-acl';
  return 'uncontained-gated';
}

export async function executeShellCommand(
  request: ShellExecuteRequest,
): Promise<ShellExecuteResult> {
  const kind = selectShellExecutor(request.platform ?? process.platform);
  if (kind === 'macos-seatbelt') return executeSeatbelt(request);
  if (kind === 'windows-acl') return executeWindowsAcl(request);
  return executeUncontainedGated(request);
}

// ---- 原生 process 入口（check 协议，计划 §5.2）----
// 与 Shell 入口共享**同一套**平台选择、工作区授权、受管 scratch、网络策略与
// 整树终止；唯一区别是执行目标：这里给出程序 + 字面 argv，永远不构造脚本。
// 授权 → 执行意图持久化 → 执行 → 结果记录 → Checkpoint 的顺序由调用方
// （Runtime 的工具调用管线）负责，本模块不引入任何新的时序或旁路。

/** 原生进程入口的执行请求（program 为可执行名，或已授权解析出的绝对路径）。 */
export interface SandboxedProcessRequest {
  /** 可执行名称（按执行器 PATH 解析）或已解析的绝对程序路径。绝不拼接成脚本。 */
  program: string;
  /** 字面参数数组：每一项原样到达子进程，`|`/`;`/`$`/引号都不被解释。 */
  args: string[];
  workspaceRoot: string;
  /** 子进程 cwd；缺省 = workspaceRoot。必须在工作区内（由沙箱强制）。 */
  cwd?: string;
  permissionMode?: PermissionMode;
  /** Run 注入的网络模式；与 Shell 完全一致（网络能力不变）。 */
  networkMode?: NetworkMode;
  /** 受管 scratch（HOME/TMPDIR，所有权限模式下可写、workspace 外）；生命周期归调用方。 */
  scratch: ShellScratch;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 平台注入（测试）；缺省 process.platform。 */
  platform?: NodeJS.Platform;
  /** 原始带流标记 chunk：在底层截断之前采集（完整日志的唯一来源）。 */
  onRawChunk?: (stream: ProcessOutputStream, chunk: Buffer) => void;
  /** 旧 Shell 增量回调形状保持不变（live 预览用），可选。 */
  onOutput?: (text: string) => void;
  onSandboxEvent?: (event: ToolSandboxEvent) => void;
}

export type SandboxedProcessResult = MacOSSandboxResult & {
  executor: ShellExecutorKind;
  enforcement: ShellEnforcement;
  /** 实际执行的绝对程序路径（写入事实，便于复核"跑的是哪个程序"）。 */
  resolvedProgram: string;
};

export async function executeSandboxedProcess(
  request: SandboxedProcessRequest,
): Promise<SandboxedProcessResult> {
  const kind = selectShellExecutor(request.platform ?? process.platform);
  if (kind === 'macos-seatbelt') return executeSeatbeltProcess(request);
  if (kind === 'windows-acl') return executeWindowsAclProcess(request);
  return executeUncontainedGatedProcess(request);
}

/**
 * 把 program 解析成绝对路径。两条规则刻意与 Shell 一致地保守：
 * - 带目录分隔符 → 视为调用方（工具层）已完成工作区授权解析的路径，必须存在且是文件；
 * - 纯名字 → 在**子进程实际使用的 PATH**里查找（Seatbelt 用工具链 safePath，
 *   无沙箱路径用宿主 PATH）。找不到即 RequiredRuntimeToolUnavailableError：
 *   结构与 Shell 的"命令缺失"同源，可由 Host 走依赖准备，绝不静默换执行方式。
 */
function resolveProcessProgram(
  program: string,
  pathValue: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (program.includes('/') || program.includes('\\')) {
    // 带目录分隔符：调用方（工具层）已把工作区相对路径解析成真实路径，
    // 这里只做存在性复检 —— 不存在/不是文件同样是"依赖缺失"的分类。
    let isFile = false;
    try {
      isFile = fs.statSync(program).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) throw new RequiredRuntimeToolUnavailableError(program);
    return program;
  }
  const found = lookupExecutableInPath(program, pathValue, { platform, env });
  if (!found) throw new RequiredRuntimeToolUnavailableError(program);
  return found;
}

async function executeSeatbeltProcess(
  request: SandboxedProcessRequest,
): Promise<SandboxedProcessResult> {
  if (!(await probeSandboxAvailability())) {
    throw new Error(
      'Process check unavailable: macOS OS sandbox (sandbox-exec) cannot be applied on this system ' +
        '(sandbox_apply: Operation not permitted). Refusing to run an unsandboxed process to preserve ' +
        'filesystem containment.',
    );
  }
  const networkAccess = (request.networkMode ?? getNetworkMode()) === 'on';
  const sandbox = MacOSSandbox.forWorkspace(
    request.workspaceRoot,
    storedPermissionMode(request.permissionMode),
    networkAccess,
    { scratchRoots: [request.scratch.path] },
  );
  const resolvedProgram = resolveProcessProgram(
    request.program,
    getMacOSToolchain().safePath,
    'darwin',
  );
  const result = await sandbox.runProcess([resolvedProgram, ...request.args], {
    cwd: request.cwd ?? request.workspaceRoot,
    home: request.scratch.path,
    tmpdir: request.scratch.path,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    onOutput: request.onOutput,
    onRawChunk: request.onRawChunk,
    onEvent: (event) => {
      if (event === 'started') {
        request.onSandboxEvent?.({ type: 'shell_sandbox_started', platform: 'macos' });
      } else {
        request.onSandboxEvent?.({
          type: 'shell_sandbox_denied',
          platform: 'macos',
          reason: 'workspace_policy',
        });
      }
    },
  });
  return { ...result, executor: 'macos-seatbelt', enforcement: 'full', resolvedProgram };
}

async function executeUncontainedGatedProcess(
  request: SandboxedProcessRequest,
): Promise<SandboxedProcessResult> {
  if (process.env.PAYASO_SHELL_UNSANDBOXED !== '1') {
    throw new Error(
      'Process check unavailable on this platform: 当前平台无 macOS OS Sandbox，' +
        '为保持文件系统遏制默认拒绝。请设置 PAYASO_SHELL_UNSANDBOXED=1 ' +
        '显式允许无沙箱执行后重试（默认关闭）。',
    );
  }
  const platform = request.platform ?? process.platform;
  const resolvedProgram = resolveProcessProgram(request.program, process.env.PATH ?? '', platform);
  const result = await runUncontainedProcess([resolvedProgram, ...request.args], {
    cwd: request.cwd ?? request.workspaceRoot,
    home: request.scratch.path,
    tmpdir: request.scratch.path,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    platform,
    onOutput: request.onOutput,
    onRawChunk: request.onRawChunk,
  });
  return { ...result, executor: 'uncontained-gated', enforcement: 'none', resolvedProgram };
}

async function executeWindowsAclProcess(
  request: SandboxedProcessRequest,
): Promise<SandboxedProcessResult> {
  if (request.cwd && request.cwd !== request.workspaceRoot) {
    // 不静默放宽：现有薄 runner 固定以 workspace 为子进程 cwd，且 runner 不在本
    // 批次可改范围内。宁可明确报错让调用方改 cwd='.'，也不悄悄换个工作目录跑检查。
    throw new Error(
      `Windows ACL process check supports cwd = workspace root only (got a subdirectory). ` +
        `Re-run with cwd="." or use the shell tool; runner --cwd support is a follow-up.`,
    );
  }
  if (storedPermissionMode(request.permissionMode) === 'full-access') {
    if (process.env.PAYASO_SHELL_UNSANDBOXED !== '1') {
      throw new Error(
        'Windows ACL does not support Full access. Explicitly enable PAYASO_SHELL_UNSANDBOXED=1 or choose Workspace write.',
      );
    }
    return executeUncontainedGatedProcess(request);
  }
  const resolvedProgram = resolveProcessProgram(request.program, process.env.PATH ?? '', 'win32');
  const result = await runWindowsAclProcess([resolvedProgram, ...request.args], {
    workspaceRoot: request.workspaceRoot,
    scratchPath: request.scratch.path,
    permissionMode: request.permissionMode,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    onOutput: request.onOutput,
    onRawChunk: request.onRawChunk,
  });
  if (result.execution !== 'completed') {
    const state =
      result.execution === 'not_started'
        ? 'the process was not executed'
        : 'execution outcome is unknown; the process may have run; inspect effects before retrying';
    throw new Error(
      `Windows ACL sandbox runner failed; ${state}. ${result.runnerFailure ?? 'Runner exited without a completion report.'}`,
    );
  }
  if (result.cleanupErrors.length) {
    result.stderr += `\nWindows ACL cleanup failed: ${result.cleanupErrors.join('; ')}`;
  }
  request.onSandboxEvent?.({
    type: 'shell_sandbox_started',
    platform: 'windows',
    enforcement: 'partial',
  });
  return { ...result, executor: 'windows-acl', enforcement: 'partial', resolvedProgram };
}

// ---- darwin：macOS Seatbelt（自 runtime-tools executeContainedShell 原样搬运）----

async function executeSeatbelt(request: ShellExecuteRequest): Promise<ShellExecuteResult> {
  if (!(await probeSandboxAvailability())) {
    throw new Error(
      'Shell tool unavailable: macOS OS sandbox (sandbox-exec) cannot be applied on this system ' +
        '(sandbox_apply: Operation not permitted). Refusing to run an unsandboxed shell to preserve ' +
        'filesystem containment.',
    );
  }
  // v1.10 回归修复：运行时注入 networkMode；测试/CLI 缺省时回退全局
  // getNetworkMode()（默认 on）。若按 undefined 判为 off，沙箱 profile 加
  // (deny network*)，会连带拦截 AF_UNIX socket 创建 → tsx/npx listen EPERM。
  const networkAccess = (request.networkMode ?? getNetworkMode()) === 'on';
  const sandbox = MacOSSandbox.forWorkspace(
    request.workspaceRoot,
    storedPermissionMode(request.permissionMode),
    networkAccess,
    { scratchRoots: [request.scratch.path] },
  );
  const result = await sandbox.run(request.command, {
    cwd: request.workspaceRoot,
    home: request.scratch.path,
    tmpdir: request.scratch.path,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    onOutput: request.onOutput,
    onEvent: (event) => {
      if (event === 'started') {
        request.onSandboxEvent?.({ type: 'shell_sandbox_started', platform: 'macos' });
      } else {
        request.onSandboxEvent?.({
          type: 'shell_sandbox_denied',
          platform: 'macos',
          reason: 'workspace_policy',
        });
      }
    },
  });
  return { ...result, executor: 'macos-seatbelt', enforcement: 'full' };
}

// ---- 其他平台：无沙箱门控路径（PAYASO_SHELL_UNSANDBOXED 显式放行才可用）----

async function executeUncontainedGated(request: ShellExecuteRequest): Promise<ShellExecuteResult> {
  if (process.env.PAYASO_SHELL_UNSANDBOXED !== '1') {
    throw new Error(
      'Shell unavailable on this platform: 当前平台无 macOS OS Sandbox，' +
        '为保持文件系统遏制默认拒绝。请设置 PAYASO_SHELL_UNSANDBOXED=1 ' +
        '显式允许无沙箱 shell 后重试（默认关闭）。',
    );
  }
  const host = await discoverShellHost();
  if (!host) {
    throw new Error(
      'Shell unavailable: 未找到 bash 解释器。Windows 请安装 Git for Windows ' +
        '(https://git-scm.com) 后重试。',
    );
  }
  const result = await runUncontainedShell(host, request.command, {
    cwd: request.workspaceRoot,
    home: request.scratch.path,
    tmpdir: request.scratch.path,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    onOutput: request.onOutput,
  });
  return { ...result, executor: 'uncontained-gated', enforcement: 'none' };
}

// ---- win32：Windows ACL 受限令牌执行器（gate：PAYASO_SHELL_WINDOWS_ACL=1）----
// enforcement=partial：写入部分隔离（Everyone 与 NTFS 硬链接例外），读取与网络
// 不受限；能力报告必须如实标注，不静默放宽权限语义（方案文档 §3）。

async function executeWindowsAcl(request: ShellExecuteRequest): Promise<ShellExecuteResult> {
  // 三种权限都进受限令牌。full-access 不在这里拒绝，也不走无沙箱开关；
  // runner 会换一份 restricting SID 列表。见 windows-full-access-token-plan.md。
  // 载体必须是原生 PE（runtime==='native'）：MSYS2 bash 与 WSL bash 在
  // WRITE_RESTRICTED 受限令牌下都必然失败，详见 shell-host.ts 文件头。
  // 因此这里刻意走 discoverNativeShellHost（PowerShell → cmd），而不是 discoverShellHost。
  const host = await discoverNativeShellHost();
  if (!host) {
    throw new Error(
      'Windows ACL sandbox unavailable: no native Windows shell carrier found ' +
        '(expected PowerShell at %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe). ' +
        'The ACL executor cannot fall back to Git Bash or WSL: both die during DLL initialization ' +
        'under the WRITE_RESTRICTED restricted token, before any command runs.',
    );
  }
  const result = await runWindowsAclShell(host, request.command, {
    workspaceRoot: request.workspaceRoot,
    scratchPath: request.scratch.path,
    permissionMode: request.permissionMode,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    onOutput: request.onOutput,
  });
  if (result.execution !== 'completed') {
    const state =
      result.execution === 'not_started'
        ? 'the command was not executed'
        : 'execution outcome is unknown; the command may have run; inspect effects before retrying';
    throw new Error(
      `Windows ACL sandbox runner failed; ${state}. ${result.runnerFailure ?? 'Runner exited without a completion report.'}`,
    );
  }
  if (result.cleanupErrors.length) {
    result.stderr += `\nWindows ACL cleanup failed: ${result.cleanupErrors.join('; ')}`;
  }
  // 事件在执行成功后发出（post-hoc）：与 macOS 的 spawn 时刻不同 —— runner 内部
  // 无法观测受限子进程的启动时刻，而 runner 失败时绝不能宣称"沙箱已应用"。
  request.onSandboxEvent?.({
    type: 'shell_sandbox_started',
    platform: 'windows',
    enforcement: 'partial',
  });
  return { ...result, executor: 'windows-acl', enforcement: 'partial' };
}
