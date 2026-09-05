// 模块: Host API 入口 — 启动 Payaso Host Server
// 用法: npm run host   （PORT 环境变量可覆盖端口，默认 4500）

import { createHostServer } from "./server.js";
import { RunManager } from "./run-manager.js";
import { createDefaultRunStore } from "./persistence/sqlite-store.js";
import { createSecretStore } from "./secrets/secret-store.js";

const port = Number(process.env.PORT ?? 4500);
// 组合根：SecretStore 在这里创建一次并注入（macOS = Keychain；测试替换为 MemorySecretStore）
const secretStore = createSecretStore();
const manager = new RunManager(createDefaultRunStore(secretStore));

// Host API Token（进程内存唯一，不进入 URL/日志/前端状态）
const HOST_API_TOKEN = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
import { setHostApiToken } from "./routes.js";
setHostApiToken(HOST_API_TOKEN);
console.log(`[auth] Host API token ready (do not share)`);

const server = createHostServer(manager, HOST_API_TOKEN);

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
  console.log(`  POST /runs/:id/files/*/open  用默认浏览器打开 HTML`);
  console.log(`  GET  /workspace            当前 Workspace`);
  console.log(`  POST /workspace/open       打开本地文件夹`);
console.log(`  GET  /runtime/capabilities 受控运行时能力（不含宿主路径）`);
console.log(`  POST /runtime/capabilities/refresh 重新检测已准备的宿主工具`);
console.log(`  POST /runs/:id/toolchain-preparation 用户批准受控工具链准备`);
});

// 优雅退出：异步幂等关闭
let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 15_000; // 略大于 RunManager 的 10s 等待

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，开始关闭...`);

  // 停止接收新 HTTP 连接
  server.close(() => {
    console.log("HTTP server 已停止接收新连接");
  });

  // 强制退出兜底 timer（覆盖完整 shutdown deadline）
  const forceTimer = setTimeout(() => {
    console.log("Shutdown timeout，强制退出");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref?.();

  try {
    await manager.close();
    console.log("RunManager 已关闭");
    if (forceTimer) clearTimeout(forceTimer);
    process.exit(0);
  } catch (err) {
    console.error("Shutdown error:", err);
    process.exit(1);
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}
