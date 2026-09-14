// 模块: Shell Executor — 统一 Shell 执行入口与平台选择（跨平台沙箱改造）
// 设计（docs/cross-platform-sandbox-plan.md §2）：
// - 「工具语义」「载体」「沙箱」三层解耦：runtime-tools 只管 scratch 生命周期与
//   denied/缺失工具等工具层错误语义；本模块负责"在哪个平台用哪种执行器跑命令"。
// - darwin → macOS Seatbelt（行为与既有版本完全一致，自 runtime-tools 原样搬运）
// - win32 且 PAYASO_SHELL_WINDOWS_ACL=1 → Windows ACL 受限令牌执行器（步骤 2 接入；
//   enforcement=partial：写入部分隔离，读与网络不受限——能力报告必须如实标注）
// - 其余（含 gate 关闭的 win32、linux）→ PAYASO_SHELL_UNSANDBOXED 门控的无沙箱路径
// - fail-closed 贯穿：沙箱不可用即拒绝执行，绝不静默降级到无沙箱。

import { getNetworkMode, type NetworkMode } from '../network-mode.js';
import { storedPermissionMode, type PermissionMode } from '../permission-mode.js';
import type { ToolSandboxEvent } from '../tools/tools.js';
import {
  MacOSSandbox,
  type MacOSSandboxResult,
  probeSandboxAvailability,
} from './macos-sandbox.js';
import { discoverShellHost, runUncontainedShell } from './shell-host.js';
import type { ShellScratch } from './shell-scratch.js';

/** 执行器种类（决定 enforcement 与能力报告）。 */
export type ShellExecutorKind = 'macos-seatbelt' | 'windows-acl' | 'uncontained-gated';

/** 隔离完整度：full=全部承诺的文件效应都被治理；partial=部分写入隔离；none=无 OS 级遏制。 */
export type ShellEnforcement = 'full' | 'partial' | 'none';

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
  if (platform === 'win32' && env.PAYASO_SHELL_WINDOWS_ACL === '1') return 'windows-acl';
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

// ---- win32：Windows ACL 受限令牌执行器（步骤 2 接入；在此之前不可达）----

async function executeWindowsAcl(request: ShellExecuteRequest): Promise<ShellExecuteResult> {
  void request;
  // selectShellExecutor 只在 win32 + gate 开启时返回 'windows-acl'；
  // 本分支在步骤 2（windows-acl-sandbox.ts）落地前不可达。
  throw new Error('Shell executor "windows-acl" is not implemented yet');
}
