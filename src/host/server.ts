// 模块: Host HTTP Server — node:http 轻量服务，wire routes + RunManager
// 无第三方依赖。SSE 优先（events 用 text/event-stream）。

import http from "node:http";
import type { ServerResponse } from "node:http";
import { handleRequest } from "./routes.js";
import { RunManager } from "./run-manager.js";

// 创建 Host Server（可注入 RunManager，便于测试）
export function createHostServer(manager: RunManager = new RunManager()): http.Server {
  const server = http.createServer((req, res: ServerResponse) => {
    handleRequest(req, res, manager).catch(() => {
      if (!res.writableEnded) {
        const b = JSON.stringify({ error: "internal" });
        res.writeHead(500, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) });
        res.end(b);
      }
    });
  });
  server.once("close", () => manager.close());
  return server;
}

export { RunManager };
