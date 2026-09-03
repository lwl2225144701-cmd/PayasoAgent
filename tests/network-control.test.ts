// 模块: Network Control (v2.0) 单元测试
// 覆盖：
// - 默认网络模式 = "on"（默认允许联网）
// - setNetworkMode 幂等 / 非法值拒绝
// - network=off 时：capabilities.network=true 的工具（shell）被统一拒绝（NetworkDeniedError）
// - network=off 时：非网络工具（read/write）不受影响
// - network=on（默认）：网络工具正常执行
// - Tool 注册时 capabilities 缺省 = 无网络能力
// - Schema 不泄露 capabilities/networkMode 内部字段

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_NETWORK_MODE,
  getNetworkMode,
  isNetworkMode,
  setNetworkMode,
  storedNetworkMode,
} from "../src/network-mode.js";
import {
  execute,
  getTool,
  getSchemas,
  NetworkDeniedError,
  needsNetworkApproval,
  toolRequiresNetwork,
  type ToolContext,
} from "../src/tools/tools.js";
import { denyAllApprovalPort, type ApprovalPort, type NetworkApprovalRequest } from "../src/runtime/approval-port.js";
import "../src/tools/filesystem.js"; // read/write/ls
import "../src/tools/runtime-tools.js"; // shell（capabilities.network=true）
import { createWorkspace, cleanupWorkspace } from "../src/sandbox/sandbox-manager.js";
import { probeSandboxAvailability } from "../src/sandbox/macos-sandbox.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-network-"));
process.env.SANDBOX_ROOT = base;
const RUN = "network-control-test";
const root = createWorkspace(RUN);
const ctx: ToolContext = { runId: RUN, workspaceRoot: root };

let passed = 0;
let failed = 0;
const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// ---- 1. 默认网络模式 ----
test("默认网络模式 = on（默认允许联网）", () => {
  assert.equal(DEFAULT_NETWORK_MODE, "on");
  assert.equal(getNetworkMode(), "on");
});

test("storedNetworkMode 回退默认 on（未知/非法值）", () => {
  assert.equal(storedNetworkMode(undefined), "on");
  assert.equal(storedNetworkMode("whatever"), "on");
  assert.equal(storedNetworkMode("on"), "on");
  assert.equal(storedNetworkMode("off"), "off");
  assert.equal(storedNetworkMode("ask"), "ask");
});

test("isNetworkMode 只认 on/off/ask", () => {
  assert.ok(isNetworkMode("on"));
  assert.ok(isNetworkMode("off"));
  assert.ok(isNetworkMode("ask"));
  assert.ok(!isNetworkMode("allowlist"));
  assert.ok(!isNetworkMode(1));
});

// ---- 2. setNetworkMode ----
test("setNetworkMode 幂等设置 on/off", () => {
  setNetworkMode("on");
  assert.equal(getNetworkMode(), "on");
  setNetworkMode("off");
  assert.equal(getNetworkMode(), "off");
  setNetworkMode("on");
  assert.equal(getNetworkMode(), "on");
});

test("setNetworkMode 非法值拒绝（抛错且状态不变）", () => {
  const before = getNetworkMode();
  assert.throws(() => setNetworkMode("allowlist" as "on"), /非法网络模式/);
  assert.equal(getNetworkMode(), before);
});

// ---- 3. 注册时能力声明 ----
test("shell 声明 capabilities.network=true", () => {
  const shell = getTool("shell")!;
  assert.equal(toolRequiresNetwork(shell), true);
});

test("read/write 未声明网络能力（缺省无网络）", () => {
  assert.equal(toolRequiresNetwork(getTool("read")!), false);
  assert.equal(toolRequiresNetwork(getTool("write")!), false);
  assert.equal(toolRequiresNetwork(getTool("ls")!), false);
});

test("capabilities 不进入 LLM Schema", () => {
  const json = JSON.stringify(getSchemas());
  assert.ok(!json.includes("capabilities"), "Schema 泄露 capabilities");
  assert.ok(!json.includes("networkMode"), "Schema 泄露 networkMode 内部字段");
});

// ---- 4. network=on：网络工具正常执行（sandbox 可用时验证；否则 SKIP）----
test("network=on 时 shell 可执行（不联网命令正常）", async () => {
  if (!(await probeSandboxAvailability())) {
    console.log("  [SKIP] sandbox-exec 不可用，跳过 shell 可执行验证");
    return;
  }
  setNetworkMode("on");
  const res = await execute("shell", { command: "printf ok" }, ctx);
  assert.ok(res.includes("ok"), `结果: ${res}`);
});

// ---- 5. network=off：网络工具被统一拒绝 ----
test("network=off 时 shell 被拒（NetworkDeniedError）", async () => {
  setNetworkMode("off");
  await assert.rejects(
    () => execute("shell", { command: "printf nope" }, ctx),
    (err: Error) =>
      err instanceof NetworkDeniedError &&
      err.toolName === "shell" &&
      err.message.includes("Network is disabled"),
  );
  setNetworkMode("on");
});

test("network=off 时拒绝消息明确且稳定", async () => {
  setNetworkMode("off");
  try {
    await execute("shell", { command: "echo x" }, ctx);
    assert.fail("应当被拒绝");
  } catch (err) {
    assert.ok((err as Error).message.includes("network.mode=off"));
  }
  setNetworkMode("on");
});

// ---- 6. network=off：非网络工具不受影响 ----
test("network=off 时 read/write 正常执行（无网络能力不受开关影响）", async () => {
  setNetworkMode("off");
  await execute("write", { path: "work/net-off.txt", content: "hello" }, ctx);
  const res = await execute("read", { path: "work/net-off.txt" }, ctx);
  assert.equal(res, "hello");
  setNetworkMode("on");
});

// ---- 7. NetworkDeniedError 语义 ----
test("NetworkDeniedError 是结构化错误（instanceof + toolName）", () => {
  const err = new NetworkDeniedError("shell");
  assert.ok(err instanceof Error);
  assert.equal(err.toolName, "shell");
  assert.ok(err.message.includes("requires network access"));
});

// ---- 8. ask 模式（JIT Approval）----
test("needsNetworkApproval：ask + 网络工具 → true，其余 → false", () => {
  const shell = getTool("shell")!;
  const read = getTool("read")!;
  assert.equal(needsNetworkApproval(shell, "ask"), true);
  assert.equal(needsNetworkApproval(shell, "on"), false);
  assert.equal(needsNetworkApproval(shell, "off"), false);
  assert.equal(needsNetworkApproval(read, "ask"), false);
});

test("ask 模式：execute 放行（批准由 pipeline 前置，工具不感知）", async () => {
  if (!(await probeSandboxAvailability())) {
    console.log("  [SKIP] sandbox-exec 不可用，跳过 ask 模式 shell 验证");
    return;
  }
  setNetworkMode("ask");
  // 单元层直接 execute 不经过 agent 批准逻辑；这里验证 ask 模式不会在 execute 层误拒
  const res = await execute("shell", { command: "printf ask-mode" }, ctx);
  assert.ok(res.includes("ask-mode"), `结果: ${res}`);
  setNetworkMode("on");
});

test("denyAllApprovalPort 默认拒绝（fail-closed）", async () => {
  const port = denyAllApprovalPort;
  const req: NetworkApprovalRequest = {
    runId: "r1",
    toolName: "shell",
    args: { command: "curl x" },
    timestamp: new Date().toISOString(),
  };
  assert.equal(await port.request(req), false);
});

test("自定义 ApprovalPort：批准/拒绝语义直接生效", async () => {
  let called = false;
  const port: ApprovalPort = {
    async request(req) {
      called = true;
      assert.equal(req.toolName, "shell");
      assert.equal(req.runId, RUN);
      assert.ok(req.timestamp);
      return true; // 批准
    },
  };
  assert.equal(await port.request({ runId: RUN, toolName: "shell", args: {}, timestamp: new Date().toISOString() }), true);
  assert.ok(called);
});

// ---- 汇总 ----
(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  [FAIL] ${t.name} — ${(err as Error).message}`);
    }
  }
  setNetworkMode("on"); // 恢复默认，避免污染其他测试
  cleanupWorkspace(RUN);
  fs.rmSync(base, { recursive: true, force: true });
  console.log(`\nNetwork Control 测试汇总: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exit(1);
  else console.log("验收：默认联网、全局开关、网络工具统一拒绝、非网络工具不受影响、审计字段 ✓");
})();