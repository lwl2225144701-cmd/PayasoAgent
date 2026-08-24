// 模块: Host API 入口 — 启动 Payaso Host Server
// 用法: npm run host   （PORT 环境变量可覆盖端口，默认 4500）

import { createHostServer } from "./server.js";

const port = Number(process.env.PORT ?? 4500);
const server = createHostServer();

server.listen(port, () => {
  console.log(`Payaso Host API listening on http://localhost:${port}`);
  console.log(`  POST /runs                创建 Run`);
  console.log(`  GET  /runs                列出 Run`);
  console.log(`  GET  /runs/:id            单个 Run 状态`);
  console.log(`  POST /runs/:id/resume     恢复 Run`);
  console.log(`  POST /runs/:id/stop       停止 Run（受限）`);
  console.log(`  GET  /runs/:id/events     SSE 事件流`);
  console.log(`  GET  /runs/:id/files      列 workspace 文件`);
  console.log(`  GET  /runs/:id/files/*    读 workspace 文件`);
});

// 优雅退出：关闭 SSE 连接
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，关闭 server...`);
    server.close(() => process.exit(0));
    // 兜底：强制退出
    setTimeout(() => process.exit(0), 2000).unref?.();
  });
}