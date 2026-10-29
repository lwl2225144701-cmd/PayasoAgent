// 模块: Preview 域 handler —— /preview*（目录树 / 文件读取 / stat，M1 全只读）。
//
// 边界：本文件只做 HTTP 边界（鉴权 / 参数解析 / 响应封装 / 错误收口），
// 业务逻辑全部在 preview-service；安全约束复用 route-context 的既有机制。
//
// 错误收口（设计 §2.4）：service 只抛 PreviewError（code 身份）——
//   instanceof PreviewError → { error: code, ...detail } + code 映射的 HTTP 状态；
//   其余未预期错误原样上抛，冒泡到 server.ts 既有顶层 catch → 500，不猜不吞。

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  normalizePreviewBrowserUrl,
  publishBrowserOpen,
  subscribeBrowserOpen,
} from '../preview/browser-open.js';
import { subscribeWorkspaceChanges } from '../preview/changes.js';
import { listTree, type PreviewScope, readFile, statFile } from '../preview/preview-service.js';
import { PreviewError } from '../preview/types.js';
import type { RunManager } from '../run-manager.js';
import { getWorkspace } from '../workspace.js';
import {
  checkOrigin,
  notFound,
  RequestBodyTooLargeError,
  readBody,
  requireAuth,
  sendJson,
} from './route-context.js';

function queryParams(req: IncomingMessage): URLSearchParams {
  return new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
}

/**
 * 作用域解析：`?runId=` 存在时用**该 Run 的工作区根**（会话级浏览，历史会话
 * 也能看自己的文件），否则用 Host 当前工作区。
 *
 * 与 `/runs/:id/files` 同一套信任模型：那条端点本来就能读任意 Run 的工作区，
 * 这里只是把同一份数据接到预览模块上，没有扩大可达范围；前端依旧拿不到宿主
 * 绝对路径。解析不到（Run 不存在/会话已删除）时返回 `{ rootPath: null }`，
 * 由 service 抛 no_workspace —— 绝不静默换成当前工作区。
 */
function previewScope(params: URLSearchParams, manager: RunManager): PreviewScope | undefined {
  const runId = params.get('runId');
  if (runId === null || runId.length === 0) return undefined;
  return { rootPath: manager.getWorkspaceRoot(runId) };
}

/** PreviewError → 结构化响应；未预期错误上抛（server.ts 顶层 catch → 500）。 */
function respondError(res: ServerResponse, err: unknown): void {
  if (err instanceof PreviewError) {
    sendJson(res, err.status, { error: err.code, ...err.detail });
    return;
  }
  throw err;
}

export async function handlePreview(
  s: string[],
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  port: number,
): Promise<void> {
  // POST /preview/browser —— 请求 GUI 打开内嵌浏览器（Agent/curl 用）。
  // 必须在「仅 GET」闸门之前处理；校验口径与前端 normalizeBrowserUrl 一致。
  // 无 Origin 的本机请求（shell/curl）即使配置了 Host token 也放行：只推送
  // 已归一化的 http(s) URL，不写工作区、不扩大其它写面。
  if (s.length === 2 && s[1] === 'browser' && method === 'POST') {
    const origin = req.headers.origin;
    if (origin === 'null') {
      return sendJson(res, 400, { error: 'bad_request', message: 'untrusted origin' });
    }
    if (origin) {
      try {
        checkOrigin(req, port);
        requireAuth(req);
      } catch (err) {
        return sendJson(res, 400, { error: 'bad_request', message: (err as Error).message });
      }
    }
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        return sendJson(res, 413, { error: 'payload_too_large' });
      }
      throw err;
    }
    const url = normalizePreviewBrowserUrl(body.url);
    if (!url) {
      return sendJson(res, 400, {
        error: 'invalid_url',
        message: 'url must be http or https',
      });
    }
    publishBrowserOpen(url);
    return sendJson(res, 200, { ok: true, url });
  }

  // M1 只读：POST 写回（/preview/file）属 M5，届时在此域内扩展。
  if (method !== 'GET') return notFound(res);
  // 只读 GET 按 /runs·/workspace GET 先例不强制鉴权（localhost 绑定；
  // route-context 立场：读只读数据与直读 SQLite 等价）。Origin 仍校验——
  // 拒绝显式来自不可信源的请求；requireAuth 对无 Origin 的 GET 直接放行，
  // 在此统一调用是为 M5 写端点预留同一入口（写操作会真正要求 token）。
  try {
    checkOrigin(req, port);
    requireAuth(req);
  } catch (err) {
    // 与 server.ts 顶层对同款错误的既有处理保持一致：400 + 原消息
    return sendJson(res, 400, { error: 'bad_request', message: (err as Error).message });
  }

  // GET /preview/browser/events —— SSE：收到 POST /preview/browser 后推给 GUI。
  if (s.length === 3 && s[1] === 'browser' && s[2] === 'events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const sendEvent = (payload: Record<string, unknown>): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    sendEvent({ type: 'ready' });
    const unsubscribe = subscribeBrowserOpen((url) => sendEvent({ type: 'open', url }));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  if (s.length === 2 && s[1] === 'tree') {
    try {
      const params = queryParams(req);
      const listing = listTree(
        params.get('path') ?? '',
        params.get('includeIgnored') === 'true',
        previewScope(params, manager),
      );
      return sendJson(res, 200, listing);
    } catch (err) {
      return respondError(res, err);
    }
  }

  // GET /preview/changes?runId= —— SSE 变更流：外部写入 / agent 写入统一从这里推给 GUI，
  // 预览面板据此失效并重载（参考实现里的 workspaceFiles.changes）。
  if (s.length === 2 && s[1] === 'changes' && method === 'GET') {
    const params = queryParams(req);
    const root = params.get('runId')
      ? manager.getWorkspaceRoot(params.get('runId') as string)
      : (getWorkspace()?.rootPath ?? null);
    if (!root) return sendJson(res, 409, { error: 'no_workspace' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const sendEvent = (payload: Record<string, unknown>): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    sendEvent({ type: 'ready' });
    const unsubscribe = subscribeWorkspaceChanges(root, (paths) =>
      sendEvent({ type: 'changed', paths }),
    );
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  if (s.length === 2 && s[1] === 'stat') {
    try {
      const params = queryParams(req);
      return sendJson(res, 200, statFile(params.get('path') ?? '', previewScope(params, manager)));
    } catch (err) {
      return respondError(res, err);
    }
  }

  if (s.length === 2 && s[1] === 'file') {
    try {
      const params = queryParams(req);
      const content = readFile(params.get('path') ?? '', previewScope(params, manager));
      if (content.kind === 'text') {
        const body = Buffer.from(content.text ?? '', 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': body.length,
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(body);
        return;
      }
      const body = content.buffer ?? Buffer.alloc(0);
      res.writeHead(200, {
        'Content-Type': content.mimeType ?? 'application/octet-stream',
        'Content-Length': body.length,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
      return;
    } catch (err) {
      return respondError(res, err);
    }
  }

  return notFound(res);
}
