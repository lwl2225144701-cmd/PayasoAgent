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
// 权限模式 → AclSandbox 授权形状（docs/cross-platform-sandbox-plan.md §3）：
//  - read-only：writableDirs=[scratch] + tempWriteSid(scratch)、tempDir=null。
//    workspace 不在 writableDirs → 无 capability ACE → 只读；历史 workspace-write
//    留下的 standing workspace ACE 因 workspaceWriteSid 不在 restricting 列表而惰性。
//  - workspace-write / full-access：库原生形状 —— writableDirs=[workspace] +
//    workspaceWriteSid(workspace)（standing ACE，跨会话复用缓存）+ tempDir=scratch +
//    tempWriteSid(scratch)（可撤销 ACE）。
//
// 失败契约：任何 runner 侧失败（坏参数/目录缺失/令牌或授权/spawn 失败）打印
// "payaso-win-acl: <detail>" 到 stderr 并 exit 127；子进程绝不无限制执行
// （fail-closed）。子进程已执行后的清理失败只打印签名行，不覆盖其退出码。
//
// 依赖：@deepseek-ai/dsh-sandbox-windows-acl（MIT）提供 AclSandbox 与 SID 派生；
// koffi 仅用于本进程绑定 SetEnvironmentVariableW / SetConsoleCtrlHandler
// （库不导出这两个绑定；显式 env block 过 CreateProcessAsUserW 会
// ERROR_INVALID_PARAMETER，必须改自身环境后让子进程继承 —— stock runner 同款）。

import { existsSync, statSync } from 'node:fs';

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
  if (!setConsoleCtrlHandler(null, 1)) {
    fail(`SetConsoleCtrlHandler failed (Win32 ${getLastError()})`);
  }

  const { AclSandbox, tempWriteSid, workspaceWriteSid } = await import(
    '@deepseek-ai/dsh-sandbox-windows-acl'
  );

  const sandbox =
    parsed.mode === 'read-only'
      ? new AclSandbox({
          writableDirs: [parsed.scratch],
          writeSid: tempWriteSid(parsed.scratch),
          tempDir: null,
          mode: 'workspace-write',
        })
      : new AclSandbox({
          writableDirs: [parsed.workspace],
          writeSid: workspaceWriteSid(parsed.workspace),
          tempDir: parsed.scratch,
          tempWriteSid: tempWriteSid(parsed.scratch),
          mode: 'workspace-write',
        });

  let initialized = false;
  try {
    await sandbox.init();
    initialized = true;

    // HOME/TMPDIR(unix 语义，Git Bash 使用) + TMP/TEMP(Windows 语义) 全部指向 scratch。
    for (const name of ['HOME', 'TMP', 'TEMP', 'TMPDIR']) {
      if (!setEnvironmentVariable(name, parsed.scratch)) {
        fail(`SetEnvironmentVariableW ${name} failed (Win32 ${getLastError()})`);
      }
    }

    const child = sandbox.spawn({
      command: parsed.command,
      args: parsed.args,
      cwd: parsed.workspace,
      stdio: 'inherit',
    });
    const result = await child.wait();
    return result.exitCode;
  } finally {
    // 清理失败不得掩盖子进程退出码：报告后继续（temp ACE 撤销；workspace
    // standing ACE 按设计留存复用）。
    if (initialized) {
      try {
        sandbox.dispose();
      } catch (error) {
        process.stderr.write(
          `${SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(
        `${SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exitCode = FAILURE_EXIT;
  },
);
