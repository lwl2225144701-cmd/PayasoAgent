#!/usr/bin/env node
// 模块: Windows ACL 薄 runner — Payaso 自有的受限令牌执行入口（win32 专用）
// 由 src/sandbox/windows-acl-sandbox.ts 以子进程方式启动（本文件绝不加载进
// Payaso 主进程；macOS/Linux 不会执行到它）。纯 JS（.mjs），不依赖 tsx。
//
// argv 契约（Payaso 自有，与 DeepSeek stock runner 不同）:
//   [node, win-acl-runner.mjs,
//    '--workspace', <dir>, '--scratch', <dir>, '--mode', <read-only|workspace-write>,
//    '--', <bash 路径>, '-c', <命令>]
//
// 权限模式 → AclSandbox 授权形状（docs/sandbox/cross-platform-sandbox-plan.md §3）：
//  - read-only：scratch 由 AclWriteGrant 可撤销授权，AclSandbox 不管理 DACL。
//    workspace 不在 writableDirs → 无 capability ACE → 只读；历史 workspace-write
//    留下的 standing workspace ACE 因 workspaceWriteSid 不在 restricting 列表而惰性。
//  - workspace-write：库原生形状 —— writableDirs=[workspace] +
//    workspaceWriteSid(workspace)（standing ACE，跨会话复用缓存）+ tempDir=scratch +
//    tempWriteSid(scratch)（可撤销 ACE）。
//
// 失败契约：独立 IPC 报告 not_started / unknown / completed，清理故障单独上报。
// 命令输出及退出码不得作为未执行证据；Full access 不进入此 runner。
//
// 依赖：@deepseek-ai/dsh-sandbox-windows-acl（MIT）提供 AclSandbox 与 SID 派生；
// koffi 仅用于本进程绑定 SetEnvironmentVariableW / SetConsoleCtrlHandler
// （库不导出这两个绑定；显式 env block 过 CreateProcessAsUserW 会
// ERROR_INVALID_PARAMETER，必须改自身环境后让子进程继承 —— stock runner 同款）。

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIGNATURE = 'payaso-win-acl';
const FAILURE_EXIT = 127;

class RunnerFailure extends Error {}

function fail(detail) {
  process.stderr.write(`${SIGNATURE}: ${detail}\n`);
  throw new RunnerFailure(detail);
}

function parseArgs(raw) {
  let workspace;
  let scratch;
  let mode;
  let index = 0;
  for (; index < raw.length; index++) {
    const token = raw[index];
    if (token === '--') {
      index++;
      break;
    }
    index++;
    const value = raw[index];
    if (value === undefined) fail(`missing value after ${token}`);
    switch (token) {
      case '--workspace':
        workspace = value;
        break;
      case '--scratch':
        scratch = value;
        break;
      case '--mode':
        mode = value;
        break;
      default:
        fail(`unknown argument: ${token}`);
    }
  }
  if (workspace === undefined) fail('missing --workspace');
  if (scratch === undefined) fail('missing --scratch');
  if (mode !== 'read-only' && mode !== 'workspace-write') fail(`unknown mode: ${String(mode)}`);
  const argv = raw.slice(index);
  const command = argv[0];
  if (command === undefined) fail('missing command after --');
  return { workspace, scratch, mode, command, args: argv.slice(1) };
}

function requireDirectory(label, dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    fail(`${label} is not an existing directory: ${dir}`);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  // 两目录先于任何 FFI 加载校验：坏参数在 macOS 等非 win32 环境同样给出
  // 签名行 + 127（确定性可测），且命令绝不执行。
  requireDirectory('--workspace', parsed.workspace);
  requireDirectory('--scratch', parsed.scratch);

  const { assertTempRootOutsideWorkspace } = await import('@deepseek-ai/dsh-sandbox-windows-acl');
  // Payaso 契约保证 scratch 在 workspace 外（受管临时根）；runner 侧防御性复检。
  assertTempRootOutsideWorkspace(parsed.workspace, parsed.scratch);

  // koffi 与 AclSandbox 仅在参数校验通过后加载（win32 专用路径）。
  const koffi = (await import('koffi')).default;
  const kernel32 = koffi.load('kernel32.dll');
  const setConsoleCtrlHandler = kernel32.func(
    'bool __stdcall SetConsoleCtrlHandler(void *handler, bool add)',
  );
  const setEnvironmentVariable = kernel32.func(
    'bool __stdcall SetEnvironmentVariableW(const char16_t *name, const char16_t *value)',
  );
  const getLastError = kernel32.func('uint32 __stdcall GetLastError()');

  // 忽略 runner 自身 CTRL+C：受限子进程（同控制台）自行处理；runner 必须存活到
  // 授权撤销与退出码镜像完成。
  // 注意：签名声明为 bool，koffi 对 bool 入参只接受 true/false；传 1 会抛
  // "Unexpected Number value, expected boolean"（依赖库自身 binding 用 "int" 故不受影响）。
  if (!setConsoleCtrlHandler(null, true)) {
    fail(`SetConsoleCtrlHandler failed (Win32 ${getLastError()})`);
  }

  const { AclSandbox, AclWriteGrant, tempWriteSid, workspaceWriteSid } = await import(
    '@deepseek-ai/dsh-sandbox-windows-acl'
  );

  return executeWithSandbox(
    parsed,
    { AclSandbox, AclWriteGrant, tempWriteSid, workspaceWriteSid },
    (name, value) => {
      if (!setEnvironmentVariable(name, value))
        throw new Error(`SetEnvironmentVariableW ${name} failed`);
    },
  );
}

// 与 Win32 绑定分离，允许验证授权生命周期和执行阶段；不提供环境变量注入后门。
export async function executeWithSandbox(parsed, api, setEnvironment) {
  const { AclSandbox, AclWriteGrant, tempWriteSid, workspaceWriteSid } = api;
  let sandbox;
  let grant;
  let execution = 'not_started';
  let exitCode = 127;
  let error;
  const cleanupErrors = [];
  try {
    const scratchSid = tempWriteSid(parsed.scratch);
    if (parsed.mode === 'read-only') {
      grant = AclWriteGrant.create(scratchSid);
      grant.add(parsed.scratch, false);
    }
    sandbox = new AclSandbox(
      parsed.mode === 'read-only'
        ? {
            writableDirs: [parsed.scratch],
            writeSid: scratchSid,
            tempDir: null,
            mode: 'workspace-write',
            manageDacls: false,
          }
        : {
            writableDirs: [parsed.workspace],
            writeSid: workspaceWriteSid(parsed.workspace),
            tempDir: parsed.scratch,
            tempWriteSid: scratchSid,
            mode: 'workspace-write',
          },
    );
    await sandbox.init();
    for (const name of ['HOME', 'TMP', 'TEMP', 'TMPDIR']) setEnvironment(name, parsed.scratch);
    // spawn 内部也可能在创建进程后抛错，因此调用前就进入不确定阶段。
    execution = 'unknown';
    const child = sandbox.spawn({
      command: parsed.command,
      args: parsed.args,
      cwd: parsed.workspace,
      stdio: 'inherit',
    });
    const result = await child.wait();
    exitCode = result.exitCode;
    execution = 'completed';
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    // 每个资源独立清理；部分授权失败也要撤销。未知执行状态不得声称命令未运行。
    if (execution === 'unknown')
      cleanupErrors.push(
        'Process termination is unconfirmed; grant cleanup deferred to avoid revoking live children.',
      );
    for (const resource of execution === 'unknown' ? [] : [sandbox, grant]) {
      try {
        resource?.dispose();
      } catch (cause) {
        cleanupErrors.push(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }
  return { execution, exitCode, error, cleanupErrors };
}

async function launch() {
  let report;
  try {
    report = await main();
  } catch (error) {
    report = {
      execution: 'not_started',
      exitCode: FAILURE_EXIT,
      error: error instanceof Error ? error.message : String(error),
      cleanupErrors: [],
    };
  }
  // 状态走独立 IPC，stdout/stderr 与命令退出码不能证明命令是否执行。
  if (process.send)
    await new Promise((resolve) => process.send({ type: 'acl-result', ...report }, resolve));
  else if (report.error) process.stderr.write(`${SIGNATURE}: ${report.error}\n`);
  // 未确认子进程结束时直接退出，关闭 runner 持有的 Job，父进程随后清理 scratch。
  if (report.execution === 'unknown') process.exit(report.exitCode);
  process.exitCode = report.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void launch();
