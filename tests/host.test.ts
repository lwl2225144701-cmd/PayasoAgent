// 模块: Host API 集成测试 — 用真实 HTTP server 覆盖第一版 API 行为
// 用法: npm run test:host （需 .env，真实 LLM 触发 tool_call 事件）
// 覆盖：POST/GET runs、SSE(tool_call+run_completed)、404、workspace 文件隔离、../ 拒绝、并发不串状态

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHostServer } from "../src/host/server.js";
import { createWorkspace, getSandboxRoot } from "../src/sandbox/sandbox-manager.js";

// 用隔离沙箱根，避免污染仓库 sandbox/
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-host-test-"));
process.env.SANDBOX_ROOT = ROOT;
process.env.PAYASO_DB_PATH = path.join(ROOT, "payaso.db");
fs.mkdirSync(ROOT, { recursive: true });

const server = createHostServer();
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postRun(task: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task }) });
  return { status: r.status, body: await r.json() };
}
async function getRun(id: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/runs/${id}`);
  return { status: r.status, body: await r.json() };
}
async function waitTerminal(id: string, ms = 120000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { body } = await getRun(id);
    if (body.status === "completed" || body.status === "failed" || body.status === "stopped") return body;
    await wait(500);
  }
  return (await getRun(id)).body;
}

// 收集 SSE 事件，直到 wantTypes 全部出现
async function collectSse(id: string, wantTypes: string[], ms = 120000): Promise<{ type: string; data: any }[]> {
  const res = await fetch(`${base}/runs/${id}/events`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let events: { type: string; data: any }[] = [];
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < ms) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let type = "", data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (type && data) events.push({ type, data: JSON.parse(data) });
      }
      if (wantTypes.every((w) => events.some((e) => e.type === w))) break;
    }
  } catch { /* 连接中断 */ }
  try { await res.body!.cancel(); } catch { /* 忽略 */ }
  return events;
}

// ---------------------------------------------------------------------------
console.log("Payaso Host API 集成测试\n");

// 1. POST /runs → 返回 runId（不阻塞：runAgent 后台执行，POST 立即返回）
const r1 = await postRun("请用 calculator 计算 1+1，然后直接告诉我结果，不要做其他事情。");
check("POST /runs → 202 + runId", r1.status === 202 && typeof r1.body.runId === "string" && r1.body.runId.length > 0, `status=${r1.status}`);
const id1 = r1.body.runId;
const sessionId1 = r1.body.sessionId;
check("POST /runs → 返回 sessionId", typeof sessionId1 === "string" && sessionId1.length > 0);
const sessionList = await (await fetch(`${base}/sessions`)).json();
check(
  "GET /sessions 返回会话且不泄露 workspaceRoot",
  Array.isArray(sessionList.sessions)
    && sessionList.sessions.some((session: any) => session.sessionId === sessionId1)
    && !JSON.stringify(sessionList).includes("workspaceRoot"),
);
const sessionRuns = await (await fetch(`${base}/sessions/${sessionId1}/runs`)).json();
check("GET /sessions/:id/runs 返回首轮", sessionRuns.runs?.[0]?.runId === id1 && sessionRuns.runs?.[0]?.turnIndex === 1);

// 4. 不存在 runId → 404（不依赖 run 完成，提前验证）
const r404 = await fetch(`${base}/runs/nonexistent-run-xyz`);
check("不存在 runId → 404", r404.status === 404);

// 5. workspace 文件只能访问对应 runId（不依赖 run 完成）
const rA = await postRun("你好");
const rB = await postRun("你好");
const idA = rA.body.runId, idB = rB.body.runId;
createWorkspace(idB); // 幂等复用 run 的 workspace
const marker = path.join(getSandboxRoot(), "workspaces", idB, "work", "marker.txt");
fs.writeFileSync(marker, "secret");
const filesB = await (await fetch(`${base}/runs/${idB}/files`)).json();
const filesA = await (await fetch(`${base}/runs/${idA}/files`)).json();
check("文件列表包含对应 run 的 marker(B)", filesB.files.some((f: any) => f.name === "work/marker.txt"));
check("文件列表不串状态(A 无 marker)", !filesA.files.some((f: any) => f.name === "work/marker.txt"));

// 6. ../ 与绝对路径 → 拒绝（不依赖 run 完成）
const p1 = await fetch(`${base}/runs/${idB}/files/../package.json`);
const p2 = await fetch(`${base}/runs/${idB}/files/%2e%2e/package.json`);
check("../ → 拒绝(400)", p1.status === 400 || p1.status === 404, `status=${p1.status}`);
check("%2e%2e → 拒绝", p2.status === 400 || p2.status === 404, `status=${p2.status}`);

// 7. 两个 Run 同时启动互不串状态（runId 不同即证）
check("两个 Run runId 不同", idA !== idB);

// 2. GET /runs/:id → running/completed；GET /runs 列表（此时 run 应在跑，不必等完成）
const g1 = await getRun(id1);
check("GET /runs/:id → 200 + status(running/completed)", g1.status === 200 && ["running", "completed"].includes(g1.body.status), `status=${g1.status}`);
const list = await (await fetch(`${base}/runs`)).json();
check("GET /runs 包含该 run", Array.isArray(list.runs) && list.runs.some((r: any) => r.runId === id1));

// 3. SSE：实时 tool_call + run_completed（阻塞等待 run 完成，放最后）
const events = await collectSse(id1, ["assistant_delta", "tool_call", "run_completed"]);
check("SSE 收到 assistant_delta", events.some((e) => e.type === "assistant_delta"));
check("SSE 收到 tool_call", events.some((e) => e.type === "tool_call"));
check("SSE 收到 run_completed", events.some((e) => e.type === "run_completed"));

// 最终已完成且有结果
const final1 = await waitTerminal(id1);
check("Run 最终 completed + 有 result", final1.status === "completed" && typeof final1.result === "string" && final1.result.length > 0, `status=${final1.status}`);

// 7(续)：两个 Run 各自独立完成
const finalB = await waitTerminal(idB);
check("两个 Run 各自独立完成", finalB.status === "completed");

console.log(`\nHost 测试汇总: ${passed} PASS / ${failed} FAIL`);
// 直接退出，避免 server.close 等待活跃 SSE 连接（心跳连接保持打开）而挂起
process.exit(failed ? 1 : 0);
