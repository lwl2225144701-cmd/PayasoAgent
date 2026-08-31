// 集成验证: Tool Output Guard 生效后，large-read-700k 不再撑爆 Context
// 走真实 runAgent + scripted LLM server。逐阶段测量 UTF-8 bytes 并断言修复目标。
// 修复前: scratchpad=700KB / system=1400KB / request#2≈1461KB / tool_output_truncated=0
// 修复后: guarded<=16KB / scratchpad<=16KB / system<=32KB / request#2 小 / tool_output_truncated=1 / Agent 不崩溃
// 用法: npx tsx tests/diag-large-700k.test.ts
// 只打印大小与必要摘要，不打印 700KB 完整内容。

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { MAX_TOOL_OUTPUT_BYTES } from "../src/runtime/output-guard.js";
import { createAgentExecutionContext } from "../src/bootstrap/runtime-bootstrap.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-diag700k-"));
process.env.SANDBOX_ROOT = TEST_ROOT;
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_MODEL = "test-model";

const LINE = "The quick brown fox jumps over the lazy dog. 0123456789\n"; // 51 bytes
const TARGET = 700 * 1024;
const runId = "diag-700k";

let llmCalls = 0;
const requestBytes: number[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += String(c)));
  req.on("end", () => {
    llmCalls++;
    requestBytes.push(Buffer.byteLength(body, "utf8"));
    let message: Record<string, unknown>;
    if (llmCalls === 1) {
      message = {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "listDir", arguments: JSON.stringify({ path: "input" }) } },
          { id: "c2", type: "function", function: { name: "readFile", arguments: JSON.stringify({ path: "input/big.txt" }) } },
        ],
      };
    } else {
      message = { role: "assistant", content: "最终答案：任务结束（确定性脚本）" };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
});

const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;

let exitCode = 0;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
const { runAgent } = await import("../src/runtime/agent.js");
const { loadCheckpoint } = await import("../src/runtime/checkpoint.js");
const { createWorkspace } = await import("../src/sandbox/sandbox-manager.js");

const ws = createWorkspace(runId);
fs.writeFileSync(path.join(ws, "input", "big.txt"), LINE.repeat(Math.ceil(TARGET / LINE.length)));
const rawResultBytes = fs.statSync(path.join(ws, "input", "big.txt")).size;

const logs: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => {
  logs.push(a.map((x) => String(x)).join(" "));
};

let answer = "";
let agentErr = "";
try {
  answer = await runAgent("请读取 input/big.txt，然后告诉我这个文件有多大（字节数或行数）以及开头的一句话是什么。", undefined, {
    executionContext: createAgentExecutionContext({ runId }),
  });
} catch (e) {
  agentErr = (e as Error).message;
} finally {
  console.log = origLog;
}

// ---- 从日志解析 tool_output_truncated 事件（trace 不持久化，从 printEvent 输出 `[Trace] {...}` 取）----
const truncEvents = logs
  .filter((l) => l.includes('"type":"tool_output_truncated"'))
  .map((l) => {
    const start = l.indexOf("{");
    const end = l.lastIndexOf("}");
    return JSON.parse(l.slice(start, end + 1)) as { originalBytes: number; returnedBytes: number };
  });

const cp = loadCheckpoint(runId);
const readStep = cp?.scratchpad.completedSteps.find((s: { tool: string }) => s.tool === "readFile");
const scratchpadBytes = readStep ? Buffer.byteLength(String(readStep.result), "utf8") : 0;
const systemMsg = cp?.messages.find((m: { role: string }) => m.role === "system");
const systemPromptBytes = systemMsg ? Buffer.byteLength(String(systemMsg.content ?? ""), "utf8") : 0;
const request2Bytes = requestBytes[1] ?? 0;

console.log("=".repeat(72));
console.log("large-read-700k — Output Guard 修复后逐阶段字节");
console.log("=".repeat(72));
console.log(`rawResultBytes（readFile 返回，validate 前）: ${kb(rawResultBytes)}`);
console.log(`guardedResultBytes（Output Guard 后，trace returnedBytes）: ${truncEvents.length ? kb(truncEvents[0].returnedBytes) : "无截断事件"}`);
console.log(`tool_output_truncated 事件次数           : ${truncEvents.length}`);
console.log(`  originalBytes = ${truncEvents.length ? truncEvents[0].originalBytes : 0}`);
console.log(`  returnedBytes = ${truncEvents.length ? kb(truncEvents[0].returnedBytes) : 0}`);
console.log(`scratchpadBytes（completedSteps.result） : ${kb(scratchpadBytes)}`);
console.log(`systemPromptBytes（system 消息）        : ${kb(systemPromptBytes)}`);
console.log(`finalLLMRequestBytes request#1          : ${kb(requestBytes[0] ?? 0)}`);
console.log(`finalLLMRequestBytes request#2          : ${kb(request2Bytes)}`);
console.log(`Agent 是否崩溃                         : ${agentErr ? `是（${agentErr.slice(0, 60)}）` : "否"}`);

// ---- 断言（修复目标）----
try {
  assert.equal(agentErr, "", "Agent 不应崩溃");
  assert.ok(truncEvents.length >= 1, "应触发 tool_output_truncated（>=1）");
  assert.ok(truncEvents[0].returnedBytes <= MAX_TOOL_OUTPUT_BYTES, "guarded returnedBytes 应 <=16KB");
  assert.ok(scratchpadBytes <= MAX_TOOL_OUTPUT_BYTES + 64, "scratchpad 不应再保存 700KB（应 <=16KB）");
  assert.ok(systemPromptBytes <= MAX_TOOL_OUTPUT_BYTES * 2 + 64, "system prompt 应 <= ~32KB（16KB×2 容忍）");
  assert.ok(request2Bytes < 100 * 1024, "finalLLMRequest#2 不应再达 1.4MB（应 <100KB）");
  console.log("\n验收：700KB 被 Output Guard 截断为 <=16KB，scratchpad/system/request 全部受限，Agent 不崩溃 ✓");
} catch (e) {
  console.log(`\n[FAIL] ${(e as Error).message}`);
  exitCode = 1;
}

try {
  fs.rmSync(ws, { recursive: true, force: true });
} catch {
  /* 忽略 */
}
server.close();
try {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
} catch {
  /* 忽略 */
}
process.exit(exitCode);
