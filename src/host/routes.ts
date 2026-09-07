// 模块: HTTP 路由 — 把浏览器请求映射到 RunManager + Sandbox + 静态文件
// 边界：Host 只通过 RunManager/Runtime 公开边界工作；路径一律经 Sandbox resolvePath 校验。
// 静态文件：生产环境从 web/dist/ 提供前端构建产物；非 /runs/* 走静态文件服务 + SPA fallback。

import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  type PermissionMode,
} from '../permission-mode.js';
import { prepareAttachments } from '../runtime/attachment-normalize.js';
import { assertInsideRoot, resolveWorkspacePath } from '../sandbox/sandbox-manager.js';
import {
  getRuntimeToolchainCapabilities,
  refreshRuntimeToolchainCapabilities,
} from '../sandbox/toolchain-manager.js';
import { fetchAvailableModelCatalog } from './available-models.js';
import { openFileInDefaultBrowser } from './default-browser.js';
import type { CreateModelProviderInput, UpdateModelProviderInput } from './persistence/store.js';
import { listPiAiProviderCatalog } from './pi-ai-providers.js';
import { canonicalizeProviderBaseUrl } from './provider-url.js';
import type { CreateRunAttachmentInput, RunManager, SseSink } from './run-manager.js';
import {
  clearWorkspace,
  getWorkspace,
  openWorkspacePicker,
  workspacePublicView,
} from './workspace.js';

const MAX_FILE_BYTES = 1024 * 1024; // 文本文件读取上限
const MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024; // 图片附件/预览上限（与 read 读图一致）
const MAX_STATIC_BYTES = 5 * 1024 * 1024; // 静态资源大小上限（含 JS bundle）
// JSON 请求体上限：消息可携带 base64 图片附件（4 张 × ≤8MB 原始 → base64 膨胀 ~1.33 倍）。
// 常规 JSON 请求体上限；视觉附件端点（/runs 与 /sessions/:id/runs）单独放宽：
// 客户端已把每张图压到 ≤2MiB（P2），4 张 + base64 膨胀 ≈ ≤12MB。
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BODY_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENTS = 4; // 单条消息最多图片数
const ATTACHMENT_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// files 端点可直接返回二进制的图片扩展名（<img src> 直接预览）。
const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/; // 与 Sandbox 的 runId 规则一致
const SAFE_SESSION_ID = SAFE_RUN_ID;

function requestPermissionMode(value: unknown): PermissionMode {
  if (value === undefined) return DEFAULT_PERMISSION_MODE;
  if (!isPermissionMode(value)) throw new Error('invalid_permission_mode');
  return value;
}

function requestModelSelection(body: Record<string, unknown>): {
  providerId?: string;
  model?: string;
} {
  const hasProviderId = body.providerId !== undefined;
  const hasModel = body.model !== undefined;
  if (!hasProviderId && !hasModel) return {};
  if (
    typeof body.providerId !== 'string' ||
    typeof body.model !== 'string' ||
    !body.providerId.trim() ||
    !body.model.trim()
  ) {
    throw new Error('providerId and model must be provided together');
  }
  return { providerId: body.providerId.trim(), model: body.model.trim() };
}

// 解析并校验消息图片附件：MIME 白名单、数量上限、单张 ≤8MB（base64 估算）。
// 文件名只取 basename 并交由落盘层二次清洗，任何穿越尝试都到不了磁盘。
function requestAttachments(body: Record<string, unknown>): CreateRunAttachmentInput[] {
  if (body.attachments === undefined) return [];
  if (!Array.isArray(body.attachments)) throw new Error('attachments 必须是数组');
  if (body.attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`附件最多 ${MAX_ATTACHMENTS} 张`);
  }
  return body.attachments.map((raw, index) => {
    const label = `附件 ${index + 1}`;
    if (typeof raw !== 'object' || raw === null) throw new Error(`${label} 格式非法`);
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? path.basename(item.name.trim()) : '';
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
    const dataBase64 =
      typeof item.dataBase64 === 'string' ? item.dataBase64.replace(/\s+/g, '') : '';
    if (!name || name.length > 200) throw new Error(`${label} 文件名非法`);
    if (!ATTACHMENT_MIME.has(mimeType)) {
      throw new Error(`${label} 仅支持 PNG / JPEG / WebP / GIF 图片`);
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(dataBase64) || dataBase64.length < 8) {
      throw new Error(`${label} 数据非法`);
    }
    // base64 每 4 字符 ≈ 3 字节，先按估算拦超大图，避免无谓解码占内存。
    const approxBytes = Math.floor((dataBase64.length * 3) / 4);
    if (approxBytes > MAX_IMAGE_FILE_BYTES) throw new Error(`${label} 超过 8MB 上限`);
    return { name, mimeType, dataBase64 };
  });
}

// Host API Token（进程内存唯一，不进入 URL/日志/前端状态）
let hostApiToken: string | null = null;
export function setHostApiToken(token: string | null): void {
  hostApiToken = token;
}

// 判断是否为开发模式（Vite dev server 5173 仅在开发模式允许）
const isDevMode = process.env.NODE_ENV !== 'production' && process.env.VITE_DEV_SERVER !== '0';

// 构建可信 Origin 集合（按实际 Host 端口动态计算）
function trustedOrigins(hostPort: number): Set<string> {
  const origins = new Set<string>();
  if (isDevMode) {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
  }
  origins.add(`http://localhost:${hostPort}`);
  origins.add(`http://127.0.0.1:${hostPort}`);
  return origins;
}


function checkOrigin(req: IncomingMessage, hostPort: number): void {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') {
    // Origin: null 明确拒绝（防止浏览器发来的 null Origin 绕过检查）
    if (origin === 'null') {
      throw new Error('untrusted origin');
    }
    // 无 Origin 的只读请求（GET/HEAD）放行：
    // 浏览器同源 GET 默认不带 Origin（规范行为），本地进程读取只读数据
    // 与直接读 SQLite 等价，风险可控；写操作仍要求 token。
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return;
    // 未配置 token 时，允许非浏览器请求（未配置 = 不强制鉴权）
    if (!hostApiToken) return;
    // 无 Origin 的写请求必须通过 Authorization header 鉴权
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ')) {
      throw new Error('missing or invalid authorization');
    }
    const token = auth.slice('Bearer '.length).trim();
    if (token.length < 32 || token !== hostApiToken) {
      throw new Error('missing or invalid authorization');
    }
    return;
  }
  if (!trustedOrigins(hostPort).has(origin)) {
    throw new Error('untrusted origin');
  }
}

function requireAuth(req: IncomingMessage): void {
  // 非浏览器无 Origin 请求必须提供 Host API token（只读 GET/HEAD 在 checkOrigin 已放行）
  const origin = req.headers.origin;
  if (!origin || origin === 'null') {
    if (origin === 'null') throw new Error('untrusted origin');
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return;
    // 未配置 token 时，允许非浏览器请求（未配置 = 不强制鉴权）
    if (!hostApiToken) return;
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ')) {
      throw new Error('missing or invalid authorization');
    }
    const token = auth.slice('Bearer '.length).trim();
    if (token.length < 32 || token !== hostApiToken) {
      throw new Error('missing or invalid authorization');
    }
  }
}

function requireJsonContentType(req: IncomingMessage): void {
  const ct = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!ct.includes('application/json')) {
    throw new Error('Content-Type must be application/json');
  }
}

// 静态文件根目录：项目根/web/dist/（server 从项目根启动，process.cwd() 为项目根）
const STATIC_ROOT = path.resolve(process.cwd(), 'web', 'dist');

// 白名单 MIME 类型
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const b = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(b),
  });
  res.end(b);
}
function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'not_found' });
}
function bad(res: ServerResponse, msg: string): void {
  sendJson(res, 400, { error: 'bad_request', message: msg });
}

// 安全地提供静态文件：禁止路径穿越，仅白名单后缀，支持 SPA fallback
function serveStatic(res: ServerResponse, urlPath: string): void {
  try {
    // 解析请求路径（去掉 query string，decode）
    let rel = decodeURIComponent(urlPath.split('?')[0]);
    if (rel.startsWith('/')) rel = rel.slice(1);
    // 根路径或空路径 → index.html
    if (!rel) rel = 'index.html';

    // 禁止路径穿越
    if (rel.includes('..')) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    // 解析绝对路径并校验在 STATIC_ROOT 内
    const abs = path.resolve(STATIC_ROOT, rel);
    const relFromRoot = path.relative(STATIC_ROOT, abs);
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    // 尝试读取文件
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        // 目录 → 尝试 index.html
        serveStatic(res, `/${rel.replace(/\/+$/, '')}/index.html`);
        return;
      }
      if (st.size > MAX_STATIC_BYTES) {
        res.writeHead(413);
        res.end('file too large');
        return;
      }
      const ext = path.extname(abs).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      const content = fs.readFileSync(abs);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': content.length,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      res.end(content);
      return;
    } catch {
      // 文件不存在 → SPA fallback（返回 index.html）
      // 但 API 路径（/runs/*）不应 fallback，已在主分发中前置处理
      const indexPath = path.join(STATIC_ROOT, 'index.html');
      try {
        const idx = fs.readFileSync(indexPath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': idx.length,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
        });
        res.end(idx);
        return;
      } catch {
        // dist 目录不存在（开发模式直接访问 4500），返回提示
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          "<!DOCTYPE html><html><head><meta charset='utf-8'><title>PayasoAgent</title></head>" +
            "<body style='font-family:sans-serif;display:flex;align-items:center;justify-content:center;" +
            "height:100vh;margin:0;background:#f8f9fa;color:#333;'>" +
            "<div style='text-align:center'>" +
            '<h2>🤡 PayasoAgent Host 已启动</h2>' +
            '<p>API 服务运行中 · 端口 4500</p>' +
            "<p>前端开发模式请访问 <a href='http://localhost:5173'>http://localhost:5173</a></p>" +
            '<p>生产模式请先运行 <code>npm run build:web</code> 构建前端</p>' +
            '</div></body></html>',
        );
        return;
      }
    }
  } catch {
    res.writeHead(500);
    res.end('internal error');
  }
}

function segs(req: IncomingMessage): string[] {
  return (req.url ?? '/').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
}

class RequestBodyTooLargeError extends Error {}

async function readBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Drain the request so the HTTP connection can still receive the 413.
    req.resume();
    throw new RequestBodyTooLargeError('request body too large');
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > maxBytes) {
      tooLarge = true;
      continue; // Keep draining, but never retain bytes beyond the limit.
    }
    chunks.push(buf);
  }
  if (tooLarge) throw new RequestBodyTooLargeError('request body too large');
  const data = Buffer.concat(chunks).toString('utf8');
  if (!data) return {};
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// 递归列文件（相对路径 + 大小），限制深度与数量避免超大工作区；
// 跳过 VCS 内部目录（.git）与依赖目录（node_modules）——它们不是 run 的产物
const LIST_FILES_SKIP_DIRS = new Set(['.git', 'node_modules']);

function listFiles(
  root: string,
  rel = '',
  depth = 0,
  out: { name: string; size: number }[] = [],
  limit = 500,
): typeof out {
  if (out.length >= limit || depth > 6) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= limit) break;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!LIST_FILES_SKIP_DIRS.has(e.name)) listFiles(root, child, depth + 1, out, limit);
    } else if (e.isFile()) {
      try {
        out.push({ name: child, size: fs.statSync(path.join(root, child)).size });
      } catch {
        /* 忽略不可读 */
      }
    }
  }
  return out;
}

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

// 文件读取：仅允许访问该 Run 绑定的 Workspace Root（字符串 + realpath 双重校验）
function readFileChecked(
  root: string,
  rel: string,
): { ok: true; content: string; name: string } | { ok: false; error: string } {
  try {
    if (rel === '' || rel === '.' || rel.includes('..'))
      return { ok: false, error: '非法相对路径' };
    const real = resolveWorkspacePath(root, rel);
    assertInsideRoot(root, real);
    const st = fs.statSync(real);
    if (st.isDirectory()) return { ok: false, error: '是目录，非文件' };
    if (st.size > MAX_FILE_BYTES) return { ok: false, error: '文件过大' };
    const content = fs.readFileSync(real, 'utf8');
    return { ok: true, name: rel, content };
  } catch {
    return { ok: false, error: '路径被拒绝或不存在' };
  }
}

// 图片二进制读取：与 readFileChecked 同一套路径校验，返回 Buffer + MIME，
// 供 <img src> 直接预览（前端附件缩略图 / read 读图结果都走这个端点）。
function readImageChecked(
  root: string,
  rel: string,
): { ok: true; buffer: Buffer; mimeType: string } | { ok: false; error: string } {
  try {
    if (rel === '' || rel === '.' || rel.includes('..'))
      return { ok: false, error: '非法相对路径' };
    const mimeType = IMAGE_EXT_MIME[path.extname(rel).toLowerCase()];
    if (!mimeType) return { ok: false, error: '不支持的图片类型' };
    const real = resolveWorkspacePath(root, rel);
    assertInsideRoot(root, real);
    const st = fs.statSync(real);
    if (st.isDirectory()) return { ok: false, error: '是目录，非文件' };
    if (st.size > MAX_IMAGE_FILE_BYTES) return { ok: false, error: '图片过大' };
    return { ok: true, buffer: fs.readFileSync(real), mimeType };
  } catch {
    return { ok: false, error: '路径被拒绝或不存在' };
  }
}

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

  // Read-only, path-free runtime capability projection. The private sandbox
  // manifest never leaves the process; this endpoint is for diagnostics/UI.
  if (s.length === 2 && s[0] === 'runtime' && s[1] === 'capabilities' && method === 'GET') {
    return sendJson(res, 200, { capabilities: getRuntimeToolchainCapabilities() });
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

  if (s[0] === 'settings') {
    try {
      if (s.length === 3 && s[1] === 'pi-ai' && s[2] === 'providers' && method === 'GET') {
        // pi-ai 内置 Provider 的公开目录：只返回可选 Provider、模型能力和默认地址，
        // 不执行认证解析，也不把任何 API key 返回给浏览器。
        return sendJson(res, 200, { providers: listPiAiProviderCatalog() });
      }
      if (s.length === 2 && s[1] === 'models') {
        if (method === 'GET') {
          try {
            const views = manager.listModelProviders();
            return sendJson(res, 200, { models: views });
          } catch (err) {
            console.error('[settings] list models failed', err);
            return bad(res, 'list_models_failed');
          }
        }
        if (method === 'POST') {
          requireJsonContentType(req);
          checkOrigin(req, port);
          requireAuth(req);
          let body: CreateModelProviderInput;
          try {
            body = (await readBody(req)) as unknown as CreateModelProviderInput;
          } catch (err) {
            if (err instanceof RequestBodyTooLargeError) {
              return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
            }
            throw err;
          }
          try {
            if (
              typeof body.name !== 'string' ||
              typeof body.baseUrl !== 'string' ||
              !Array.isArray(body.models)
            ) {
              return bad(res, 'invalid_request_body');
            }
            if (body.piProviderId !== undefined && typeof body.piProviderId !== 'string') {
              return bad(res, 'invalid_request_body');
            }
            const created = manager.addModelProvider(body);
            return sendJson(res, 201, created);
          } catch (err) {
            console.error('[settings] add model failed', err);
            return bad(res, (err as Error).message || 'add_model_failed');
          }
        }
        return notFound(res);
      }
      if (s.length === 3 && s[1] === 'models') {
        const id = s[2];
        // 仅接受 UUID（自定义 Provider 的 id 全部为 UUID；内置模板已移除）
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        if (!isUuid) {
          return bad(res, 'invalid_model_id');
        }
        if (method === 'PATCH') {
          requireJsonContentType(req);
          checkOrigin(req, port);
          requireAuth(req);
          let body: UpdateModelProviderInput;
          try {
            body = (await readBody(req)) as unknown as UpdateModelProviderInput;
          } catch (err) {
            if (err instanceof RequestBodyTooLargeError) {
              return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
            }
            throw err;
          }
          try {
            if (body.name !== undefined && typeof body.name !== 'string') {
              return bad(res, 'invalid_request_body');
            }
            if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') {
              return bad(res, 'invalid_request_body');
            }
            if (
              body.apiKey !== undefined &&
              body.apiKey !== null &&
              typeof body.apiKey !== 'string'
            ) {
              return bad(res, 'invalid_request_body');
            }
            if (body.models !== undefined && !Array.isArray(body.models)) {
              return bad(res, 'invalid_request_body');
            }
            const updated = manager.updateModelProvider(id, body);
            if (!updated) return notFound(res);
            return sendJson(res, 200, updated);
          } catch (err) {
            console.error('[settings] update model failed', err);
            return bad(res, (err as Error).message || 'update_model_failed');
          }
        }
        if (method === 'DELETE') {
          checkOrigin(req, port);
          requireAuth(req);
          const ok = manager.deleteModelProvider(id);
          if (!ok) return notFound(res);
          return sendJson(res, 200, { deleted: true });
        }
        return notFound(res);
      }
      if (s.length === 2 && s[1] === 'default' && method === 'POST') {
        requireJsonContentType(req);
        checkOrigin(req, port);
        requireAuth(req);
        let body: Record<string, unknown>;
        try {
          body = await readBody(req);
        } catch {
          return bad(res, 'invalid_request_body');
        }
        const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
        if (!providerId) return bad(res, 'providerId is required');
        // 未知 provider → 404；存在但未配置密钥/无模型/模型不在目录 → 400
        if (!manager.getModelProvider(providerId)) return notFound(res);
        const model = typeof body.model === 'string' ? body.model.trim() : undefined;
        if (model !== undefined && !model) return bad(res, 'model must be non-empty when provided');
        try {
          const result = manager.setDefaultModel(providerId, model);
          return sendJson(res, 200, {
            defaultProviderId: result.providerId,
            defaultModelId: result.modelId,
          });
        } catch (err) {
          return bad(res, (err as Error).message);
        }
      }
      if (s.length === 1 && s[0] === 'settings' && method === 'GET') {
        return sendJson(res, 200, {
          defaultProviderId: manager.getDefaultProviderId(),
          defaultModelId: manager.getDefaultModelId(),
        });
      }
      if (s.length === 2 && s[1] === 'available-models' && method === 'POST') {
        // 拉取 OpenAI 兼容端点的可用模型目录。凭证只来自服务端已保存配置，
        // 禁止客户端通过此接口外带 Secret 或指定任意 endpoint（SSRF 防线）。
        // 新增 Provider 时的临时预检走独立接口 /settings/available-models/preview。
        requireJsonContentType(req);
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
        const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
        if (!providerId) return bad(res, 'providerId is required');
        const provider = manager.getModelProvider(providerId);
        if (!provider) return bad(res, 'provider not found or not configured');
        const secret = manager.getModelProviderSecret(providerId);
        if (!secret?.apiKey) return bad(res, 'provider has no API key configured');
        // 协议白名单 + 规范化：仅 https: 或本地 loopback http:（开发模式）
        let targetUrl: string;
        try {
          targetUrl = canonicalizeProviderBaseUrl(provider.baseUrl, { allowLoopbackHttp: true });
        } catch (err) {
          return bad(res, (err as Error).message || 'baseUrl protocol not allowed');
        }
        try {
          const catalog = await fetchAvailableModelCatalog(targetUrl, secret.apiKey);
          manager.recordModelProbe(providerId, { status: 'available' });
          return sendJson(res, 200, {
            models: catalog.map((model) => model.id),
            catalog,
          });
        } catch (err) {
          const message = (err as Error).message;
          manager.recordModelProbe(providerId, { status: 'error', error: message });
          return bad(res, message);
        }
      }
      if (
        s.length === 3 &&
        s[1] === 'available-models' &&
        s[2] === 'preview' &&
        method === 'POST'
      ) {
        // 新增 Provider 时的临时预检：用表单中的 baseUrl + apiKey 拉取模型目录。
        // 凭证不落盘、不进日志、不回显；仍受 fetchAvailableModelsSafe 保护
        // （协议白名单、凭证拒绝、loopback 限制、响应大小限制）。需鉴权。
        requireJsonContentType(req);
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
        const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        if (!baseUrl || !apiKey) return bad(res, 'baseUrl and apiKey are required');
        // 协议白名单 + 规范化：仅 https: 或本地 loopback http:（开发模式）
        let targetUrl: string;
        try {
          targetUrl = canonicalizeProviderBaseUrl(baseUrl, { allowLoopbackHttp: true });
        } catch (err) {
          return bad(res, (err as Error).message || 'baseUrl protocol not allowed');
        }
        try {
          const catalog = await fetchAvailableModelCatalog(targetUrl, apiKey);
          return sendJson(res, 200, {
            models: catalog.map((model) => model.id),
            catalog,
          });
        } catch (err) {
          return bad(res, (err as Error).message);
        }
      }
      return notFound(res);
    } catch (err) {
      if (err instanceof Error && err.message === 'untrusted origin') {
        return bad(res, 'untrusted origin');
      }
      if (err instanceof Error && err.message === 'missing or invalid authorization') {
        return bad(res, 'missing or invalid authorization');
      }
      if (err instanceof Error && err.message === 'Content-Type must be application/json') {
        return bad(res, 'invalid_content_type');
      }
      throw err;
    }
  }

  // Current Workspace: the native picker is Host-owned because browsers do
  // not reveal arbitrary absolute local paths. Normal responses expose name only.
  if (s[0] === 'workspace') {
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
    return notFound(res);
  }

  if (s[0] === 'sessions') {
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
          ...modelSelection,
        });
        return sendJson(res, 202, { ...created, status: 'running', permissionMode });
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
    case 'events': {
      if (method !== 'GET') return notFound(res);
      // SSE：验证 token（通过 Authorization header，不使用 query）
      checkOrigin(req, port);
      requireAuth(req);
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
