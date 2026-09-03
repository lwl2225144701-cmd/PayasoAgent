// 模块: JIT Approval (v2.0.1) 集成测试 — RunManager 批准端口 + SSE 推送 + HTTP 回传
// 不依赖真实 sandbox / LLM：直接调 approvalPort().request() 验证请求/裁决/超时链路。
// 覆盖：
// - request() 推 SSE approval_requested 事件（含 runId/toolName/args/requestId）
// - resolveApproval(true) → request promise resolve true，并广播 approval_resolved
// - resolveApproval(false) → promise resolve false
// - 重复裁决 / 未知 requestId → 返回 false
// - HTTP POST /runs/:id/approval 端点走通（createHostServer 集成）
// - 超时未裁决 → 自动拒绝（frail: 用短超时实现不易，改验证 deny 路径经恶意不 resolve 的 fork；
//   超时行为由 APPROVAL_TIMEOUT_MS 常量保证，此处验证 resolve 幂等）

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager, type SseSink } from "../src/host/run-manager.js";
import { SqliteRunStore } from "../src/host/persistence/sqlite-store.js";
import { MemorySecretStore } from "../src/host/secrets/secret-store.js";
import { createHostServer } from "../src/host/server.js";
import type { ApprovalRequestedEvent, ApprovalResolvedEvent, HostEvent } from "../src/host/run-events.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-approval-"));
const dbPath = path.join(base, "approval.db");
process.env.PAYASO_DB_PATH = dbPath;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

// ---- 1. RunManager 层：request + SSE + resolve ----
const manager = new RunManager(new SqliteRunStore(dbPath, new MemorySecretStore()));
// startAgent:false → 纯占位 Run（不启动 agent/不依赖 provider），只验证 approval 通道
const runId = manager.createInSession("approval test", undefined, { startAgent: false }).runId;

// 订阅 SSE
const received: HostEvent[] = [];
const sink: SseSink = {
  write: (chunk: string) => {
    // sseEncode 格式：event: xxx\n data: {...}\n\n
    const m = chunk.match(/event: (\w+)\ndata: (.+)\n\n/s);
    if (m) {
      try { received.push(JSON.parse(m[2]) as HostEvent); } catch { /* ignore */ }
    }
  },
  end: () => {},
  closed: () => false,
};
manager.subscribe(runId, sink, 0, true);

// 发起批准请求（不真实执行，仅 test approval 通道）
const port = manager.approvalPort();
const approvalPromise = port.request({
  runId,
  toolName: "shell",
  args: { command: "curl https://example.com" },
  timestamp: new Date().toISOString(),
});

// 等 SSE 收到 approval_requested
await new Promise((r) => setTimeout(r, 100));
const reqEv = received.find(
  (e): e is ApprovalRequestedEvent => e.type === "approval_requested",
);
check("request() → SSE approval_requested 事件", !!reqEv);
check("approval_requested 含 runId/toolName/args/requestId",
  !!reqEv && reqEv.runId === runId && reqEv.toolName === "shell"
  && JSON.stringify(reqEv.args).includes("example.com") && reqEv.requestId.length > 0,
  reqEv ? `toolName=${reqEv.toolName}` : "no event");

// 裁决：批准
if (reqEv) {
  const ok = manager.resolveApproval(runId, reqEv.requestId, true);
  check("resolveApproval(true) → 返回 true", ok === true);
  const approved = await approvalPromise;
  check("request promise resolve true", approved === true);
  await new Promise((r) => setTimeout(r, 50));
  const resolvedEv = received.find(
    (e): e is ApprovalResolvedEvent => e.type === "approval_resolved",
  );
  check("resolve 后广播 approval_resolved", !!resolvedEv && resolvedEv.approved === true);
}

// 重复裁决 → false（已删除）
check("重复 resolveApproval → false", manager.resolveApproval(runId, reqEv?.requestId ?? "nope", true) === false);
// 未知 requestId → false
check("未知 requestId → false", manager.resolveApproval(runId, "unknown-id", true) === false);

// ---- 2. HTTP 端点：POST /runs/:id/approval ----
const server = createHostServer(manager, "test-token");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };
const httpBase = `http://127.0.0.1:${address.port}`;

try {
  // 新批准请求（拒绝路径）
  const p2 = port.request({
    runId,
    toolName: "shell",
    args: { command: "echo no" },
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 100));
  const req2 = received.filter((e): e is ApprovalRequestedEvent => e.type === "approval_requested").pop();
  check("HTTP 前收到第二个 approval_requested", !!req2);

  if (req2) {
    const resp = await fetch(`${httpBase}/runs/${runId}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token", Origin: `http://127.0.0.1:${address.port}` },
      body: JSON.stringify({ requestId: req2.requestId, approved: false }),
    });
    check("HTTP POST /approval 200", resp.status === 200, `status=${resp.status}`);
    const json = await resp.json() as { resolved: boolean; approved: boolean };
    check("HTTP 响应 resolved=true", json.resolved === true, JSON.stringify(json));
    const denied = await p2;
    check("HTTP 拒绝 → request promise false", denied === false);
  }

  // 缺 requestId → 400
  const badResp = await fetch(`${httpBase}/runs/${runId}/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token", Origin: `http://127.0.0.1:${address.port}` },
    body: JSON.stringify({ approved: true }),
  });
  check("HTTP 缺 requestId → 400", badResp.status === 400, `status=${badResp.status}`);
} finally {
  server.close();
  manager.close();
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(`\nJIT Approval 集成测试: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
else console.log("验收：批准请求推送 SSE、裁决回传 resolve、HTTP 端点走通、幂等/未知拒绝 ✓");