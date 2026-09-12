// 模块: HTTP 路由分发 —— 把浏览器请求按路径前缀路由到各资源域 handler。
// 边界：本文件只做「分发」；鉴权 / Body / 响应封装在 routes/route-context.ts，
// 各资源域逻辑在 routes/*-handler.ts，静态文件在 routes/static-handler.ts。
// Host 只通过 RunManager/Runtime 公开边界工作；路径一律经 Sandbox resolvePath 校验。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { segs } from './routes/route-context.js';
import { handleRuns } from './routes/runs-handler.js';
import { handleRuntime } from './routes/runtime-handler.js';
import { handleSessions } from './routes/sessions-handler.js';
import { handleSettings } from './routes/settings-handler.js';
import { serveStatic } from './routes/static-handler.js';
import { handleWorkspace } from './routes/workspace-handler.js';
import type { RunManager } from './run-manager.js';

// 对外兼容导出：Host 组合根通过 routes 设置进程级 API Token。
export { setHostApiToken } from './routes/route-context.js';

// 主分发
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  hostPort?: number,
): Promise<void> {
  const s = segs(req);
  const method = req.method ?? 'GET';
  const port = hostPort ?? Number(req.socket.localPort) ?? 4500;

  // Runtime / Prompts 域（只读能力投影 + 显式刷新）
  if (s[0] === 'runtime' || s[0] === 'prompts') {
    return handleRuntime(s, method, req, res, manager, port);
  }

  // Settings 域（模型 Provider / 默认模型 / 可用模型目录）
  if (s[0] === 'settings') {
    return handleSettings(s, method, req, res, manager, port);
  }

  // Workspace 域（查询/清空/选择器/页内浏览/重命名）
  if (s[0] === 'workspace') {
    return handleWorkspace(s, method, req, res, manager, port);
  }

  // Sessions 域（CRUD / 内置会话命令 / 会话内 Run）
  if (s[0] === 'sessions') {
    return handleSessions(s, method, req, res, manager, port);
  }

  // 非 API 路径 → 静态文件服务（含 SPA fallback）
  if (s[0] !== 'runs') {
    // 仅 GET/HEAD 允许访问静态文件
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405);
      res.end('method not allowed');
      return;
    }
    return serveStatic(res, req.url ?? '/');
  }

  // Runs 域（创建/列出/resume/stop/events/approval/toolchain/files）
  return handleRuns(s, method, req, res, manager, port);
}
