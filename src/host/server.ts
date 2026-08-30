// 模块: Host HTTP Server — node:http 轻量服务，wire routes + RunManager
// 无第三方依赖。SSE 优先（events 用 text/event-stream）。

import http from "node:http";
import type { ServerResponse } from "node:http";
import { handleRequest } from "./routes.js";
import { RunManager } from "./run-manager.js";
import { setHostApiToken } from "./routes.js";

// 创建 Host Server（可注入 RunManager，便于测试）
export function createHostServer(manager: RunManager = new RunManager(), apiToken?: string): http.Server {
  // 总是设置 hostApiToken：有 token 则启用鉴权，无 token 则重置为空（跳过鉴权）
  setHostApiToken(apiToken ?? "");
  const server = http.createServer((req, res: ServerResponse) => {
    const hostPort = Number(req.socket.localPort) ?? 4500;
    handleRequest(req, res, manager, hostPort).catch((err) => {
      if (!res.writableEnded) {
        console.error("[server] unhandled request error:", err);
        const b = JSON.stringify({ error: "internal" });
        res.writeHead(500, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) });
        res.end(b);
      }
    });
  });
  return server;
}

export { RunManager };
