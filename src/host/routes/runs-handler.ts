import { parseTaskConstraints } from '../task-constraints.js';
// 模块: Runs 域 handler —— /runs*（创建/列出/resume/stop/events/approval/toolchain/files）。
//
// 为什么单独存在：runs 域承载「Run 生命周期端点 + SSE 事件流 + 工作区文件读取」
// 三类语义，是分发骨架之外最大的域。从 routes.ts 拆出后该域有唯一 owner。

import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { inspectRunDelivery } from '../run-delivery.js';
import type { PermissionMode } from '../../permission-mode.js';
import { prepareAttachments } from '../attachments/normalize.js';
import { openFileInDefaultBrowser } from '../default-browser.js';
import type { CreateRunAttachmentInput, RunManager, SseSink } from '../run-manager.js';
import {
  bad,
  checkOrigin,
  MAX_ATTACHMENT_BODY_BYTES,
  notFound,
  RequestBodyTooLargeError,
  readBody,
  requestAttachments,
  requestModelSelection,
  requestPermissionMode,
  requireAuth,
  SAFE_RUN_ID,
  SAFE_SESSION_ID,
  sendJson,
} from './route-context.js';
import { IMAGE_EXT_MIME, listFiles, readFileChecked, readImageChecked, readDownloadChecked } from './static-handler.js';

// SSE：实时推送 Run 事件（回放历史 + 实时）
function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  runId: string,
): void {
  if (!manager.get(runId)) {
    notFound(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const sink = sinkOf(res);
  const lastEventId = Number(req.headers['last-event-id'] ?? 0);
  const live = new URL(req.url ?? '/', 'http://localhost').searchParams.get('live') !== '0';
  manager.subscribe(
    runId,
    sink,
    Number.isSafeInteger(lastEventId) && lastEventId > 0 ? lastEventId : 0,
    live,
  );
  if (!live) return;
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    manager.unsubscribe(runId, sink);
  });
}
function sinkOf(res: ServerResponse): SseSink {
  return { write: (c) => res.write(c), end: () => res.end(), closed: () => res.writableEnded };
}

export async function handleRuns(
  s: string[],
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  port: number,
): Promise<void> {
  // GET /runs · POST /runs
  if (s.length === 1) {
    if (method === 'GET') return sendJson(res, 200, { runs: manager.list() });
    if (method === 'POST') {
      // Content-Length 检查在 auth 之前：超大请求直接 413，减少无谓的鉴权开销
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BODY_BYTES) {
        req.resume();
        return sendJson(res, 413, {
          error: 'payload_too_large',
          maxBytes: MAX_ATTACHMENT_BODY_BYTES,
        });
      }
      checkOrigin(req, port);
      requireAuth(req);
      let body: Record<string, unknown>;
      try {
        body = await readBody(req, MAX_ATTACHMENT_BODY_BYTES);
      } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
          return sendJson(res, 413, {
            error: 'payload_too_large',
            maxBytes: MAX_ATTACHMENT_BODY_BYTES,
          });
        }
        throw err;
      }
      const task = typeof body.task === 'string' ? body.task.trim() : '';
      if (!task) return bad(res, '缺少 task');
      const requestedSessionId =
        typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined;
      if (requestedSessionId && !SAFE_SESSION_ID.test(requestedSessionId))
        return bad(res, '非法 sessionId');
      const workspaceName =
        typeof body.workspaceName === 'string' ? body.workspaceName.trim() : undefined;
      if (workspaceName && workspaceName.length > 120) return bad(res, 'workspaceName 过长');
      let permissionMode: PermissionMode;
      try {
        permissionMode = requestPermissionMode(body.permissionMode);
      } catch {
        return bad(res, 'invalid_permission_mode');
      }
      let modelSelection: { providerId?: string; model?: string };
      try {
        modelSelection = requestModelSelection(body);
      } catch (err) {
        return bad(res, (err as Error).message);
      }
      let attachments: CreateRunAttachmentInput[];
      try {
        attachments = requestAttachments(body);
      } catch (err) {
        return bad(res, (err as Error).message);
      }
      try {
        attachments = await prepareAttachments(attachments);
      } catch (err) {
        return bad(res, (err as Error).message);
      }
      try {
        const created = manager.createInSession(task, requestedSessionId, {
          workspaceName,
          permissionMode,
          attachments,
          constraints: parseTaskConstraints(body.constraints),
          ...modelSelection,
        });
        return sendJson(res, 202, { ...created, status: 'running', permissionMode: manager.get(created.runId)?.permissionMode ?? permissionMode });
      } catch (err) {
        return bad(res, (err as Error).message);
      }
    }
    return notFound(res);
  }

  const runId = s[1];
  if (!SAFE_RUN_ID.test(runId)) return bad(res, '非法 runId');

  // GET /runs/:id
  if (s.length === 2 && method === 'GET') {
    const run = manager.get(runId);
    return run ? sendJson(res, 200, run) : notFound(res);
  }

  if (s.length < 3) {
    notFound(res);
    return;
  }

  switch (s[2]) {
    case 'delivery': {
      if (method !== 'GET' || s.length !== 3) return notFound(res);
      checkOrigin(req, port);
      requireAuth(req);
      const run = manager.get(runId);
      const events = manager.listRunEvents(runId);
      if (!run || !events) return notFound(res);
      return sendJson(res, 200, inspectRunDelivery(events, manager.getWorkspaceRoot(runId), run.updatedAt, run.result));
    }
    case 'events': {
      if (method !== 'GET') return notFound(res);
      // SSE：验证 token（通过 Authorization header，不使用 query）
      checkOrigin(req, port);
      requireAuth(req);
      // 已完成 Run 的事件不可变，前端用一次性快照取回即可：为每个历史回合维持一条
      // SSE 会占满浏览器同源 6 条并发额度，长会话打开时被挤成连接队列，
      // 连正在流式的 live Run 也抢不到连接。
      if (s.length === 4 && s[3] === 'snapshot') {
        const events = manager.listRunEvents(runId);
        return events ? sendJson(res, 200, { events }) : notFound(res);
      }
      if (s.length !== 3) return notFound(res);
      return handleSse(req, res, manager, runId);
    }
    case 'resume': {
      if (method !== 'POST') return notFound(res);
      checkOrigin(req, port);
      requireAuth(req);
      return manager.resume(runId)
        ? sendJson(res, 202, { runId, status: 'running' })
        : notFound(res);
    }
    case 'stop': {
      if (method !== 'POST') return notFound(res);
      checkOrigin(req, port);
      requireAuth(req);
      return manager.stop(runId) ? sendJson(res, 202, { runId, status: 'stopped' }) : notFound(res);
    }
    case 'approval': {
      if (method !== 'POST') return notFound(res);
      checkOrigin(req, port);
      requireAuth(req);
      try {
        const body = await readBody(req);
        const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
        if (!requestId) return bad(res, '缺少 requestId');
        const approved = body.approved === true;
        const ok = manager.resolveApproval(runId, requestId, approved);
        if (!ok) return bad(res, 'approval request not found or already resolved');
        return sendJson(res, 200, { runId, requestId, approved, resolved: true });
      } catch (err) {
        return bad(res, (err as Error).message);
      }
    }
    case 'toolchain-preparation': {
      if (method !== 'POST') return notFound(res);
      checkOrigin(req, port);
      requireAuth(req);
      try {
        const body = await readBody(req);
        const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
        if (!requestId) return bad(res, '缺少 requestId');
        if (body.cancel === true) {
          const cancelled = manager.cancelToolchainPreparation(runId, requestId);
          if (!cancelled)
            return bad(res, 'toolchain preparation request not found or already finished');
          return sendJson(res, 200, { runId, requestId, cancelled: true });
        }
        const approved = body.approved === true;
        const ok = manager.resolveToolchainPreparation(runId, requestId, approved);
        if (!ok) return bad(res, 'toolchain preparation request not found or already resolved');
        return sendJson(res, 200, { runId, requestId, approved, resolved: true });
      } catch (err) {
        return bad(res, (err as Error).message);
      }
    }
    case 'files': {
      checkOrigin(req, port);
      requireAuth(req);
      // POST /runs/:id/files/<rel>/open → 交给 macOS 默认应用打开。
      // 路径在 Host 内重新 canonicalize，前端永远拿不到宿主绝对路径。
      if (method === 'POST' && s.length >= 5 && s[s.length - 1] === 'open') {
        const run = manager.get(runId);
        if (!run) return notFound(res);
        const root = manager.getWorkspaceRoot(runId);
        if (!root) return notFound(res);
        const rel = s.slice(3, -1).join('/');
        try {
          await openFileInDefaultBrowser(root, rel);
          return sendJson(res, 200, { runId, name: rel, opened: true });
        } catch (err) {
          const message = (err as Error).message;
          if (message.includes('only HTML'))
            return bad(res, 'only HTML files can be opened in the browser');
          return bad(res, 'file cannot be opened in the default browser');
        }
      }
      if (method !== 'GET') return notFound(res);
      // GET /runs/:id/files → 列文件
      if (s.length === 3) {
        const run = manager.get(runId);
        if (!run) return notFound(res);
        const root = manager.getWorkspaceRoot(runId);
        if (!root) return notFound(res);
        const files = listFiles(root);
        return sendJson(res, 200, { runId, files });
      }
      // GET /runs/:id/files/<rel> → 读文件（图片扩展名直接返回二进制，供 <img> 预览）
      const rel = s.slice(3).join('/');
      const root = manager.getWorkspaceRoot(runId);
      if (!root) return notFound(res);
      if (new URL(req.url ?? '/', 'http://localhost').searchParams.get('download') === '1') {
        const file = readDownloadChecked(root, rel);
        if (!file.ok) return bad(res, file.error);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': file.buffer.length,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(rel))}`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        });
        res.end(file.buffer);
        return;
      }
      if (IMAGE_EXT_MIME[path.extname(rel).toLowerCase()]) {
        const image = readImageChecked(root, rel);
        if (!image.ok) return bad(res, image.error);
        res.writeHead(200, {
          'content-type': image.mimeType,
          'content-length': image.buffer.length,
          'cache-control': 'no-store',
        });
        res.end(image.buffer);
        return;
      }
      const read = readFileChecked(root, rel);
      return read.ok
        ? sendJson(res, 200, { runId, name: read.name, content: read.content })
        : bad(res, read.error);
    }
    default:
      return notFound(res);
  }
}
