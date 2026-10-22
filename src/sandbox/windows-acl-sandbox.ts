// 模块: Windows ACL Shell 执行器（跨平台沙箱改造步骤 2）
// 设计（docs/sandbox/cross-platform-sandbox-plan.md §2/§3）：
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
import { MAX_SHELL_OUTPUT, type ProcessOutputStream } from './macos-sandbox.js';
import {
  buildShellInvocation,
  describeAclIncompatibleCarrier,
  isAclCompatibleCarrier,
  type ShellHost,
  type ShellRunResult,
  terminateProcessTree,
} from './shell-host.js';

const DEFAULT_RUNNER_PATH = fileURLToPath(new URL('./win-acl-runner.mjs', import.meta.url));

export interface WindowsAclRunnerArgvInput {
  nodeExecutable: string;
  /** 测试注入：替代真实 runner 路径。 */
  runnerPath?: string;
  workspaceRoot: string;
  scratchPath: string;
  permissionMode?: PermissionMode;
  /** 载体的命令调用形状 `[exe, ...args]`，由 `buildShellInvocation` 产出。 */
  invocation: readonly string[];
}

/**
 * 构造薄 runner 的完整 argv（纯函数，测试直接断言）：
 * [node, runner.mjs, --workspace, w, --scratch, s, --mode, m, --, ...carrierInvocation]
 * 权限模式原样传入。full-access 不改写成 workspace-write；runner 对它使用
 * 另一份 restricting SID 列表（见 docs/plans/windows-full-access-token-plan.md）。
 *
 * 载体不再硬编码 bash/-c：argv 尾段由载体决定（PowerShell 用 `-Command`，cmd 用 `/c`）。
 * 这是 2026-09-14 真机验收的结论 —— MSYS2 bash 在 WRITE_RESTRICTED 令牌下必然
 * 在 DLL 初始化阶段死亡，ACL 沙箱因此改用原生 PE 载体。
 */
export function buildWindowsAclRunnerArgv(input: WindowsAclRunnerArgvInput): string[] {
  const mode = storedPermissionMode(input.permissionMode);
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
    ...input.invocation,
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
  /** check 协议：截断前的原始带流标记 chunk（旧 Shell 调用方不传即无操作）。 */
  onRawChunk?: (stream: ProcessOutputStream, chunk: Buffer) => void;
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
  // fail-closed 第一道闸：ACL 沙箱只接受原生 PE 载体。MSYS2/WSL 载体在受限令牌下
  // 必然在 DLL 初始化阶段死亡，放行只会得到无法解释的 0xC0000142 / E_ACCESSDENIED。
  // 在 spawn 之前就拒绝，并给出准确诊断（不是"没装 Git"）。
  if (!isAclCompatibleCarrier(host)) {
    return Promise.reject(new Error(describeAclIncompatibleCarrier(host)));
  }
  return runWindowsAclArgv(
    buildWindowsAclRunnerArgv({
      nodeExecutable: options.nodeExecutable ?? process.execPath,
      runnerPath: options.runnerPath,
      workspaceRoot: options.workspaceRoot,
      scratchPath: options.scratchPath,
      permissionMode: options.permissionMode,
      invocation: buildShellInvocation(host, command),
    }),
    options,
  );
}

/**
 * 受控 argv 目标（check 协议，计划 §5.2）：同一个薄 runner、同一套受限令牌授权，
 * 只是 `--` 之后换成**原生程序 + 字面参数数组**（runner 内部本就是
 * `spawn(command, args)`）。不经 PowerShell/cmd，所以 `|`、`;`、`$`、引号只按
 * 字面到达被检查的进程；也就不需要、也不接受任何 shell 载体。
 * `.cmd/.bat` 一类的批处理不是原生进程，由 check 的参数校验先行拒绝。
 */
export function runWindowsAclProcess(
  processArgv: readonly string[],
  options: WindowsAclShellOptions,
): Promise<WindowsAclShellResult> {
  if (
    !processArgv.length ||
    processArgv.some((token) => typeof token !== 'string' || token.length === 0)
  ) {
    return Promise.reject(new Error('process argv must be a non-empty array of literal strings'));
  }
  return runWindowsAclArgv(
    buildWindowsAclRunnerArgv({
      nodeExecutable: options.nodeExecutable ?? process.execPath,
      runnerPath: options.runnerPath,
      workspaceRoot: options.workspaceRoot,
      scratchPath: options.scratchPath,
      permissionMode: options.permissionMode,
      invocation: processArgv,
    }),
    options,
  );
}

function runWindowsAclArgv(
  argv: readonly string[],
  options: WindowsAclShellOptions,
): Promise<WindowsAclShellResult> {
  const doSpawn = options.spawnImpl ?? spawn;
  const timeout = options.timeoutMs ?? 60_000;

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
      // 受限子进程 stdio 继承 runner，两条流仍分别落到 runner 的 stdout/stderr，
      // 因此这里能拿到真正的按流分离原始字节（旧 Shell 调用方不传即无操作）。
      options.onRawChunk?.('stdout', chunk);
      if (stdout.length < MAX_SHELL_OUTPUT * 4) stdout += String(chunk);
      options.onOutput?.(String(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      options.onRawChunk?.('stderr', chunk);
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
        if (timedOut && !report) {
          // 超时路径必须独立处理，理由与 aborted 分支对称：
          // timeoutTimer 终止的是 **runner 本身**（child.pid），而 runner 正是唯一能发出
          // 完成报告的 IPC 通道 ⇒ report 必然缺失。这是**预期路径**而非失败 —— 命令确已
          // 执行（超时本身即证明它跑起来了），整树也已终止（外加 kill-on-close Job Object
          // 双保险）。若在此退回 execution='unknown'，上层 shell-executor 会把它升级成
          // "执行结果未知，命令可能已运行"的异常，与 runUncontainedShell 的契约
          // （超时 → timedOut=true 正常返回）不一致。
          // 已知限制：runner 被强杀，来不及做 scratch 清理 ⇒ cleanupErrors 无从上报。
          resolve({
            exitCode: code,
            signal: null,
            stdout: outputLimit(stdout),
            stderr: outputLimit(stderr),
            timedOut: true,
            denied: false,
            execution: 'completed',
            cleanupErrors: [],
          });
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
