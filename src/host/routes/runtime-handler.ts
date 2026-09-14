// 模块: Runtime 域 handler —— /runtime/capabilities、/runtime/capabilities/refresh、/prompts。
//
// 为什么单独存在：这三个端点都是「只读能力投影 + 显式刷新」，不涉及 Run/Session
// 状态。从 routes.ts 拆出后，分发骨架只负责按路径前缀路由到这里。

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getRuntimeToolchainCapabilities,
  refreshRuntimeToolchainCapabilities,
} from '../../sandbox/toolchain-manager.js';
import { shellIsolationCapabilities } from '../../sandbox/shell-executor.js';
import type { RunManager } from '../run-manager.js';
import { checkOrigin, notFound, requireAuth, sendJson } from './route-context.js';

export async function handleRuntime(
  s: string[],
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  port: number,
): Promise<void> {
  // Read-only, path-free runtime capability projection. The private sandbox
  // manifest never leaves the process; this endpoint is for diagnostics/UI.
  // shellIsolation：Shell 隔离能力的诚实分级（partial 必须对 UI 可见，不静默放宽）。
  if (s.length === 2 && s[0] === 'runtime' && s[1] === 'capabilities' && method === 'GET') {
    return sendJson(res, 200, {
      capabilities: getRuntimeToolchainCapabilities(),
      shellIsolation: shellIsolationCapabilities(process.platform),
    });
  }

  // 当前工作区的 Prompt 命令注册表（只读元数据：name + description，无模板正文）。
  // 供前端在输入框 / 前缀下做命令补全；read-only 权限 / 无工作区返回空列表。
  if (s.length === 1 && s[0] === 'prompts' && method === 'GET') {
    return sendJson(res, 200, { prompts: manager.listPromptCommands() });
  }
  if (
    s.length === 3 &&
    s[0] === 'runtime' &&
    s[1] === 'capabilities' &&
    s[2] === 'refresh' &&
    method === 'POST'
  ) {
    checkOrigin(req, port);
    requireAuth(req);
    return sendJson(res, 200, {
      capabilities: refreshRuntimeToolchainCapabilities(),
      refreshed: true,
    });
  }

  return notFound(res);
}
