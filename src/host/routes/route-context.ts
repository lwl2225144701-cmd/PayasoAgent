// 模块: 路由公共约束 —— 鉴权 / Body 解析 / 响应与错误封装。
//
// 为什么单独存在：拆分前的 routes.ts 把「分发逻辑」与「HTTP 公共约束」混在一个
// 文件里。公共约束是所有资源域 handler 共用的基础（鉴权、Origin 校验、请求体
// 上限、统一响应），拆出来后各 handler 只关心自己的资源语义，约束有唯一 owner。
//
// 契约：
// - `hostApiToken` 是本模块唯一模块级状态（进程内存，不进入 URL/日志/前端状态）；
//   `setHostApiToken` 与 `checkOrigin` / `requireAuth` 共享同一份 token。
// - `readBody` 超限抛 `RequestBodyTooLargeError`（调用方 catch 后回 413）；
//   校验失败抛普通 Error（调用方 catch 后回 400）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  type PermissionMode,
} from '../../permission-mode.js';
import type { CreateRunAttachmentInput } from '../run-manager.js';

// JSON 请求体上限：消息可携带 base64 图片附件（4 张 × ≤8MB 原始 → base64 膨胀 ~1.33 倍）。
// 常规 JSON 请求体上限；视觉附件端点（/runs 与 /sessions/:id/runs）单独放宽：
// 客户端已把每张图压到 ≤2MiB（P2），4 张 + base64 膨胀 ≈ ≤12MB。
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export { MAX_ATTACHMENT_BODY_BYTES } from '../../attachment-policy.js';
import { attachmentKind, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from '../../attachment-policy.js';

export const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/; // 与 Sandbox 的 runId 规则一致
export const SAFE_SESSION_ID = SAFE_RUN_ID;

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

export function checkOrigin(req: IncomingMessage, hostPort: number): void {
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

export function requireAuth(req: IncomingMessage): void {
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

export function requireJsonContentType(req: IncomingMessage): void {
  const ct = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!ct.includes('application/json')) {
    throw new Error('Content-Type must be application/json');
  }
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const b = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(b),
  });
  res.end(b);
}
export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'not_found' });
}
export function bad(res: ServerResponse, msg: string): void {
  sendJson(res, 400, { error: 'bad_request', message: msg });
}

export function segs(req: IncomingMessage): string[] {
  return (req.url ?? '/').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
}

export class RequestBodyTooLargeError extends Error {}

export async function readBody(
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

export function requestPermissionMode(value: unknown): PermissionMode {
  if (value === undefined) return DEFAULT_PERMISSION_MODE;
  if (!isPermissionMode(value)) throw new Error('invalid_permission_mode');
  return value;
}

export function requestModelSelection(body: Record<string, unknown>): {
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
export function requestAttachments(body: Record<string, unknown>): CreateRunAttachmentInput[] {
  if (body.attachments === undefined) return [];
  if (!Array.isArray(body.attachments)) throw new Error('attachments 必须是数组');
  if (body.attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`附件最多 ${MAX_ATTACHMENTS} 个`);
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
    const kind = attachmentKind(name, mimeType);
    if (!kind) throw new Error(`${label} 仅支持图片和 UTF-8 文本/代码文件`);
    if (typeof item.dataBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) {
      throw new Error(`${label} 数据非法`);
    }
    const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    if (dataBase64.length > Math.ceil(limit / 3) * 4) throw new Error(`${label} 超过大小上限`);
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.toString('base64') !== dataBase64) throw new Error(`${label} 数据非法`);
    if (bytes.length > limit) throw new Error(`${label} 超过大小上限`);
    return { name, mimeType: kind === 'text' ? 'text/plain' : mimeType, dataBase64 };
  });
}
