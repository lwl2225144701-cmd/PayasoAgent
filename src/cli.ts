// 模块: CLI 入口 — 解析命令行参数，调用 Runtime 执行 Agent
// 用法:
//   npm start "任务"                   正常执行
//   npm start -- --resume <runId>      从 checkpoint 恢复执行
//   npm start -- --run-id <runId> "任务"  固定 runId 执行（测试/沙箱预置用，默认随机）
//   npm start -- --workspace <绝对路径> "任务"  在指定目录作为工作区执行（显式授权，默认用一次性空沙箱）
//   npm start -- --permission-mode <read-only|workspace-write|full-access> "任务"  权限档（默认 workspace-write）

import {
  createAgentExecutionContext,
  createDefaultRuntimeServices,
} from './bootstrap/runtime-bootstrap.js';
import { createCliApprovalPort } from './cli-approval.js';
import { type NetworkMode, setNetworkMode } from './network-mode.js';
import {
  type PermissionMode,
  isPermissionMode,
} from './permission-mode.js';
import { loadCheckpoint } from './persistence/file-checkpoint-store.js';
import { runAgent } from './runtime/agent.js';

const args = process.argv.slice(2);

// 解析 --resume / --run-id / --network-mode / --workspace / --permission-mode
// （各占一个后续参数值），其余为任务参数
let resumeId: string | undefined;
let runIdOpt: string | undefined;
let networkModeOpt: string | undefined;
let workspaceOpt: string | undefined;
let permissionModeOpt: string | undefined;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--resume') {
    resumeId = args[++i];
    continue;
  }
  if (args[i] === '--run-id') {
    runIdOpt = args[++i];
    continue;
  }
  if (args[i] === '--network-mode') {
    networkModeOpt = args[++i];
    continue;
  }
  if (args[i] === '--workspace') {
    workspaceOpt = args[++i];
    continue;
  }
  if (args[i] === '--permission-mode') {
    permissionModeOpt = args[++i];
    continue;
  }
  positional.push(args[i]);
}
const task = positional[0] || '帮我计算 15 * 37';

// 显式工作区授权：仅在传入 --workspace 时把 agent 限定到该绝对路径（与 Host 的
// workspace select 同语义——显式才授权，绝不默认吃当前目录）。缺省仍是每 Run 的
// 一次性空沙箱。权限档显式校验，非法值 fail-closed 退出。
const workspaceRoot = workspaceOpt?.trim() || undefined;
let permissionMode: PermissionMode | undefined;
if (permissionModeOpt) {
  if (!isPermissionMode(permissionModeOpt)) {
    console.error(
      `[Error] --permission-mode 仅支持 read-only | workspace-write | full-access，收到: ${permissionModeOpt}`,
    );
    process.exit(1);
  }
  permissionMode = permissionModeOpt;
}

// v2.0 Network Control：CLI 支持 --network-mode on|off|ask（默认 on）
if (networkModeOpt) {
  setNetworkMode(networkModeOpt as NetworkMode);
}
const approvalPort = createCliApprovalPort();
const runAgentOptions = {
  ...createDefaultRuntimeServices(),
  approvalPort,
};

if (resumeId) {
  const cp = loadCheckpoint(resumeId);
  if (!cp) {
    console.error(`[Error] checkpoint 不存在: ${resumeId}`);
    process.exit(1);
  }
  console.log(`任务: ${cp.task}（恢复执行）`);
  try {
    const answer = await runAgent(cp.task, cp, {
      executionContext: createAgentExecutionContext({
        runId: cp.runId,
        workspaceRoot: cp.workspaceRoot,
        permissionMode: cp.permissionMode,
      }),
      ...runAgentOptions,
    });
    console.log(`\n最终答案: ${answer}`);
  } catch (err) {
    console.error(`\n[Error] ${(err as Error).message}`);
    process.exit(1);
  }
} else {
  console.log(`任务: ${task}`);
  try {
    const runId = runIdOpt ?? crypto.randomUUID();
    const answer = await runAgent(task, undefined, {
      executionContext: createAgentExecutionContext({
        runId,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      }),
      ...runAgentOptions,
    });
    console.log(`\n最终答案: ${answer}`);
  } catch (err) {
    console.error(`\n[Error] ${(err as Error).message}`);
    process.exit(1);
  }
}
