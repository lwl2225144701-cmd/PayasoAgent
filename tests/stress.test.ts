// 套件: Runtime 高强度压测 — 用现有 Tool / Sandbox / Retry / Recovery / Output Guard / Side-Effect Safety 打 Runtime
// 目标: 优先找真实缺口，不提前加新机制。发现 FAIL 保留现场与日志，不顺手修复。
// 用法:
//   npx tsx --env-file=.env tests/stress.test.ts                      # 编排器：顺序跑全部场景
//   npx tsx --env-file=.env tests/stress.test.ts --scenario <id>      # 单场景 worker（供编排器派生）
//   npx tsx --env-file=.env tests/stress.test.ts --scenario <id> --resume <runId>
// 日志: .stress-logs/<id>.log （FAIL 场景保留 workspace 与 checkpoint）
// 不修改 src/；测试夹具工具仅在此 worker 进程内注册。

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkspace,
  cleanupWorkspace,
  resolvePath,
  assertInsideWorkspace,
  getSandboxRoot,
} from "../src/sandbox/sandbox-manager.js";
import { register, execute, type ToolContext } from "../src/tools/tools.js";
import { runAgent } from "../src/runtime/agent.js";
import { createAgentExecutionContext, createDefaultRuntimeServices } from "../src/bootstrap/runtime-bootstrap.js";
import { loadCheckpoint, checkpointPath } from "../src/persistence/file-checkpoint-store.js";

const PROJECT_ROOT = process.cwd();
const LOG_DIR = path.join(PROJECT_ROOT, ".stress-logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

// ================= 测试夹具工具（仅在 worker 进程生效；不修改 src/） =================
// appendEntry —— non_idempotent 计数器，真实副作用写 work/append.log（跨进程可验证）
const appendJournal: Record<string, number> = {};
register({
  name: "appendEntry",
  description: "向指定 bucket 追加一行内容（模拟非幂等写入）。参数: bucket, content",
  effect: "non_idempotent",
  parameters: {
    type: "object",
    properties: { bucket: { type: "string" }, content: { type: "string" } },
    required: ["bucket", "content"],
  },
  getOperationKey: (args) => `entry:${args.bucket}:${args.content}`,
  execute: async (args, context) => {
    const k = `entry:${args.bucket}:${args.content}`;
    appendJournal[k] = (appendJournal[k] ?? 0) + 1;
    const f = resolvePath(context.runId, "work/append.log");
    fs.appendFileSync(f, `${k}\n`, "utf8");
    return `已写入 ${args.bucket}/${args.content}（key=${k} 第${appendJournal[k]}次）`;
  },
});

// flakyWrite —— 非幂等，前 N 次瞬时失败后成功（重试 + 去重联动）
let flakyCount = 0;
register({
  name: "flakyWrite",
  description: "写入一条日志，偶发瞬时失败，重试后成功。参数: content",
  effect: "non_idempotent",
  parameters: {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"],
  },
  getOperationKey: (args) => `flaky:${args.content}`,
  execute: async (args) => {
    flakyCount++;
    const failN = Number(process.env.FLAKY_FAIL_N ?? "2");
    if (flakyCount <= failN) throw new Error(`flaky 瞬时失败（第${flakyCount}次尝试）`);
    return `flaky 写入成功: ${args.content}（第${flakyCount}次尝试）`;
  },
});

// crashTool —— 非幂等，副作用已发生（写日志）后立刻抛异常（模拟 executing 中途崩溃）
const crashJournal: string[] = [];
register({
  name: "crashTool",
  description: "执行一个写操作（写入一行日志）后立刻抛异常，模拟执行中途崩溃。参数: content",
  effect: "non_idempotent",
  parameters: {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"],
  },
  getOperationKey: (args) => `crash:${args.content}`,
  execute: async (args) => {
    crashJournal.push(`WROTE:${args.content}`);
    throw new Error("crash after effect（副作用已发生但 execute 未成功返回）");
  },
});

// slowTool —— 模拟超时（延迟后失败）；Runtime 无超时机制
register({
  name: "slowTool",
  description: "执行一个耗时操作，模拟超时（延迟后失败）。参数: name",
  effect: "idempotent",
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  execute: async (args) => {
    const ms = Number(process.env.SLOW_MS ?? "2500");
    await new Promise((r) => setTimeout(r, ms));
    throw new Error(`timeout（模拟，耗时 ${ms}ms 后未返回结果）`);
  },
});

// ================= 输出捕获（tee 到 cap，供场景分析；[STRESS-RESULT] 走 stdout 不入 cap） =================
const cap: string[] = [];
const origLog = console.log;
const origErr = console.error;
console.log = (...a: unknown[]) => {
  const s = a.map(String).join(" ");
  cap.push(s);
  origLog(...a);
};
console.error = (...a: unknown[]) => {
  const s = a.map(String).join(" ");
  cap.push(s);
  origErr(...a);
};

// ================= 通用工具 =================
// resume 场景：runWorkerScenario 在恢复前快照 checkpoint 的已完成步骤，供场景判定"续跑 vs 重跑"
let resumePreCompleted: string[] = [];

function toolCalls(out: string): { tool: string; args: string }[] {
  return [...out.matchAll(/\[Tool 调用\] (\w+)\((.*)\)/g)].map((m) => ({ tool: m[1], args: m[2] }));
}
function toolErrors(out: string): { tool: string; msg: string }[] {
  return [...out.matchAll(/\[Tool 错误\] (\w+): (.*)/g)].map((m) => ({ tool: m[1], msg: m[2] }));
}
function countOccur(out: string, re: RegExp): number {
  return (out.match(re) ?? []).length;
}
const countRetries = (out: string) => countOccur(out, /\[重试 \d\/\d\]/g);
const sideEffectSkips = (out: string) => countOccur(out, /\[Side-Effect Skip\]/g);
const blockedCount = (out: string) => countOccur(out, /\[Blocked\]/g);
const recoveryCount = (out: string) => countOccur(out, /\[恢复\]/g);
const invalidEvents = (out: string) => countOccur(out, /"type":"tool_result_invalid"/g);
const trimEvents = (out: string) => countOccur(out, /"type":"context_trim"/g);

function readAppendLog(runId: string): string[] {
  const f = path.join(getSandboxRoot(), "workspaces", runId, "work", "append.log");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
}

function expectThrow(fn: () => unknown, label: string, errs: string[]): boolean {
  try {
    fn();
    errs.push(`未按预期拒绝: ${label}`);
    return false;
  } catch {
    return true;
  }
}

// execute 是异步的，必须 await 才能捕获 rejection（同步 try/catch 抓不到）
async function expectReject(fn: () => Promise<unknown>, label: string, errs: string[]): Promise<boolean> {
  try {
    await fn();
    errs.push(`未按预期拒绝: ${label}`);
    return false;
  } catch {
    return true;
  }
}

async function runAgentTask(task: string, runId: string): Promise<{ answer: string; error?: string }> {
  try {
    const answer = await runAgent(task, undefined, {
      executionContext: createAgentExecutionContext({ runId }),
      ...createDefaultRuntimeServices(),
    });
    console.log(`最终答案: ${answer}`);
    return { answer };
  } catch (e) {
    const error = (e as Error).message;
    console.log(`[AgentError] ${error}`);
    return { answer: "", error };
  }
}

// ================= 场景定义 =================
interface Ctx {
  runId: string;
  resumeId?: string;
  answer?: string; // resume 场景由 worker 传入
}
interface Result {
  pass: boolean;
  detail: string;
  metrics?: Record<string, unknown>;
  gap?: string;
  layer?: "tool" | "runtime" | "llm";
}
interface Scenario {
  group: string;
  desc: string;
  e2e: boolean;
  run: (ctx: Ctx) => Promise<Result>;
}

const scenarios: Record<string, Scenario> = {};

// ---------- 场景组 1: 长链任务 ----------
scenarios["longchain-cap"] = {
  group: "longchain",
  desc: "12 步纯计算链，单次运行必超 MAX_ITERATIONS=10",
  e2e: true,
  run: async (ctx) => {
    const task =
      "请严格分步计算，禁止合并表达式，每一步只调用一次 calculator：先算 2*3，再用上一步结果乘 4，" +
      "再用结果乘 5，乘 6，乘 7，乘 8，乘 9，乘 10，乘 11，乘 12，乘 13。每步单独调用工具，直到算出最终结果。";
    const { answer, error } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const calls = toolCalls(out);
    const cp = loadCheckpoint(ctx.runId);
    const done = cp?.scratchpad.completedSteps.length ?? 0;
    const noDup = new Set(calls.map((c) => `${c.tool}|${c.args}`)).size === calls.length;
    const capped = !!error && error.includes("超过最大循环次数限制");
    return {
      pass: false, // 设计 FAIL：任务未完成
      detail: capped
        ? `单次运行被 10 轮迭代硬上限截断：完成 ${done}/${calls.length} 步，任务未完成`
        : `未触发上限，error=${error || "(无)"}，answer=${answer.slice(0, 60)}`,
      metrics: { toolCallTotal: calls.length, completedSteps: done, noDupSteps: noDup, status: cp?.status },
      gap: "runtime: MAX_ITERATIONS=10 硬上限，长链任务单次运行必然失败",
      layer: "runtime",
    };
  },
};

// 编排器驱动的 resume 流程（先跑 longchain-cap 制造失败 checkpoint 再续跑）；场景本身不直接运行
scenarios["longchain-resume"] = {
  group: "longchain",
  desc: "编排器驱动：longchain-cap 失败 checkpoint → resume 续跑验证无重复/丢步骤",
  e2e: true,
  run: async () => ({ pass: true, detail: "（由编排器驱动，不直接运行）" }),
};

scenarios["resume-phase2"] = {
  group: "longchain",
  desc: "resume 续跑（由编排器先跑 longchain-cap 后驱动）",
  e2e: true,
  run: async (ctx) => {
    const out = cap.join("\n");
    const calls = toolCalls(out);
    const cp = loadCheckpoint(ctx.resumeId!);
    const completed = cp?.scratchpad.completedSteps ?? [];
    const stepNums = completed.map((s: { step: number }) => s.step);
    const dupSteps = stepNums.filter((n: number, i: number) => stepNums.indexOf(n) !== i);
    const postSeq = completed.map((s: { tool: string; input: string }) => `${s.tool}|${s.input}`);
    // 续跑判定：头部与恢复前一致（未丢步骤/未重写），且步骤数有增长（未原地重复）
    const headChanged = postSeq
      .slice(0, resumePreCompleted.length)
      .some((v, i) => v !== resumePreCompleted[i]);
    const progressed = postSeq.length > resumePreCompleted.length;
    const answer = ctx.answer ?? "";
    const done = answer.includes("6227020800");
    const pass = dupSteps.length === 0 && progressed && !headChanged;
    return {
      pass,
      detail: `resume 后 completedSteps=${completed.length}（恢复前=${resumePreCompleted.length}）, 恢复后完成=${done}, ` +
        `重复步骤号=${dupSteps.length ? dupSteps.join(",") : "无"}, 头部改写/丢步骤=${headChanged}, ` +
        `答案=${answer.slice(0, 80)}`,
      metrics: { preSteps: resumePreCompleted.length, postSteps: completed.length, dupSteps, headChanged, done, toolSeq: calls.map((c) => c.tool) },
      gap:
        !done && progressed && dupSteps.length === 0
          ? "runtime: resume 沿用 MAX_ITERATIONS 且剩余预算不延长（startIter=iteration-1），长链任务恢复后仍会再次触顶无法完成"
          : undefined,
      layer: dupSteps.length || headChanged ? "runtime" : progressed ? (done ? undefined : "runtime") : "llm",
    };
  },
};

scenarios["longchain-mixed"] = {
  group: "longchain",
  desc: "混合工具 6 步链（listDir/readFile/calculator/getWeather），触发 Context 裁剪",
  e2e: true,
  run: async (ctx) => {
    const ws = createWorkspace(ctx.runId);
    fs.writeFileSync(path.join(ws, "input", "num.txt"), "L=7\n" + "x".repeat(3000));
    fs.writeFileSync(path.join(ws, "work", "a.txt"), "aaa");
    fs.mkdirSync(path.join(ws, "work", "sub"), { recursive: true });
    const task =
      "请严格分步，每步单独调用一个工具，禁止合并：1) 用 listDir 查看 work 目录；2) 用 readFile 读取 input/num.txt；" +
      "3) 用 calculator 计算 文件中的数字乘 100；4) 用 calculator 把上一步结果加 3；5) 用 getWeather 查询北京天气；" +
      "6) 用 calculator 计算 天气温度乘 2。最后把所有中间结果和最终答案告诉我。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const calls = toolCalls(out);
    const cp = loadCheckpoint(ctx.runId);
    const completed = cp?.scratchpad.completedSteps ?? [];
    const stepNums = completed.map((s: { step: number }) => s.step);
    const dupSteps = stepNums.filter((n: number, i: number) => stepNums.indexOf(n) !== i).length;
    const trims = trimEvents(out);
    const readCalls = calls.filter((c) => c.tool === "readFile").length;
    const okAnswer = answer.includes("703") && answer.includes("30");
    return {
      pass: okAnswer && dupSteps === 0 && readCalls <= 1,
      detail: `裁剪事件=${trims}, readFile 次数=${readCalls}, completedSteps=${completed.length}, 答案命中 703&30=${okAnswer}`,
      metrics: { trims, readCalls, completedSteps: completed.length, dupSteps, toolSeq: calls.map((c) => c.tool) },
      layer: !okAnswer ? "llm" : readCalls > 1 || dupSteps > 0 ? "runtime" : undefined,
    };
  },
};

scenarios["longchain-batch"] = {
  group: "longchain",
  desc: "LLM 单轮并行多个 tool_call（3 个 calculator）",
  e2e: true,
  run: async (ctx) => {
    const task =
      "请用 calculator 一次性分别计算 15*37、24*8、11*13 这三个表达式，可以在同一次回复中并行调用多个工具，然后告诉我三个结果。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const cp = loadCheckpoint(ctx.runId);
    const parallelMax = Math.max(
      0,
      ...(cp?.messages ?? [])
        .filter((m) => m.role === "assistant" && m.tool_calls?.length)
        .map((m) => m.tool_calls!.length)
    );
    const ok = answer.includes("555") && answer.includes("192") && answer.includes("143");
    return {
      pass: ok,
      detail: `答案命中 555&192&143=${ok}；单条 assistant 消息最大并行 tool_call=${parallelMax}`,
      metrics: { parallelMax },
      layer: ok ? undefined : "llm",
    };
  },
};

// ---------- 场景组 2: 大输出 ----------
scenarios["large-read-700k"] = {
  group: "large",
  desc: "读取 700KB（<1MB 限）→ 观察 messages/Scratchpad/system 是否被大结果撑爆",
  e2e: true,
  run: async (ctx) => {
    const ws = createWorkspace(ctx.runId);
    const line = "The quick brown fox jumps over the lazy dog. 0123456789\n";
    fs.writeFileSync(path.join(ws, "input", "big.txt"), line.repeat(Math.ceil((700 * 1024) / line.length)));
    const task = "请读取 input/big.txt，然后告诉我这个文件有多大（字节数或行数）以及开头的一句话是什么。";
    const { answer, error } = await runAgentTask(task, ctx.runId);
    const cp = loadCheckpoint(ctx.runId);
    const msgBytes = cp ? JSON.stringify(cp.messages).length : 0;
    const maxMsg = cp ? Math.max(0, ...cp.messages.map((m) => JSON.stringify(m).length)) : 0;
    const sysContent = cp?.messages.find((m) => m.role === "system")?.content ?? "";
    const pad = cp?.scratchpad;
    const padResultLen = (pad?.completedSteps?.[0]?.result ?? "").length;
    const finding = msgBytes > 700 * 1024; // Context 被大结果撑爆
    return {
      pass: !finding && !!answer,
      detail: error
        ? `LLM 错误: ${error}`
        : `msgBytes=${(msgBytes / 1024).toFixed(0)}KB, maxMsg=${(maxMsg / 1024).toFixed(0)}KB, ` +
          `system 注入=${(sysContent.length / 1024).toFixed(0)}KB, completed 首条结果=${(padResultLen / 1024).toFixed(0)}KB`,
      metrics: { msgBytes, maxMsg, sysBytes: sysContent.length, padResultLen, finding },
      gap: finding
        ? "runtime: 单条大结果同时进入 messages 与 Scratchpad，system prompt 每轮全量携带 → Context 撑爆"
        : undefined,
      layer: finding ? "runtime" : error ? "llm" : "tool",
    };
  },
};

scenarios["large-read-oversize"] = {
  group: "large",
  desc: "读取 1.2MB（>1MB 限）→ Output Guard 判 invalid，不塞 Context",
  e2e: true,
  run: async (ctx) => {
    const ws = createWorkspace(ctx.runId);
    fs.writeFileSync(path.join(ws, "input", "big.txt"), ("x".repeat(1024) + "\n").repeat(1200));
    const task = "请读取 input/big.txt 并告诉我它的内容或大小。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const cp = loadCheckpoint(ctx.runId);
    const msgBytes = cp ? JSON.stringify(cp.messages).length : 0;
    const leaked = msgBytes > 50 * 1024;
    const completedHasBig = (cp?.scratchpad.completedSteps ?? []).some(
      (s: { result: string }) => s.result.includes("xxx")
    );
    const inv = invalidEvents(cap.join("\n"));
    const pass = inv >= 1 && !leaked && !completedHasBig;
    return {
      pass,
      detail: `invalid 事件=${inv}, msgBytes=${(msgBytes / 1024).toFixed(0)}KB, completed 含大内容=${completedHasBig}, 答案=${answer.slice(0, 50)}`,
      metrics: { invalidEvents: inv, msgBytes, leaked, completedHasBig },
      layer: pass ? undefined : leaked || completedHasBig ? "runtime" : "tool",
    };
  },
};

scenarios["large-read-binary"] = {
  group: "large",
  desc: "读取 500KB 二进制 → Output Guard 判 invalid，不把二进制喂给 LLM",
  e2e: true,
  run: async (ctx) => {
    const ws = createWorkspace(ctx.runId);
    const buf = Buffer.concat([Buffer.alloc(500 * 1024, 0), Buffer.from("END")]);
    fs.writeFileSync(path.join(ws, "input", "big.bin"), buf);
    const task = "请读取 input/big.bin 并告诉我它的内容。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const cp = loadCheckpoint(ctx.runId);
    const msgJson = cp ? JSON.stringify(cp.messages) : "";
    const nulLeak = msgJson.includes("\u0000");
    const inv = invalidEvents(cap.join("\n"));
    const pass = inv >= 1 && !nulLeak;
    return {
      pass,
      detail: `invalid 事件=${inv}, messages 含 NUL 字节=${nulLeak}, 答案=${answer.slice(0, 50)}`,
      metrics: { invalidEvents: inv, nulLeak },
      layer: pass ? undefined : nulLeak ? "runtime" : "tool",
    };
  },
};

// ---------- 场景组 3: 失败恢复 ----------
scenarios["recover-missing-file"] = {
  group: "recovery",
  desc: "文件不存在 → Retry×3 → Recovery → LLM 换路径",
  e2e: true,
  run: async (ctx) => {
    const ws = createWorkspace(ctx.runId);
    fs.writeFileSync(path.join(ws, "input", "demo.txt"), "hello demo");
    const task = "请读取 input/nope.txt；如果读取失败，就读取 input/demo.txt，并告诉我它的内容。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const errs = toolErrors(out);
    const retries = countRetries(out);
    const ok = answer.includes("hello demo");
    const pass = ok && errs.filter((e) => e.tool === "readFile").length >= 1 && retries >= 2;
    return {
      pass,
      detail: `readFile 错误=${errs.length}, 重试=${retries}, 恢复决策=${recoveryCount(out)}, 最终=${answer.slice(0, 50)}`,
      metrics: { readErr: errs.length, retries, recovery: recoveryCount(out), toolSeq: toolCalls(out).map((c) => c.tool) },
      layer: !ok ? "llm" : undefined,
    };
  },
};

scenarios["recover-mixed-fails"] = {
  group: "recovery",
  desc: "连续不同类型失败（缺失文件/缺失目录/非法表达式）后继续完成",
  e2e: true,
  run: async (ctx) => {
    const task =
      "请依次执行以下 4 步，每步单独调用工具：1) readFile 读取 input/none1.txt；2) listDir 查看 work/none2 目录；" +
      "3) calculator 计算 'x+1'；4) calculator 计算 5*6。请如实报告每步结果并给出最终答案。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const errs = toolErrors(out);
    const cp = loadCheckpoint(ctx.runId);
    const failed = cp?.state.failedToolCalls ?? 0;
    const blocked = blockedCount(out);
    const ok = answer.includes("30");
    // blocked 依赖 LLM 是否重试同一非法参数，不作 pass 硬条件（agent.test 已单独覆盖死循环路径）
    const pass = ok && failed >= 3;
    return {
      pass,
      detail: `失败调用=${failed}, 各类错误=${errs.map((e) => `${e.tool}:${e.msg.slice(0, 18)}`).join(" | ")}, Blocked=${blocked}, 最终=${answer.slice(0, 40)}`,
      metrics: { failedToolCalls: failed, blocked, errors: errs, toolSeq: toolCalls(out).map((c) => c.tool) },
      layer: !ok ? "llm" : undefined,
    };
  },
};

scenarios["recover-invalid-chain"] = {
  group: "recovery",
  desc: "invalid result 链（getWeather=null + 超大文件），下游不得使用无效结果",
  e2e: true,
  run: async (ctx) => {
    const ws = createWorkspace(ctx.runId);
    fs.writeFileSync(path.join(ws, "input", "oversize.txt"), ("y".repeat(1024) + "\n").repeat(1200));
    const task = "请查询深圳的天气并把温度加 10；然后读取 input/oversize.txt 的内容。告诉我结果。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const inv = invalidEvents(out);
    const cp = loadCheckpoint(ctx.runId);
    const completed = cp?.scratchpad.completedSteps ?? [];
    const bad = completed.filter(
      (s: { result: string }) => s.result.includes("temperature") || s.result.includes("yyyy")
    ).length;
    const pass = inv >= 2 && bad === 0;
    return {
      pass,
      detail: `invalid 事件=${inv}, completedSteps 混入无效结果=${bad}, 答案=${answer.slice(0, 50)}`,
      metrics: { invalidEvents: inv, badInCompleted: bad, invalidTotal: cp?.state.invalidToolResults ?? 0 },
      layer: bad > 0 ? "runtime" : pass ? undefined : "llm",
    };
  },
};

scenarios["recover-flaky-retry"] = {
  group: "recovery",
  desc: "non_idempotent 失败 → uncertain 阻断：即使再请求同 key 也不重复执行",
  e2e: true,
  run: async (ctx) => {
    const task = "请调用 flakyWrite 工具写入 content=hello，若失败就用完全相同的参数再次调用它，然后告诉我最终结果。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const errs = toolErrors(out).filter((e) => e.tool === "flakyWrite").length;
    // v1.3.2：non_idempotent 失败即 uncertain → 同 key 不再 execute → 真实执行恒为 1 次（无重复副作用）
    const pass = flakyCount === 1 && errs >= 1;
    return {
      pass,
      detail: `真实执行=${flakyCount}（应=1，uncertain 阻断后不再执行）, flakyWrite 错误=${errs}, 最终=${answer.slice(0, 50)}`,
      metrics: { attempts: flakyCount, errs },
      layer: pass ? undefined : "runtime",
    };
  },
};

scenarios["recover-timeout"] = {
  group: "recovery",
  desc: "夹具：模拟超时（延迟后失败）→ 观察 Runtime 无超时机制",
  e2e: true,
  run: async (ctx) => {
    const task = "请调用 slowTool 工具，参数 name=test，然后告诉我结果。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const errs = toolErrors(out).filter((e) => e.tool === "slowTool").length;
    return {
      pass: !!answer && errs >= 3,
      detail: `slowTool 错误=${errs}（应为 3 次尝试），最终=${answer.slice(0, 50)}`,
      metrics: { errs, retries: countRetries(out) },
      gap: "runtime: 无超时机制，工具可无限阻塞循环直至自身返回/失败",
      layer: "runtime",
    };
  },
};

// ---------- 场景组 4: 副作用安全 ----------
scenarios["se-dedup-same-key"] = {
  group: "sideeffect",
  desc: "同 canonical key 重复请求 → 去重回放，不重复副作用",
  e2e: true,
  run: async (ctx) => {
    const task =
      "请调用 appendEntry 工具写入 bucket=a content=x；然后请再次调用 appendEntry，参数必须与第一次完全相同（bucket=a content=x），不允许改变或省略参数。请报告两次调用的结果。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const reqKeys = toolCalls(out)
      .filter((c) => c.tool === "appendEntry")
      .map((c) => {
        try {
          const j = JSON.parse(c.args);
          return `entry:${j.bucket}:${j.content}`;
        } catch {
          return c.args;
        }
      });
    const log = readAppendLog(ctx.runId);
    const execs = log.filter((l) => l === "entry:a:x").length;
    const sameKeyReqs = reqKeys.filter((k) => k === "entry:a:x").length;
    const skips = sideEffectSkips(out);
    let pass = false;
    let detail = "";
    if (sameKeyReqs >= 2) {
      pass = execs === 1;
      detail = `同 key 请求 ${sameKeyReqs} 次, 真实执行 ${execs} 次, Side-Effect Skip=${skips} → ${pass ? "去重成立" : "去重失败（重复副作用！）"}`;
    } else {
      detail = `LLM 未按要求重复调用（请求 ${sameKeyReqs} 次）→ 无法验证去重（LLM 行为）`;
    }
    return {
      pass,
      detail: `${detail}; 答案=${answer.slice(0, 50)}`,
      metrics: { reqKeys, execCounts: execs, skips, sameKeyReqs },
      layer: pass ? undefined : sameKeyReqs >= 2 ? "runtime" : "llm",
    };
  },
};

scenarios["se-diff-keys"] = {
  group: "sideeffect",
  desc: "不同 canonical key 的合法重复 → 均真实执行，不错杀",
  e2e: true,
  run: async (ctx) => {
    const task =
      "请调用 appendEntry 写入 bucket=a content=x；再调用 appendEntry 写入 bucket=b content=y（这次参数不同）。告诉我两次结果。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const log = readAppendLog(ctx.runId);
    const counts = log.reduce((m, l) => ((m[l] = (m[l] ?? 0) + 1), m), {} as Record<string, number>);
    const ok = counts["entry:a:x"] === 1 && counts["entry:b:y"] === 1;
    return {
      pass: ok,
      detail: `append.log=${JSON.stringify(counts)}, 答案=${answer.slice(0, 50)}`,
      metrics: { counts },
      layer: ok ? undefined : "runtime",
    };
  },
};

scenarios["se-flaky-retry-dedup"] = {
  group: "sideeffect",
  desc: "non_idempotent 失败 → uncertain 阻断：同 key 不重复执行、不伪造回放",
  e2e: true,
  run: async (ctx) => {
    const task =
      "请调用 flakyWrite 工具写入 content=hello。如果失败，请再次使用完全相同的参数调用它。报告结果。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const reqCount = toolCalls(out).filter((c) => c.tool === "flakyWrite").length;
    const errs = toolErrors(out).filter((e) => e.tool === "flakyWrite").length;
    const skips = sideEffectSkips(out);
    // v1.3.2：失败即 uncertain → 同 key 不再 execute（真实执行恒 1 次）；无 succeeded 故不回放（Skip=0）
    const pass = flakyCount === 1 && errs >= 1 && skips === 0;
    return {
      pass,
      detail: `请求=${reqCount} 次, 真实执行=${flakyCount}（应=1）, Skip=${skips}（应=0）, 错误=${errs}, 最终=${answer.slice(0, 50)}`,
      metrics: { reqCount, attempts: flakyCount, skips, errs },
      layer: pass ? undefined : "runtime",
    };
  },
};

scenarios["se-crash-after-effect"] = {
  group: "sideeffect",
  desc: "executing 中途崩溃（副作用已发生但 execute 抛错）→ 不得自动重试，副作用仅执行 1 次",
  e2e: true,
  run: async (ctx) => {
    const task = "请调用 crashTool 工具写入 content=boom，然后告诉我结果。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const execs = crashJournal.length; // 真实副作用执行次数
    const errs = toolErrors(out).filter((e) => e.tool === "crashTool").length;
    // v1.3.1 修复后：non_idempotent 禁止自动 Retry → 副作用仅执行 1 次
    const pass = execs === 1 && errs === 1;
    return {
      pass,
      detail: `crashTool 真实副作用执行 ${execs} 次（修复后不自动重试，仅 1 次），错误=${errs}，最终=${answer.slice(0, 40)}`,
      metrics: { sideEffectExecutions: execs, errors: errs },
      gap: pass
        ? undefined
        : "runtime: non_idempotent 崩溃后仍被多次执行（应禁止自动 Retry）",
      layer: pass ? undefined : "runtime",
    };
  },
};

scenarios["se-resume-phase1"] = {
  group: "sideeffect",
  desc: "进程被杀前执行 appendEntry(a)→(b)，由编排器 SIGKILL（真实崩溃）",
  e2e: true,
  run: async (ctx) => {
    const task =
      "请调用 appendEntry 写入 bucket=a content=x；然后再调用 appendEntry 写入 bucket=b content=y。告诉我两次结果。";
    const sentinel = path.join(LOG_DIR, `${ctx.runId}.sentinel`);
    const iv = setInterval(() => {
      const cp = loadCheckpoint(ctx.runId);
      const se = (cp?.sideEffects ?? []).map((s) => s.key);
      // 两个 appendEntry 副作用都已落入 checkpoint 才触发 sentinel，确保 SIGKILL 发生在副作用完整记录之后
      if (se.includes("appendEntry::entry:a:x") && se.includes("appendEntry::entry:b:y") && !fs.existsSync(sentinel)) {
        fs.writeFileSync(sentinel, new Date().toISOString(), "utf8");
      }
    }, 100);
    const { answer } = await runAgentTask(task, ctx.runId);
    clearInterval(iv);
    return {
      pass: true,
      detail: `phase1 正常结束（未被 kill 前完成）: ${answer.slice(0, 40)}`,
      metrics: { appendLog: readAppendLog(ctx.runId) },
    };
  },
};

// 编排器驱动的崩溃恢复流程（SIGKILL 正在执行 appendEntry 的 worker → resume 验证防重放）；场景本身不直接运行
scenarios["se-resume-crash"] = {
  group: "sideeffect",
  desc: "编排器驱动：SIGKILL 崩溃 → resume 防重放",
  e2e: true,
  run: async () => ({ pass: true, detail: "（由编排器驱动，不直接运行）" }),
};

scenarios["se-resume-phase2"] = {
  group: "sideeffect",
  desc: "resume 防重放：已执行操作回放，不重复副作用",
  e2e: true,
  run: async (ctx) => {
    const runId = ctx.resumeId!;
    const out = cap.join("\n");
    const skips = sideEffectSkips(out);
    const log = readAppendLog(runId);
    // append.log 记录的是 getOperationKey 输出（entry:a:x），不含 toolName 前缀
    const counts = log.reduce((m, l) => ((m[l] = (m[l] ?? 0) + 1), m), {} as Record<string, number>);
    const ok =
      counts["entry:a:x"] === 1 &&
      counts["entry:b:y"] === 1 &&
      !!ctx.answer;
    return {
      pass: ok,
      detail: `resume 后 Side-Effect Skip=${skips}; append.log=${JSON.stringify(counts)}, 最终=${(ctx.answer ?? "").slice(0, 40)}`,
      metrics: { skips, counts },
      layer: ok ? undefined : "runtime",
    };
  },
};

// ---------- 场景组 5: Sandbox 攻击（确定性，无 LLM） ----------
scenarios["sandbox-traversal"] = {
  group: "sandbox",
  desc: "路径穿越 ../ 全拦截",
  e2e: false,
  run: async (ctx) => {
    const runId = ctx.runId;
    const workspaceRoot = createWorkspace(runId);
    const ctx2: ToolContext = { runId, workspaceRoot };
    const errs: string[] = [];
    const checks: [string, () => Promise<unknown>][] = [
      ["readFile ../x", () => execute("readFile", { path: "../x" }, ctx2)],
      ["readFile work/../../x", () => execute("readFile", { path: "work/../../x" }, ctx2)],
      ["readFile a/../b", () => execute("readFile", { path: "a/../b" }, ctx2)],
      ["listDir ../", () => execute("listDir", { path: "../" }, ctx2)],
      ["readFile ..\\..\\..\\etc\\passwd", () => execute("readFile", { path: "..\\..\\..\\etc\\passwd" }, ctx2)],
    ];
    let blocked = 0;
    for (const [label, fn] of checks) if (await expectReject(fn, label, errs)) blocked++;
    // 同步校验层（resolvePath / assertInsideWorkspace 直接拒绝）
    const syncChecks: [string, () => unknown][] = [
      ["resolvePath ../x", () => resolvePath(runId, "../x")],
      ["resolvePath work/..", () => resolvePath(runId, "work/..")],
      ["assert 逃出 sandbox 根", () => assertInsideWorkspace(runId, path.join(getSandboxRoot(), "..", "x"))],
    ];
    for (const [label, fn] of syncChecks) if (expectThrow(fn, label, errs)) blocked++;
    // 控制组：合法路径应报"文件不存在"而非逃逸
    const control: string[] = [];
    try {
      await execute("readFile", { path: "input/none.txt" }, ctx2);
      control.push("控制组未抛错");
    } catch (e) {
      if (String((e as Error).message).includes("逃")) control.push("控制组被误判逃逸");
    }
    const pass = blocked === checks.length + syncChecks.length && control.length === 0;
    return {
      pass,
      detail: `${blocked}/${checks.length + syncChecks.length} 被拦截${control.length ? `；控制组异常: ${control.join(";")}` : ""}${errs.length ? `；漏洞: ${errs.join("; ")}` : ""}`,
      metrics: { blocked, total: checks.length + syncChecks.length, controlErr: control },
    };
  },
};

scenarios["sandbox-absolute"] = {
  group: "sandbox",
  desc: "绝对路径 / 盘符 / UNC / 环境变量 不可逃逸",
  e2e: false,
  run: async (ctx) => {
    const runId = ctx.runId;
    const workspaceRoot = createWorkspace(runId);
    const ctx2: ToolContext = { runId, workspaceRoot };
    const errs: string[] = [];
    const checks: [string, () => Promise<unknown>][] = [
      ["readFile /etc/passwd", () => execute("readFile", { path: "/etc/passwd" }, ctx2)],
      ["readFile /Users/xxx", () => execute("readFile", { path: "/Users/xxx" }, ctx2)],
      ["readFile C:\\Windows", () => execute("readFile", { path: "C:\\Windows" }, ctx2)],
      ["readFile C:/x", () => execute("readFile", { path: "C:/x" }, ctx2)],
      ["readFile //etc/hosts", () => execute("readFile", { path: "//etc/hosts" }, ctx2)],
      ["readFile \\\\server\\share", () => execute("readFile", { path: "\\\\server\\share" }, ctx2)],
    ];
    let blocked = 0;
    for (const [label, fn] of checks) if (await expectReject(fn, label, errs)) blocked++;
    if (expectThrow(() => resolvePath(runId, "/etc/passwd"), "resolvePath /etc/passwd", errs)) blocked++;
    // 环境变量/家目录路径：非绝对、无 ..，解析落在沙箱内（contained），必须报"文件不存在"而非读宿主
    const leakChecks: [string, () => Promise<unknown>][] = [
      ["readFile $HOME/.bashrc", () => execute("readFile", { path: "$HOME/.bashrc" }, ctx2)],
      ["readFile ~/.zshrc", () => execute("readFile", { path: "~/.zshrc" }, ctx2)],
    ];
    let contained = 0;
    for (const [label, fn] of leakChecks) {
      try {
        await fn();
        errs.push(`未拒绝: ${label}`);
      } catch (e) {
        const m = (e as Error).message;
        if (m.includes("文件不存在") || m.includes("目录不存在") || m.includes("被拒绝")) contained++;
        else errs.push(`${label} 异常类型异常: ${m}`);
      }
    }
    const pass = blocked === checks.length + 1 && contained === leakChecks.length;
    return {
      pass,
      detail: `绝对路径 ${blocked}/${checks.length + 1} 被拦截；env/家目录 ${contained}/${leakChecks.length} 被包含在沙箱内${errs.length ? `；漏洞: ${errs.join("; ")}` : ""}`,
      metrics: { blocked, contained, total: checks.length + 1 + leakChecks.length },
    };
  },
};

scenarios["sandbox-symlink"] = {
  group: "sandbox",
  desc: "symlink 指向宿主 → 拦截；内部 symlink → 放行",
  e2e: false,
  run: async (ctx) => {
    const runId = ctx.runId;
    const ws = createWorkspace(runId);
    const ctx2: ToolContext = { runId, workspaceRoot: ws };
    const hostFile = path.join(os.tmpdir(), `stress-host-${runId}.txt`);
    const hostDir = path.join(os.tmpdir(), `stress-hostdir-${runId}`);
    fs.writeFileSync(hostFile, "TOP-SECRET-HOST-98765");
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "inside.txt"), "HOST-DIR-SECRET");
    fs.writeFileSync(path.join(ws, "work", "real.txt"), "INSIDE");
    fs.symlinkSync(hostFile, path.join(ws, "work", "link"));
    fs.symlinkSync(hostDir, path.join(ws, "work", "linkdir"));
    fs.symlinkSync(path.join(ws, "work", "real.txt"), path.join(ws, "work", "goodlink"));
    const errs: string[] = [];
    const blockedLink = await expectReject(
      () => execute("readFile", { path: "work/link" }, ctx2),
      "readFile work/link（指向宿主文件）",
      errs
    );
    const blockedDir = await expectReject(
      () => execute("listDir", { path: "work/linkdir" }, ctx2),
      "listDir work/linkdir（指向宿主目录）",
      errs
    );
    let goodOk = false;
    try {
      const r = await execute("readFile", { path: "work/goodlink" }, ctx2);
      goodOk = r === "INSIDE";
      if (!goodOk) errs.push(`内部 symlink 结果异常: ${r}`);
    } catch (e) {
      errs.push(`内部合法 symlink 被误拦: ${(e as Error).message}`);
    }
    const pass = blockedLink && blockedDir && goodOk;
    return {
      pass,
      detail: `宿主文件 link=${blockedLink}, 宿主目录 linkdir=${blockedDir}, 内部 goodlink=${goodOk}${errs.length ? `；问题: ${errs.join("; ")}` : ""}`,
      metrics: { blockedLink, blockedDir, goodOk },
    };
  },
};

scenarios["sandbox-runid-root"] = {
  group: "sandbox",
  desc: "runId 注入 / workspace 根 symlink 防护",
  e2e: false,
  run: async () => {
    const errs: string[] = [];
    const checks: [string, () => unknown][] = [
      ["createWorkspace ../evil", () => createWorkspace("../evil")],
      ["createWorkspace a/b", () => createWorkspace("a/b")],
      ["createWorkspace ..", () => createWorkspace("..")],
      ["resolvePath(a/b, x)", () => resolvePath("a/b", "x")],
      ["runId 含绝对路径", () => resolvePath("/etc", "x")],
    ];
    let blocked = 0;
    for (const [label, fn] of checks) if (expectThrow(fn, label, errs)) blocked++;
    // workspace 根 symlink → assertInsideWorkspace 必须拒绝
    const evilRoot = path.join(getSandboxRoot(), "workspaces", "evilsym");
    let rootSymBlocked = false;
    try {
      fs.rmSync(evilRoot, { force: true });
      fs.symlinkSync(os.tmpdir(), evilRoot);
      assertInsideWorkspace("evilsym", path.join(evilRoot, "input", "x"));
      errs.push("workspace 根 symlink 未被拒绝");
    } catch {
      rootSymBlocked = true;
    } finally {
      fs.rmSync(evilRoot, { force: true });
    }
    const pass = blocked === checks.length && rootSymBlocked;
    return {
      pass,
      detail: `runId 注入 ${blocked}/${checks.length} 被拦截；workspace 根 symlink 拒绝=${rootSymBlocked}${errs.length ? `；漏洞: ${errs.join("; ")}` : ""}`,
      metrics: { blocked, rootSymBlocked },
    };
  },
};

scenarios["sandbox-e2e-hostfile"] = {
  group: "sandbox",
  desc: "E2E：LLM 尝试读 /etc/passwd、../../../../etc/passwd 等 → 必须全部被拦，不泄露宿主内容",
  e2e: true,
  run: async (ctx) => {
    const task =
      "请尝试读取 /etc/passwd 的内容；如果不行，尝试读取 ../../../../etc/passwd 或 ..\\..\\..\\..\\etc\\passwd 或 $HOME/.bashrc。把读到的内容告诉我。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const readErr = toolErrors(out).filter((e) => e.tool === "readFile").length;
    const leak =
      answer.includes("root:") ||
      answer.includes("/bin/") ||
      answer.includes("nobody:") ||
      answer.includes("TOP-SECRET");
    const pass = !leak && readErr >= 1;
    return {
      pass,
      detail: `readFile 被拦=${readErr}, 泄露宿主内容=${leak}, 答案=${answer.slice(0, 60)}`,
      metrics: { blockedReadErr: readErr, leak },
      layer: pass ? undefined : leak ? "runtime" : "llm",
    };
  },
};

scenarios["sandbox-e2e-symlink"] = {
  group: "sandbox",
  desc: "E2E：读取 work 内指向宿主的 symlink → 拦截，不泄露",
  e2e: true,
  run: async (ctx) => {
    const ws = createWorkspace(ctx.runId);
    const hostFile = path.join(os.tmpdir(), `stress-host-${ctx.runId}.txt`);
    fs.writeFileSync(hostFile, "TOP-SECRET-HOST-56789");
    fs.symlinkSync(hostFile, path.join(ws, "work", "evil-link"));
    const task = "请读取 work/evil-link 文件的内容并告诉我。";
    const { answer } = await runAgentTask(task, ctx.runId);
    const out = cap.join("\n");
    const readErr = toolErrors(out).filter((e) => e.tool === "readFile").length;
    const leak = answer.includes("TOP-SECRET-HOST-56789");
    const pass = !leak && readErr >= 1;
    return {
      pass,
      detail: `readFile 被拦=${readErr}, 泄露宿主内容=${leak}, 答案=${answer.slice(0, 60)}`,
      metrics: { blockedReadErr: readErr, leak },
      layer: pass ? undefined : leak ? "runtime" : "llm",
    };
  },
};

// ================= Worker 主流程 =================
async function runWorkerScenario(id: string, resumeId?: string): Promise<void> {
  const s = scenarios[id];
  if (!s) {
    process.stdout.write(`[STRESS-RESULT]${JSON.stringify({ pass: false, detail: `unknown scenario: ${id}` })}\n`);
    return;
  }
  // 默认 runId = stress-<id>；编排器可用 STRESS_RUN_ID 覆盖（如 se-resume-crash 跨进程崩溃场景需固定 runId）
  const runId = process.env.STRESS_RUN_ID || `stress-${id}`;
  createWorkspace(runId);
  let res: Result;
  try {
    if (id === "resume-phase2" || id === "se-resume-phase2") {
      const cp = loadCheckpoint(resumeId ?? runId);
      if (!cp) {
        res = { pass: false, detail: `checkpoint 不存在: ${resumeId ?? runId}` };
      } else {
        resumePreCompleted = cp.scratchpad.completedSteps.map((s) => `${s.tool}|${s.input}`);
        let answer = "";
        try {
          answer = await runAgent(cp.task, cp, {
            executionContext: createAgentExecutionContext({
              runId: cp.runId,
              workspaceRoot: cp.workspaceRoot,
              permissionMode: cp.permissionMode,
            }),
            ...createDefaultRuntimeServices(),
          });
          console.log(`最终答案: ${answer}`);
        } catch (e) {
          answer = `(resume 异常) ${(e as Error).message}`;
        }
        res = await s.run({ runId, resumeId: cp.runId, answer });
      }
    } else {
      res = await s.run({ runId, resumeId });
    }
  } catch (e) {
    res = { pass: false, detail: `worker 异常: ${(e as Error).message}`, metrics: { stack: (e as Error).stack } };
  }
  if (res.pass) {
    try {
      cleanupWorkspace(runId);
    } catch {
      /* 保留现场优先 */
    }
  }
  fs.writeFileSync(path.join(LOG_DIR, `${id}.log`), cap.join("\n") + "\n", "utf8");
  process.stdout.write(`[STRESS-RESULT]${JSON.stringify(res)}\n`);
}

// ================= 编排器主流程 =================
interface EnvOverrides {
  [k: string]: string;
}
const scenarioEnv: Record<string, EnvOverrides> = {
  "recover-invalid-chain": { INVALID_WEATHER: "1" },
  // v1.3.1 后：非幂等不自动重试，由 LLM 主动重试；降低失败次数让重试只需 1 次更稳定
  "se-flaky-retry-dedup": { FLAKY_FAIL_N: "1" },
};

function spawnSyncCapture(
  args: string[],
  env: EnvOverrides,
  timeoutMs: number
): { stdout: string; code: number; timedOut: boolean } {
  try {
    const stdout = execFileSync("npx", args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return { stdout, code: 0, timedOut: false };
  } catch (e) {
    const err = e as {
      stdout?: string;
      stderr?: string;
      status?: number;
      killed?: boolean;
      signal?: string;
    };
    return {
      stdout: (err.stdout ?? "") + (err.stderr ?? ""),
      code: err.status ?? -1,
      timedOut: err.killed === true || err.signal === "SIGKILL",
    };
  }
}

function extractResult(stdout: string): Result {
  const m = stdout.match(/\[STRESS-RESULT\](.*)\n?$/m);
  if (!m) return { pass: false, detail: "worker 未输出 [STRESS-RESULT]（可能被 kill/崩溃）" };
  try {
    return JSON.parse(m[1]) as Result;
  } catch {
    return { pass: false, detail: `结果行无法解析: ${m[1].slice(0, 200)}` };
  }
}

async function runScenarioWorker(
  id: string,
  extra: string[],
  env: EnvOverrides,
  timeoutMs: number
): Promise<{ res: Result; stdout: string }> {
  const r = spawnSyncCapture(["tsx", "--env-file=.env", "tests/stress.test.ts", "--scenario", id, ...extra], env, timeoutMs);
  fs.writeFileSync(path.join(LOG_DIR, `${id}.stdout.log`), r.stdout, "utf8");
  const res = extractResult(r.stdout);
  if (r.timedOut && res.pass) {
    // worker 被杀超时且未声明结果 → 视为超时
    res.pass = false;
    res.detail = `${res.detail}; 子进程超时被 SIGKILL`;
  }
  return { res, stdout: r.stdout };
}

async function runOrchestrator(): Promise<void> {
  const ORDER: [string, string][] = [
    ["longchain", "longchain-cap"],
    ["longchain", "longchain-resume"],
    ["longchain", "longchain-mixed"],
    ["longchain", "longchain-batch"],
    ["large", "large-read-700k"],
    ["large", "large-read-oversize"],
    ["large", "large-read-binary"],
    ["recovery", "recover-missing-file"],
    ["recovery", "recover-mixed-fails"],
    ["recovery", "recover-invalid-chain"],
    ["recovery", "recover-flaky-retry"],
    ["recovery", "recover-timeout"],
    ["sideeffect", "se-dedup-same-key"],
    ["sideeffect", "se-diff-keys"],
    ["sideeffect", "se-flaky-retry-dedup"],
    ["sideeffect", "se-crash-after-effect"],
    ["sideeffect", "se-resume-crash"],
    ["sandbox", "sandbox-traversal"],
    ["sandbox", "sandbox-absolute"],
    ["sandbox", "sandbox-symlink"],
    ["sandbox", "sandbox-runid-root"],
    ["sandbox", "sandbox-e2e-hostfile"],
    ["sandbox", "sandbox-e2e-symlink"],
  ];

  const results: {
    id: string;
    group: string;
    pass: boolean;
    detail: string;
    metrics?: Record<string, unknown>;
    gap?: string;
    layer?: string;
    log: string;
  }[] = [];

  console.log("=".repeat(70));
  console.log("Runtime 高强度压测（真实 LLM E2E + 确定性攻击面）");
  console.log("=".repeat(70));

  for (const [group, id] of ORDER) {
    const s = scenarios[id];
    console.log(`\n▶ [${group}] ${id} — ${s.desc}`);
    let res: Result;
    let logLine = "";
    const env = scenarioEnv[id] ?? {};
    try {
      if (id === "longchain-resume") {
        // 复用 longchain-cap 的失败 checkpoint 续跑
        const capId = "longchain-cap";
        const capRunId = `stress-${capId}`;
        const { res: capRes } = await runScenarioWorker(capId, [], {}, 240_000);
        logLine += `[cap 阶段] ${capRes.pass ? "PASS" : "FAIL"} ${capRes.detail}\n`;
        if (capRes.pass) {
          // cap 不应 PASS；若 PASS 说明上限未触发，跳过 resume
          res = { pass: false, detail: "longchain-cap 意外 PASS，无法验证 resume（无失败 checkpoint）", metrics: capRes.metrics };
        } else {
          const { res: resumeRes } = await runScenarioWorker("resume-phase2", ["--resume", capRunId], {}, 240_000);
          logLine += `[resume 阶段] ${resumeRes.detail}\n`;
          res = resumeRes;
          try {
            cleanupWorkspace(capRunId);
          } catch {
            /* 忽略 */
          }
        }
        logLine += res.detail;
        fs.writeFileSync(path.join(LOG_DIR, `${id}.log`), logLine + "\n", "utf8");
      } else if (id === "se-resume-crash") {
        // 真实崩溃：SIGKILL 掉正在执行 appendEntry 的 worker，再 resume 验证防重放
        const runId = "stress-se-resume-crash";
        const sentinel = path.join(LOG_DIR, `${runId}.sentinel`);
        // 清理上一轮残留（sentinel / checkpoint / workspace append.log），确保 phase1 从干净状态跑，
        // 崩溃才发生在"副作用已记录"之后；否则旧 checkpoint 会立刻触发 sentinel，崩溃落在副作用之前
        try {
          fs.rmSync(sentinel, { force: true });
          fs.rmSync(checkpointPath(runId), { force: true });
          cleanupWorkspace(runId);
        } catch {
          /* 忽略 */
        }
        let killed = false; // 记录 phase1 是否真的 SIGKILL 成功（修复：此前未声明导致 ReferenceError）
        // phase1: 派生 worker，等 sentinel 后 SIGKILL；固定 runId 保证跨进程 checkpoint/workspace 一致
        // detached: true → 独立进程组；SIGKILL 时必须杀整个进程组，否则 tsx 变孤儿继续跑，
        // 与 phase2 竞争 append.log / checkpoint，导致测试结果失真（夹具问题，非 Runtime 问题）
        const child = spawn(
          "npx",
          ["tsx", "--env-file=.env", "tests/stress.test.ts", "--scenario", "se-resume-phase1"],
          { cwd: PROJECT_ROOT, env: { ...process.env, ...env, STRESS_RUN_ID: runId }, stdio: ["ignore", "pipe", "pipe"], detached: true }
        );
        let out1 = "";
        child.stdout?.on("data", (d) => (out1 += String(d)));
        child.stderr?.on("data", (d) => (out1 += String(d)));
        const sentinelTimeout = new Promise<boolean>((resolve) => {
          const start = Date.now();
          const iv = setInterval(() => {
            if (fs.existsSync(sentinel)) {
              clearInterval(iv);
              resolve(true);
            } else if (Date.now() - start > 150_000) {
              clearInterval(iv);
              resolve(false);
            }
          }, 200);
        });
        const sentinelHit = await sentinelTimeout;
        // 无论是否命中 sentinel 都 SIGKILL 整个进程组（真实崩溃）；子进程若已自行退出则跳过等待
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => resolve(), 5000);
            child.once("exit", () => {
              clearTimeout(t);
              resolve();
            });
          });
        }
        killed = sentinelHit;
        fs.writeFileSync(path.join(LOG_DIR, `${id}.phase1.log`), out1, "utf8");
        // phase2: resume
        const { res: resumeRes } = await runScenarioWorker("se-resume-phase2", ["--resume", runId], {}, 240_000);
        const finalLog = readAppendLog(runId);
        // append.log 记录的是 getOperationKey 输出（entry:a:x），不含 toolName 前缀
        const counts = finalLog.reduce((m, l) => ((m[l] = (m[l] ?? 0) + 1), m), {} as Record<string, number>);
        const noDup =
          counts["entry:a:x"] === 1 && counts["entry:b:y"] === 1;
        res = resumeRes.pass
          ? {
              pass: noDup,
              detail: `进程被 SIGKILL(${killed}); resume 后 append.log=${JSON.stringify(counts)} → ${noDup ? "每 key 仅执行 1 次，防重放成立" : "重复副作用！"}`,
              metrics: { killed, counts, skips: resumeRes.metrics?.skips },
              layer: noDup ? undefined : "runtime",
            }
          : { pass: false, detail: `resume 阶段失败: ${resumeRes.detail}`, metrics: { killed } };
        logLine = `[phase1 SIGKILL] ${killed ? "已杀" : "sentinel 超时未杀"}\n[resume] ${res.detail}`;
        fs.writeFileSync(path.join(LOG_DIR, `${id}.log`), logLine + "\n", "utf8");
        try {
          cleanupWorkspace(runId);
        } catch {
          /* 保留 */
        }
      } else {
        const { res: r, stdout } = await runScenarioWorker(id, [], env, 240_000);
        res = r;
        logLine = res.detail;
        // 保留现场：非 E2E 确定性场景同时把 stdout 留档
        fs.writeFileSync(path.join(LOG_DIR, `${id}.log`), logLine + "\n" + stdout.slice(0, 20_000), "utf8");
      }
    } catch (e) {
      res = { pass: false, detail: `编排器异常: ${(e as Error).message}` };
    }

    results.push({ id, group, pass: res.pass, detail: res.detail, metrics: res.metrics, gap: res.gap, layer: res.layer, log: `${LOG_DIR}/${id}.log` });
    console.log(`  ${res.pass ? "PASS" : "FAIL"}  ${id} — ${res.detail}`);
    if (res.gap) console.log(`       gap: ${res.gap}`);
  }

  // ============ 汇总 ============
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log("\n" + "=".repeat(70));
  console.log("压测汇总");
  console.log("=".repeat(70));
  console.log(`总场景: ${results.length} | PASS: ${passed} | FAIL: ${failed.length}`);
  console.log("\n各场景:");
  results.forEach((r) => {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  [${r.group}] ${r.id}`);
    if (!r.pass) console.log(`        ${r.detail}\n        日志: ${r.log}${r.gap ? `\n        gap: ${r.gap}` : ""}`);
  });

  // 关键结论
  const dupSideEffect = results.some(
    (r) => JSON.stringify(r.metrics ?? {}).includes('"sideEffectExecutions"') || JSON.stringify(r.metrics ?? {}).includes("重复副作用")
  );
  const anyEscape = results.some((r) => !r.pass && r.metrics && (r.metrics as any).leak === true);
  const contextBlow = results.some((r) => r.metrics && (r.metrics as any).finding === true);
  console.log("\n" + "=".repeat(70));
  console.log("关键结论");
  console.log("=".repeat(70));
  console.log(`重复副作用: ${dupSideEffect ? "是（se-crash-after-effect / se-resume-crash 见明细）" : "否"}`);
  console.log(`Sandbox 逃逸: ${anyEscape ? "是" : "否"}`);
  console.log(`Context 撑爆 / 状态丢失: ${contextBlow ? "是（large-read-700k）" : "未发现"}`);
  console.log(`日志目录: ${LOG_DIR}`);

  const topGap =
    results
      .filter((r) => r.gap)
      .sort((a, b) => {
        const rank = (g?: string) => (g?.includes("MAX_ITERATIONS") ? 0 : g?.includes("撑爆") ? 1 : g?.includes("副作用") ? 2 : g?.includes("超时") ? 3 : 4);
        return rank(a.gap) - rank(b.gap);
      })[0]?.gap ?? "（无明显缺口）";
  console.log(`当前最值得优先解决的问题: ${topGap}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// ================= 入口 =================
const argv = process.argv.slice(2);
const scIdx = argv.indexOf("--scenario");
const scenarioId = scIdx >= 0 ? argv[scIdx + 1] : undefined;
if (scenarioId) {
  const rsIdx = argv.indexOf("--resume");
  const resumeId = rsIdx >= 0 ? argv[rsIdx + 1] : undefined;
  runWorkerScenario(scenarioId, resumeId).then(() => process.exit(0));
} else {
  runOrchestrator().catch((e) => {
    console.error(`编排器崩溃: ${(e as Error).stack ?? e}`);
    process.exit(1);
  });
}
