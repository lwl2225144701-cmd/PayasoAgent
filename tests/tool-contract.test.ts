// 模块: Tool 调用契约单元测试 — 验证 runId 安全边界（无 LLM，秒级完成）
// 用法: npx tsx tests/tool-contract.test.ts   （或 npm run test:contract）
// 验证：Schema 无 runId / Runtime 注入正确 runId / args 无法覆盖 runId / 现有工具行为不变

import assert from "node:assert/strict";
import {
  register,
  execute,
  getSchemas,
  resolveOperationKey,
  type Tool,
  type ToolContext,
} from "../src/tools/tools.js";

interface Case {
  name: string;
  fn: () => void | Promise<void>;
}
const tests: Case[] = [];
let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// 探测工具：把收到的注入上下文与参数原样返回，验证注入与不可覆盖
// 注意：description 中不得出现 runId 等内部字段名（LLM 可见的任何 Schema 文案都不允许泄露）
register({
  name: "probeRunId",
  description: "测试用：回显注入上下文与传入参数",
  effect: "idempotent", // 纯回显，无副作用
  parameters: { type: "object", properties: {} },
  execute: async (args, context) =>
    JSON.stringify({
      gotRunId: context.runId,
      argRunId: (args.runId as string) ?? null,
    }),
});

console.log("Tool 调用契约单元测试\n");

// ---- 1. Tool Schema 中不存在 runId ----
test("Tool Schema 中不存在 runId（LLM 不可见）", () => {
  const json = JSON.stringify(getSchemas());
  assert.ok(!json.includes("runId"), 'Schema 中出现 "runId"');
});

// ---- 2. Runtime execute 时 Tool 能拿到正确 runId ----
test("execute 注入正确 runId（Tool 从 context 获取）", async () => {
  const res = await execute("probeRunId", {}, { runId: "RUN-ABC-123" });
  assert.deepEqual(JSON.parse(res), { gotRunId: "RUN-ABC-123", argRunId: null });
});

test("不同 runId 注入正确（每次调用独立）", async () => {
  const a = await execute("probeRunId", {}, { runId: "run-a" });
  const b = await execute("probeRunId", {}, { runId: "run-b" });
  assert.equal(JSON.parse(a).gotRunId, "run-a");
  assert.equal(JSON.parse(b).gotRunId, "run-b");
});

// ---- 3. LLM 无法通过 args 覆盖 Runtime runId ----
test("args 携带 runId 无法覆盖 context.runId", async () => {
  // 即使 LLM（或恶意构造的 tool_call）在 args 里塞了 runId，工具看到的仍必须是 context 注入值
  const res = await execute("probeRunId", { runId: "HACKED" }, { runId: "RUN-REAL" });
  const parsed = JSON.parse(res);
  assert.equal(parsed.gotRunId, "RUN-REAL"); // 工具契约：只信 context
  assert.equal(parsed.argRunId, "HACKED"); // args 里的 runId 只是普通数据，不被当作身份
});

// ---- 4. 现有 calculator / getWeather 行为不变 ----
const ctx: ToolContext = { runId: "behavior-run" };

test("calculator 行为不变（15*37 → 555）", async () => {
  const res = await execute("calculator", { expression: "15*37" }, ctx);
  assert.equal(res, "计算结果: 15*37 = 555");
});

test("calculator 行为不变（非法表达式抛错）", async () => {
  await assert.rejects(() => execute("calculator", { expression: "x+1" }, ctx));
});

test("calculator 行为不变（0/0 → NaN 仍由 validateResult 判无效）", async () => {
  const res = await execute("calculator", { expression: "0/0" }, ctx);
  assert.equal(res, "计算结果: 0/0 = NaN");
});

test("getWeather 行为不变（深圳 → 28°C）", async () => {
  const res = await execute("getWeather", { city: "深圳" }, ctx);
  assert.equal(res, "天气: 深圳 28°C, 晴");
});

test("getWeather 行为不变（未收录城市抛错）", async () => {
  await assert.rejects(() => execute("getWeather", { city: "火星" }, ctx));
});

// ---- 5. v1.3 契约收紧：effect / getOperationKey ----
// 核心原则：高风险副作用（non_idempotent）必须显式定义"什么叫同一个操作"，
// 注册期强制校验；read / idempotent 可省略 getOperationKey（回退 JSON.stringify(args)）。

// 尝试注册工具，返回是否注册失败（抛错）
function registerFails(tool: Tool): boolean {
  try {
    register(tool);
    return false;
  } catch {
    return true;
  }
}

// ---- 5.1 注册期强制校验 ----
test("non_idempotent + 无 getOperationKey → 注册失败（抛错）", () => {
  assert.ok(
    registerFails({
      name: "badNonIdempotent",
      description: "测试用：非幂等但未声明操作键，必须注册失败",
      effect: "non_idempotent",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
    }),
    "non_idempotent 无 getOperationKey 应注册失败"
  );
});

test("non_idempotent + 有 getOperationKey → 注册成功", () => {
  assert.ok(
    !registerFails({
      name: "goodNonIdempotent",
      description: "测试用：非幂等且显式声明操作键，应注册成功",
      effect: "non_idempotent",
      parameters: { type: "object", properties: {} },
      getOperationKey: (args) => `write:${args.path}:${args.content}`,
      execute: async () => "ok",
    })
  );
});

test("read + 无 getOperationKey → 注册成功（回退 JSON.stringify）", () => {
  assert.ok(
    !registerFails({
      name: "readNoKey",
      description: "测试用：read 省略操作键，应注册成功",
      effect: "read",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
    })
  );
});

test("idempotent + 无 getOperationKey → 注册成功（回退 JSON.stringify）", () => {
  assert.ok(
    !registerFails({
      name: "idempotentNoKey",
      description: "测试用：idempotent 省略操作键，应注册成功",
      effect: "idempotent",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
    })
  );
});

// ---- 5.2 resolveOperationKey 回退/禁止回退语义 ----
test("resolveOperationKey：read/idempotent 回退 JSON.stringify(args)", () => {
  const readTool: Tool = { name: "r", description: "d", effect: "read", parameters: {}, execute: async () => "x" };
  const idemTool: Tool = { name: "i", description: "d", effect: "idempotent", parameters: {}, execute: async () => "x" };
  assert.equal(resolveOperationKey(readTool, { a: 1 }), JSON.stringify({ a: 1 }));
  assert.equal(resolveOperationKey(idemTool, { b: "2" }), JSON.stringify({ b: "2" }));
});

test("resolveOperationKey：non_idempotent 使用显式 canonical key（不回退）", () => {
  const tool: Tool = {
    name: "w",
    description: "d",
    effect: "non_idempotent",
    parameters: {},
    getOperationKey: (args) => `w:${args.path}:${args.content}`,
    execute: async () => "x",
  };
  assert.equal(resolveOperationKey(tool, { path: "a", content: "x" }), "w:a:x");
  assert.notEqual(
    resolveOperationKey(tool, { path: "a", content: "x" }),
    JSON.stringify({ path: "a", content: "x" })
  );
});

test("resolveOperationKey：non_idempotent 无 getOperationKey → 抛错（禁止回退）", () => {
  const tool: Tool = { name: "b", description: "d", effect: "non_idempotent", parameters: {}, execute: async () => "x" };
  assert.throws(() => resolveOperationKey(tool, { a: 1 }));
});

// ---- 5.3 契约字段不泄露给 LLM（与 runId 同级别的安全边界）----
test("Tool Schema 不泄露 effect / getOperationKey", () => {
  const json = JSON.stringify(getSchemas());
  assert.ok(!json.includes("effect"), 'Schema 中出现 "effect"');
  assert.ok(!json.includes("getOperationKey"), 'Schema 中出现 "getOperationKey"');
});

// ---- 汇总 ----
async function main(): Promise<void> {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failed++;
      const msg = (err as Error).message;
      failures.push(`${t.name} — ${msg}`);
      console.log(`  [FAIL] ${t.name} — ${msg}`);
    }
  }
  console.log("\n" + "=".repeat(56));
  console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) {
    failures.forEach((f) => console.log(`  FAIL ${f}`));
    process.exit(1);
  }
  console.log("验收：runId 边界成立（LLM 不可见、Runtime 注入、args 不可覆盖）+ effect/getOperationKey 契约成立 ✓");
}

main();
