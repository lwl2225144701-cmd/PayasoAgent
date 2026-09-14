// 模块: Windows ACL Shell 执行器（跨平台沙箱改造步骤 2）
// 设计（docs/cross-platform-sandbox-plan.md §2/§3）：
// - Payaso 不在自身进程内加载任何 Win32 FFI：受限令牌创建/ACL 授权/Job Object
//   全部在薄 runner 子进程（win-acl-runner.mjs）内完成，复用
//   @deepseek-ai/dsh-sandbox-windows-acl 的 AclSandbox（受限令牌 + 能力 SID 写授权 +
//   kill-on-close Job Object）。
// - 为什么不用库自带 stock runner：其 argv 契约无法表达 Payaso 的
//   "read-only 工作区 + 可写受管 scratch" 语义（read-only 零授权；workspace-write
//   必授予 workspace；其随机私有 temp 目录路径无法预知、HOME 指不进去）。
// - fail-closed：独立 IPC 报告执行阶段，无法确认结果时明确报告不确定，
//   绝不回退无沙箱路径。
// - enforcement = partial：写入部分隔离（Everyone 与 NTFS 硬链接例外），
//   读取与网络不受限；能力报告必须如实标注（shellIsolationCapabilities）。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type PermissionMode, storedPermissionMode } from '../permission-mode.js';
import { MAX_SHELL_OUTPUT } from './macos-sandbox.js';
import { type ShellHost, type ShellRunResult, terminateProcessTree } from './shell-host.js';

const DEFAULT_RUNNER_PATH = fileURLToPath(new URL('./win-acl-runner.mjs', import.meta.url));

export interface WindowsAclRunnerArgvInput {
  nodeExecutable: string;
  /** 测试注入：替代真实 runner 路径。 */
  runnerPath?: string;
  workspaceRoot: string;
  scratchPath: string;
  permissionMode?: PermissionMode;
  bashPath: string;
  command: string;
}

/**
 * 构造薄 runner 的完整 argv（纯函数，测试直接断言）：
 * [node, runner.mjs, --workspace, w, --scratch, s, --mode, m, --, bash, -c, command]
 * 权限模式映射：read-only → 'read-only'（工作区不授权，仅 scratch 可写）；
 * Full access 明确拒绝，不能静默映射为 workspace-write。
 */
export function buildWindowsAclRunnerArgv(input: WindowsAclRunnerArgvInput): string[] {
  const mode = storedPermissionMode(input.permissionMode);
  if (mode === 'full-access')
    throw new Error(
      'Windows ACL does not support Full access; explicitly enable PAYASO_SHELL_UNSANDBOXED=1 to use uncontained Shell.',
    );
  return [
    input.nodeExecutable,
    input.runnerPath ?? DEFAULT_RUNNER_PATH,
    '--workspace',
    input.workspaceRoot,
    '--scratch',
    input.scratchPath,
    '--mode',
    mode,
    '--',
    input.bashPath,
    '-c',
    input.command,
  ];
}

export interface WindowsAclShellOptions {
  workspaceRoot: string;
  /** 受管 scratch 路径（HOME/TMPDIR；workspace 外，Payaso 契约保证）。 */
  scratchPath: string;
  permissionMode?: PermissionMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
  /** 测试注入：替代真实 spawn。 */
  spawnImpl?: typeof spawn;
  nodeExecutable?: string;
  runnerPath?: string;
}

export type WindowsAclShellResult = ShellRunResult & {
  execution: 'not_started' | 'unknown' | 'completed';
  runnerFailure?: string;
  cleanupErrors: string[];
};

/**
 * 在 Windows ACL 受限令牌内执行一条 shell 命令（经薄 runner 子进程）。
 * 超时 / abort → terminateProcessTree(taskkill /F /T) 整树终止（runner 与其受限
 * 子进程；子进程另在 kill-on-close Job Object 内，双保险）。结果契约与
 * runUncontainedShell / MacOSSandbox.run 对齐，denied 恒 false（Windows 侧不
 * 从 stderr 推断权限拒绝——命令输出里的 EACCES 文本模型可直接看到）。
 */
export function runWindowsAclShell(
  host: ShellHost,
  command: string,
  options: WindowsAclShellOptions,
): Promise<WindowsAclShellResult> {
  const doSpawn = options.spawnImpl ?? spawn;
  const timeout = options.timeoutMs ?? 60_000;
  const argv = buildWindowsAclRunnerArgv({
    nodeExecutable: options.nodeExecutable ?? process.execPath,
    runnerPath: options.runnerPath,
    workspaceRoot: options.workspaceRoot,
    scratchPath: options.scratchPath,
    permissionMode: options.permissionMode,
    bashPath: host.shellPath,
    command,
  });

  return new Promise<WindowsAclShellResult>((resolve, reject) => {
    const child = doSpawn(argv[0], argv.slice(1), {
      cwd: options.workspaceRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let report:
      | { execution: WindowsAclShellResult['execution']; error?: string; cleanupErrors: string[] }
      | undefined;
    child.on('message', (message) => {
      const m = message as Record<string, unknown> | null;
      if (
        m?.type === 'acl-result' &&
        ['not_started', 'unknown', 'completed'].includes(String(m.execution)) &&
        Array.isArray(m.cleanupErrors) &&
        m.cleanupErrors.every((e) => typeof e === 'string')
      ) {
        report = {
          execution: m.execution as WindowsAclShellResult['execution'],
          error: typeof m.error === 'string' ? m.error : undefined,
          cleanupErrors: m.cleanupErrors as string[],
        };
      }
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid ?? 0, { platform: 'win32' });
    }, timeout);

    const onAbort = (): void => {
      aborted = true;
      terminateProcessTree(child.pid ?? 0, { platform: 'win32' });
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

    child.on('close', (code) => {
      settle(() => {
        if (aborted && (code === null || code !== 0)) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        resolve({
          exitCode: code,
          signal: null,
          stdout: outputLimit(stdout),
          stderr: outputLimit(stderr),
          timedOut,
          denied: false,
          execution: report?.execution ?? 'unknown',
          cleanupErrors: report?.cleanupErrors ?? [],
          ...(report?.error ? { runnerFailure: report.error } : {}),
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
