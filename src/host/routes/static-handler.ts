import { MAX_PDF_BYTES } from '../../attachment-policy.js';
// 模块: 静态资源与工作区文件读取 —— 白名单 MIME、路径穿越防护、SPA fallback。
//
// 为什么单独存在：静态服务（web/dist 产物 + SPA fallback）与 Run 工作区内的
// 文件读取（列表/文本/图片二进制）都只依赖「路径 + 文件系统」，不依赖任何资源域
// handler。拆出后 routes.ts 的静态兜底与 runs/files 端点共用同一套实现。

import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { webStaticRoot } from '../../app-paths.js';
import { assertInsideRoot, resolveWorkspacePath } from '../../sandbox/sandbox-manager.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 文本文件读取上限
const MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024; // 图片附件/预览上限（与 read 读图一致）
const MAX_STATIC_BYTES = 5 * 1024 * 1024; // 静态资源大小上限（含 JS bundle）

// 静态文件跟随安装包，不依赖用户启动目录。
const STATIC_ROOT = webStaticRoot;

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

// files 端点可直接返回二进制的图片扩展名（<img src> 直接预览）。
export const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// 安全地提供静态文件：禁止路径穿越，仅白名单后缀，支持 SPA fallback
export function serveStatic(res: ServerResponse, urlPath: string): void {
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
        'Cache-Control':
          ext === '.html' || rel === 'manifest.json'
            ? 'no-cache'
            : 'public, max-age=31536000, immutable',
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

// 递归列文件（相对路径 + 大小），限制深度与数量避免超大工作区；
// 跳过 VCS 内部目录（.git）与依赖目录（node_modules）——它们不是 run 的产物
const LIST_FILES_SKIP_DIRS = new Set(['.git', 'node_modules']);

export function listFiles(
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

// 文件读取：仅允许访问该 Run 绑定的 Workspace Root（字符串 + realpath 双重校验）
export function readFileChecked(
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
export function readImageChecked(
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

// 下载与文本/图片预览共用工作区边界，但返回原始字节。
export function readDownloadChecked(root: string, rel: string): { ok: true; buffer: Buffer } | { ok: false; error: string } {
  try {
    if (!rel || rel === '.' || rel.includes('..')) return { ok: false, error: '非法相对路径' };
    const real = resolveWorkspacePath(root, rel);
    assertInsideRoot(root, real);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_PDF_BYTES) return { ok: false, error: '文件类型或大小不支持下载' };
    return { ok: true, buffer: fs.readFileSync(real) };
  } catch { return { ok: false, error: '路径被拒绝或不存在' }; }
}
