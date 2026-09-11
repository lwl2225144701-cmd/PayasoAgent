// 模块: Workspace 域 handler —— /workspace*（查询/清空/原生选择器/页内浏览/重命名）。
//
// 为什么单独存在：workspace 域聚合了「Host 持有的当前工作区」与「页内目录浏览」
// 两类语义，全部围绕工作区生命周期。从 routes.ts 拆出后该域有唯一 owner。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RunManager } from '../run-manager.js';
import {
  clearWorkspace,
  getWorkspace,
  openWorkspacePicker,
  setWorkspace,
  workspacePublicView,
} from '../workspace.js';
import { browseDirectory, createDirectoryInside } from '../workspace-browser.js';
import {
  MAX_BODY_BYTES,
  SAFE_SESSION_ID,
  RequestBodyTooLargeError,
  bad,
  checkOrigin,
  notFound,
  readBody,
  requireAuth,
  sendJson,
} from './route-context.js';

export async function handleWorkspace(
  s: string[],
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  port: number,
): Promise<void> {
  // Current Workspace: the native picker is Host-owned because browsers do
  // not reveal arbitrary absolute local paths. Normal responses expose name only.
  if (s.length === 1 && method === 'GET') {
    return sendJson(res, 200, { workspace: workspacePublicView(getWorkspace()) });
  }
  if (s.length === 1 && method === 'DELETE') {
    checkOrigin(req, port);
    requireAuth(req);
    clearWorkspace();
    return sendJson(res, 200, { workspace: null });
  }
  if (s.length === 2 && s[1] === 'open' && method === 'POST') {
    checkOrigin(req, port);
    requireAuth(req);
    try {
      const workspace = await openWorkspacePicker();
      return sendJson(res, 200, {
        workspace: workspacePublicView(workspace ?? getWorkspace()),
        cancelled: workspace === null,
      });
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  if (s.length === 2 && s[1] === 'rename' && method === 'POST') {
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
    const fromName = typeof body.fromName === 'string' ? body.fromName.trim() : '';
    const toName = typeof body.toName === 'string' ? body.toName.trim() : '';
    if (!fromName || !toName) return bad(res, '缺少 fromName/toName');
    if (toName.length > 120) return bad(res, '名称过长');
    try {
      return sendJson(res, 200, manager.renameWorkspace(fromName, toName));
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  if (s.length === 2 && s[1] === 'delete' && method === 'POST') {
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
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    let targetSessionId = sessionId;
    if (!targetSessionId && name) {
      const byName = manager.findSessionByWorkspaceName(name, { includeDeleted: true });
      if (!byName) return bad(res, 'Workspace not found');
      targetSessionId = byName.sessionId;
    }
    if (!targetSessionId || !SAFE_SESSION_ID.test(targetSessionId))
      return bad(res, '缺少 sessionId');
    try {
      return sendJson(res, 200, manager.deleteWorkspace(targetSessionId));
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  if (s.length === 2 && s[1] === 'restore' && method === 'POST') {
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
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId || !SAFE_SESSION_ID.test(sessionId)) return bad(res, '缺少 sessionId');
    try {
      return sendJson(res, 200, manager.restoreWorkspace(sessionId));
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  if (s.length === 2 && s[1] === 'purge' && method === 'POST') {
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
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId || !SAFE_SESSION_ID.test(sessionId)) return bad(res, '缺少 sessionId');
    try {
      return sendJson(res, 200, manager.purgeWorkspace(sessionId));
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  // In-page directory browsing (no native window): the Host enumerates
  // directories so the UI can render a folder tree inside the page. This
  // avoids the Windows FolderBrowserDialog being hidden behind the browser.
  // Adopting a directory still runs canonicalizeWorkspaceRoot (same
  // authorization as the native picker: the user explicitly chose it).
  if (s.length === 2 && s[1] === 'capability' && method === 'GET') {
    return sendJson(res, 200, { capability: { kind: 'browse' } });
  }
  if (s.length === 2 && s[1] === 'browse' && method === 'POST') {
    checkOrigin(req, port);
    requireAuth(req);
    let body: Record<string, unknown> = {};
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
      }
      throw err;
    }
    const requestedPath = typeof body.path === 'string' ? body.path.trim() : undefined;
    try {
      const listing = await browseDirectory(requestedPath);
      return sendJson(res, 200, listing);
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  if (s.length === 2 && s[1] === 'create-directory' && method === 'POST') {
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
    const parentPath = typeof body.path === 'string' ? body.path : '';
    const name = typeof body.name === 'string' ? body.name : '';
    try {
      return sendJson(res, 200, await createDirectoryInside(parentPath, name));
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  if (s.length === 2 && s[1] === 'select' && method === 'POST') {
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
    const selectPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!selectPath) return bad(res, '缺少 path');
    try {
      // canonicalizeWorkspaceRoot inside setWorkspace: absolute + exists + isDirectory + realpath
      return sendJson(res, 200, {
        workspace: workspacePublicView(setWorkspace(selectPath)),
      });
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }
  return notFound(res);
}
