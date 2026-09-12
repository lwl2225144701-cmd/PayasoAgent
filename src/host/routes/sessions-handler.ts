// 模块: Sessions 域 handler —— /sessions*（CRUD / stats / export / compact / goal / plan / feedback / runs）。
//
// 为什么单独存在：sessions 域承载「会话元数据 + 内置会话命令 + 会话内 Run」三类
// 语义，端点数量最多。从 routes.ts 拆出后该域有唯一 owner。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PermissionMode } from '../../permission-mode.js';
import { prepareAttachments } from '../../runtime/attachment-normalize.js';
import type { CreateRunAttachmentInput, RunManager } from '../run-manager.js';
import {
  bad,
  checkOrigin,
  MAX_ATTACHMENT_BODY_BYTES,
  MAX_BODY_BYTES,
  notFound,
  RequestBodyTooLargeError,
  readBody,
  requestAttachments,
  requestModelSelection,
  requestPermissionMode,
  requireAuth,
  SAFE_SESSION_ID,
  sendJson,
} from './route-context.js';

export async function handleSessions(
  s: string[],
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  port: number,
): Promise<void> {
  if (s.length === 1 && method === 'GET') {
    return sendJson(res, 200, { sessions: manager.listSessions() });
  }
  const sessionId = s[1];
  if (!sessionId || !SAFE_SESSION_ID.test(sessionId)) return bad(res, '非法 sessionId');
  if (s.length === 2 && method === 'GET') {
    const session = manager.getSession(sessionId);
    return session ? sendJson(res, 200, session) : notFound(res);
  }
  if (s.length === 2 && method === 'PATCH') {
    checkOrigin(req, port);
    requireAuth(req);
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
      }
      throw err;
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return bad(res, '缺少 title');
    try {
      return sendJson(res, 200, manager.renameSession(sessionId, title));
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  if (s.length === 3 && s[2] === 'stats') {
    if (method === 'GET') {
      const stats = manager.sessionStats(sessionId);
      return stats ? sendJson(res, 200, stats) : notFound(res);
    }
  }
  // ---- 内置会话命令端点（/compact /export /goal /plan /feedback）----
  if (s.length === 3 && s[2] === 'export' && method === 'GET') {
    const exportView = manager.buildSessionExport(sessionId);
    if (!exportView) return notFound(res);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': exportView.bytes.length,
      'Content-Disposition': `attachment; filename="${exportView.fileName}"`,
    });
    res.end(Buffer.from(exportView.bytes));
    return;
  }
  if (s.length === 3 && s[2] === 'compact' && method === 'POST') {
    checkOrigin(req, port);
    requireAuth(req);
    try {
      const result = await manager.compactSession(sessionId);
      return result ? sendJson(res, 200, { ok: true, ...result }) : notFound(res);
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  if (s.length === 3 && s[2] === 'goal') {
    if (method === 'GET') {
      if (!manager.getSession(sessionId)) return notFound(res);
      return sendJson(res, 200, { goal: manager.getSessionGoal(sessionId) });
    }
    if (method === 'POST') {
      checkOrigin(req, port);
      requireAuth(req);
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
          return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
        }
        throw err;
      }
      if (typeof body.goal !== 'string') return bad(res, '缺少 goal');
      return manager.setSessionGoal(sessionId, body.goal)
        ? sendJson(res, 200, { ok: true, goal: manager.getSessionGoal(sessionId) })
        : notFound(res);
    }
  }
  if (s.length === 3 && s[2] === 'plan') {
    if (method === 'GET') {
      if (!manager.getSession(sessionId)) return notFound(res);
      return sendJson(res, 200, { planMode: manager.getSessionPlanMode(sessionId) });
    }
    if (method === 'POST') {
      checkOrigin(req, port);
      requireAuth(req);
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
          return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
        }
        throw err;
      }
      if (typeof body.enabled !== 'boolean') return bad(res, '缺少 enabled');
      return manager.setSessionPlanMode(sessionId, body.enabled)
        ? sendJson(res, 200, { ok: true, planMode: body.enabled })
        : notFound(res);
    }
  }
  if (s.length === 3 && s[2] === 'feedback' && method === 'POST') {
    checkOrigin(req, port);
    requireAuth(req);
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
      }
      throw err;
    }
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    if (!comment) return bad(res, '缺少 comment');
    return manager.addSessionFeedback(sessionId, comment)
      ? sendJson(res, 200, { ok: true })
      : notFound(res);
  }
  if (s.length === 3 && s[2] === 'runs') {
    if (method === 'GET') {
      const runs = manager.listSessionRuns(sessionId);
      return runs ? sendJson(res, 200, { runs }) : notFound(res);
    }
    if (method === 'POST') {
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
        // P1 归一化：解码校验 + EXIF + 下采样（失败 = 请求拒绝，与白名单同级）
        attachments = await prepareAttachments(attachments);
      } catch (err) {
        return bad(res, (err as Error).message);
      }
      try {
        const created = manager.createInSession(task, sessionId, {
          permissionMode,
          attachments,
          ...modelSelection,
        });
        return sendJson(res, 202, { ...created, status: 'running', permissionMode });
      } catch (err) {
        return bad(res, (err as Error).message);
      }
    }
  }
  if (s.length === 3 && method === 'POST' && s[2] === 'archive') {
    checkOrigin(req, port);
    requireAuth(req);
    try {
      return sendJson(res, 200, manager.archiveSession(sessionId));
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  if (s.length === 3 && method === 'POST' && s[2] === 'restore') {
    checkOrigin(req, port);
    requireAuth(req);
    try {
      return sendJson(res, 200, manager.restoreSession(sessionId));
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  if (s.length === 3 && method === 'POST' && s[2] === 'delete') {
    checkOrigin(req, port);
    requireAuth(req);
    try {
      return sendJson(res, 200, manager.deleteSession(sessionId));
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  return notFound(res);
}
