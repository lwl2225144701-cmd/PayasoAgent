// 模块: HTTP 路由 — 把浏览器请求映射到 RunManager + Sandbox + 静态文件
// 边界：Host 只通过 RunManager/Runtime 公开边界工作；路径一律经 Sandbox resolvePath 校验。
// 静态文件：生产环境从 web/dist/ 提供前端构建产物；非 /runs/* 走静态文件服务 + SPA fallback。

import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { RunManager, type SseSink } from "./run-manager.js";
import {
  resolvePath,
  assertInsideWorkspace,
  getSandboxRoot,
} from "../sandbox/sandbox-manager.js";

const MAX_FILE_BYTES = 1024 * 1024; // 读文件大小上限
const MAX_STATIC_BYTES = 5 * 1024 * 1024; // 静态资源大小上限（含 JS bundle）
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/; // 与 Sandbox 的 runId 规则一致
const WORKSPACE_DIRS = ["input", "work", "output"];

// 静态文件根目录：项目根/web/dist/（server 从项目根启动，process.cwd() 为项目根）
const STATIC_ROOT = path.resolve(process.cwd(), "web", "dist");

// 白名单 MIME 类型
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const b = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) });
  res.end(b);
}
function notFound(res: ServerResponse): void { sendJson(res, 404, { error: "not_found" }); }
function bad(res: ServerResponse, msg: string): void { sendJson(res, 400, { error: "bad_request", message: msg }); }

// 安全地提供静态文件：禁止路径穿越，仅白名单后缀，支持 SPA fallback
function serveStatic(res: ServerResponse, urlPath: string): void {
  try {
    // 解析请求路径（去掉 query string，decode）
    let rel = decodeURIComponent(urlPath.split("?")[0]);
    if (rel.startsWith("/")) rel = rel.slice(1);
    // 根路径或空路径 → index.html
    if (!rel) rel = "index.html";

    // 禁止路径穿越
    if (rel.includes("..")) { res.writeHead(403); res.end("forbidden"); return; }

    // 解析绝对路径并校验在 STATIC_ROOT 内
    const abs = path.resolve(STATIC_ROOT, rel);
    const relFromRoot = path.relative(STATIC_ROOT, abs);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
      res.writeHead(403); res.end("forbidden"); return;
    }

    // 尝试读取文件
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        // 目录 → 尝试 index.html
        return serveStatic(res, "/" + rel.replace(/\/+$/, "") + "/index.html");
      }
      if (st.size > MAX_STATIC_BYTES) {
        res.writeHead(413); res.end("file too large"); return;
      }
      const ext = path.extname(abs).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const content = fs.readFileSync(abs);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": content.length,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      });
      res.end(content);
      return;
    } catch {
      // 文件不存在 → SPA fallback（返回 index.html）
      // 但 API 路径（/runs/*）不应 fallback，已在主分发中前置处理
      const indexPath = path.join(STATIC_ROOT, "index.html");
      try {
        const idx = fs.readFileSync(indexPath);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": idx.length,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-cache",
        });
        res.end(idx);
        return;
      } catch {
        // dist 目录不存在（开发模式直接访问 4500），返回提示
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!DOCTYPE html><html><head><meta charset='utf-8'><title>PayasoAgent</title></head>" +
          "<body style='font-family:sans-serif;display:flex;align-items:center;justify-content:center;" +
          "height:100vh;margin:0;background:#f8f9fa;color:#333;'>" +
          "<div style='text-align:center'>" +
          "<h2>🤡 PayasoAgent Host 已启动</h2>" +
          "<p>API 服务运行中 · 端口 4500</p>" +
          "<p>前端开发模式请访问 <a href='http://localhost:5173'>http://localhost:5173</a></p>" +
          "<p>生产模式请先运行 <code>npm run build:web</code> 构建前端</p>" +
          "</div></body></html>"
        );
        return;
      }
    }
  } catch {
    res.writeHead(500); res.end("internal error");
  }
}

function segs(req: IncomingMessage): string[] {
  return (req.url ?? "/").split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = "";
  for await (const chunk of req) data += chunk;
  if (!data) return {};
  try { return JSON.parse(data) as Record<string, unknown>; } catch { return {}; }
}

function workspaceRoot(runId: string): string {
  return path.join(getSandboxRoot(), "workspaces", runId);
}

// 递归列文件（相对路径 + 大小），限制深度与数量避免超大工作区
function listFiles(root: string, rel = "", depth = 0, out: { name: string; size: number }[] = [], limit = 500): typeof out {
  if (out.length >= limit || depth > 6) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (out.length >= limit) break;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) listFiles(root, child, depth + 1, out, limit);
    else {
      try { out.push({ name: child, size: fs.statSync(path.join(root, child)).size }); }
      catch { /* 忽略不可读 */ }
    }
  }
  return out;
}

// SSE：实时推送 Run 事件（回放历史 + 实时）
function handleSse(req: IncomingMessage, res: ServerResponse, manager: RunManager, runId: string): void {
  if (!manager.get(runId)) { notFound(res); return; }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  const sink = sinkOf(res);
  manager.subscribe(runId, sink);
  const heartbeat = setInterval(() => { res.write(": ping\n\n"); }, 15000);
  res.on("close", () => { clearInterval(heartbeat); manager.unsubscribe(runId, sink); });
}
function sinkOf(res: ServerResponse): SseSink {
  return { write: (c) => res.write(c), end: () => res.end(), closed: () => res.writableEnded };
}

// 文件读取：仅允许访问当前 runId workspace 内路径（resolvePath + assertInsideWorkspace 双重校验）
function readFileChecked(runId: string, rel: string): { ok: true; content: string; name: string } | { ok: false; error: string } {
  try {
    if (rel === "" || rel === "." || rel.includes("..")) return { ok: false, error: "非法相对路径" };
    const real = resolvePath(runId, rel);
    assertInsideWorkspace(runId, real);
    const st = fs.statSync(real);
    if (st.isDirectory()) return { ok: false, error: "是目录，非文件" };
    if (st.size > MAX_FILE_BYTES) return { ok: false, error: "文件过大" };
    const content = fs.readFileSync(real, "utf8");
    return { ok: true, name: rel, content };
  } catch {
    return { ok: false, error: "路径被拒绝或不存在" };
  }
}

// 主分发
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager
): Promise<void> {
  const s = segs(req);
  const method = req.method ?? "GET";

  // 非 /runs/* → 静态文件服务（含 SPA fallback）
  if (s[0] !== "runs") {
    // 仅 GET/HEAD 允许访问静态文件
    if (method !== "GET" && method !== "HEAD") { res.writeHead(405); res.end("method not allowed"); return; }
    return serveStatic(res, req.url ?? "/");
  }

  // GET /runs · POST /runs
  if (s.length === 1) {
    if (method === "GET") return sendJson(res, 200, { runs: manager.list() });
    if (method === "POST") {
      const body = await readBody(req);
      const task = typeof body.task === "string" ? body.task.trim() : "";
      if (!task) return bad(res, "缺少 task");
      const newRunId = manager.create(task);
      return sendJson(res, 202, { runId: newRunId, status: "running" });
    }
    return notFound(res);
  }

  const runId = s[1];
  if (!SAFE_RUN_ID.test(runId)) return bad(res, "非法 runId");

  // GET /runs/:id
  if (s.length === 2 && method === "GET") {
    const run = manager.get(runId);
    return run ? sendJson(res, 200, run) : notFound(res);
  }

  if (s.length < 3) { notFound(res); return; }

  switch (s[2]) {
    case "events": {
      if (method !== "GET") return notFound(res);
      return handleSse(req, res, manager, runId);
    }
    case "resume": {
      if (method !== "POST") return notFound(res);
      return manager.resume(runId) ? sendJson(res, 202, { runId, status: "running" }) : notFound(res);
    }
    case "stop": {
      if (method !== "POST") return notFound(res);
      return manager.stop(runId) ? sendJson(res, 202, { runId, status: "stopped" }) : notFound(res);
    }
    case "files": {
      if (method !== "GET") return notFound(res);
      // GET /runs/:id/files → 列文件
      if (s.length === 3) {
        const run = manager.get(runId);
        if (!run) return notFound(res);
        const files = listFiles(workspaceRoot(runId));
        return sendJson(res, 200, { runId, files });
      }
      // GET /runs/:id/files/<rel> → 读文件
      const rel = s.slice(3).join("/");
      const read = readFileChecked(runId, rel);
      return read.ok ? sendJson(res, 200, { runId, name: read.name, content: read.content }) : bad(res, read.error);
    }
    default:
      return notFound(res);
  }
}