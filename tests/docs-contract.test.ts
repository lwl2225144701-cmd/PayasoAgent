// 模块: 文档契约测试 — 锁定 docs/architecture-current.md 与代码的一致性
// 用法: npx tsx tests/docs-contract.test.ts （或随 npm run test:all 运行）
// 契约:
//   1. §3.3 的 <!-- docs-contract:tools --> JSON 块 = 工具注册表实际工具名集合
//   2. §3.3 的 <!-- docs-contract:events --> JSON 块 = trace.ts 声明的 Trace 事件类型集合
// 改代码（新增/删除工具或事件）而不同步文档 → 本测试红。
// 与文档 §11 维护约定配套：新增工具/事件必须同时更新 docs/architecture-current.md。

import fs from "node:fs";
import path from "node:path";

// 触发工具注册（副作用：register 到全局注册表）
import { getSchemas } from "../src/tools/tools.js";
import "../src/tools/filesystem.js";
import "../src/tools/runtime-tools.js";

const PROJECT_ROOT = process.cwd();
const DOC_PATH = path.resolve(PROJECT_ROOT, "docs", "architecture-current.md");
const TRACE_SRC = path.resolve(PROJECT_ROOT, "src", "runtime", "trace.ts");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

// 从文档中提取 <!-- docs-contract:<id> --> 块内的 JSON 数组
function extractDocList(id: string): string[] | null {
  const doc = fs.readFileSync(DOC_PATH, "utf-8");
  const m = doc.match(new RegExp(`<!-- docs-contract:${id} -->\\s*\\n\\s*\\` + "```json\\n(.+?)\\n```", "s"));
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as unknown;
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

// 从 trace.ts 源码中提取所有 `type: "xxx"` 字面量（TraceEvent / TraceEventInput 联合成员）
function extractTraceTypes(): string[] {
  const src = fs.readFileSync(TRACE_SRC, "utf-8");
  const types = new Set<string>();
  for (const m of src.matchAll(/type: "([A-Za-z_]+)"/g)) types.add(m[1]);
  return [...types];
}

console.log("PayasoAgent 文档契约测试（docs/architecture-current.md vs 代码）\n");

const docExists = fs.existsSync(DOC_PATH) || fs.existsSync(path.join(PROJECT_ROOT, "docs/architecture-current.md"));
check("docs/architecture-current.md 存在", docExists, DOC_PATH);

// ---- 契约 1: 工具清单 ----
const docTools = extractDocList("tools");
check("文档存在 <!-- docs-contract:tools --> 块", docTools !== null);
const actualTools = getSchemas().map((s) => s.function.name).sort();
if (docTools !== null) {
  const expected = [...docTools].sort();
  const missing = expected.filter((t) => !actualTools.includes(t));
  const extra = actualTools.filter((t) => !expected.includes(t));
  check(
    "工具清单与代码注册表一致",
    missing.length === 0 && extra.length === 0,
    `文档缺实现: ${missing.join(",") || "无"} | 实现缺文档: ${extra.join(",") || "无"}`
  );
  check(`工具数量一致 (${expected.length})`, expected.length === actualTools.length, `文档=${expected.length} 实际=${actualTools.length}`);
}

// ---- 契约 2: Trace 事件清单 ----
const docEvents = extractDocList("events");
check("文档存在 <!-- docs-contract:events --> 块", docEvents !== null);
const actualEvents = extractTraceTypes().sort();
if (docEvents !== null) {
  const expected = [...docEvents].sort();
  const missing = expected.filter((e) => !actualEvents.includes(e));
  const extra = actualEvents.filter((e) => !expected.includes(e));
  check(
    "Trace 事件清单与 trace.ts 一致",
    missing.length === 0 && extra.length === 0,
    `文档缺实现: ${missing.join(",") || "无"} | 实现缺文档: ${extra.join(",") || "无"}`
  );
  check(`事件数量一致 (${expected.length})`, expected.length === actualEvents.length, `文档=${expected.length} 实际=${actualEvents.length}`);
}

console.log(`\n文档契约测试汇总: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) {
  console.log("提示: 请同步更新 docs/architecture-current.md §3.3 的机器契约块（工具/事件清单）。");
}
process.exit(failed ? 1 : 0);