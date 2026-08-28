// 模块: Host API 入口 — 启动 Payaso Host Server
// 用法: npm run host   （PORT 环境变量可覆盖端口，默认 4500）

import { createHostServer } from "./server.js";
import { RunManager } from "./run-manager.js";

const port = Number(process.env.PORT ?? 4500);
const manager = new RunManager();

// 一次性把 .env 的环境模型配置导入设置并设为默认：
// 仅在从未导入过时生效；之后模型配置一律以设置面板为准。
if (process.env.OPENAI_API_KEY) {
  const imported = manager.importEnvModelProvider({
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  });
  if (imported) {
    console.log(`[settings] 已从环境变量导入模型配置并设为默认: ${imported.modelId}`);
  }
}

const server = createHostServer(manager);

server.listen(port, "127.0.0.1", () => {
  console.log(`Payaso Host API listening on http://localhost:${port}`);
  console.log(`  POST /runs                创建 Run`);
  console.log(`  GET  /runs                列出 Run`);
  console.log(`  GET  /runs/:id            单个 Run 状态`);
  console.log(`  POST /runs/:id/resume     恢复 Run`);
  console.log(`  POST /runs/:id/stop       停止 Run（受限）`);
  console.log(`  GET  /runs/:id/events     SSE 事件流`);
  console.log(`  GET  /runs/:id/files      列 workspace 文件`);
  console.log(`  GET  /runs/:id/files/*    读 workspace 文件`);
  console.log(`  GET  /workspace            当前 Workspace`);
  console.log(`  POST /workspace/open       打开本地文件夹`);
});

// 优雅退出：关闭 SSE 连接
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，关闭 server...`);
    // Close SSE and SQLite before waiting for node:http connections to drain.
    manager.close();
    server.close(() => process.exit(0));
    // 兜底：强制退出
    setTimeout(() => process.exit(0), 2000).unref?.();
  });
}
