// 确定性测试：SSE 前端事件白名单契约。
// web/src/api.ts connectSSE 按事件名注册 EventSource 监听器 —— 白名单缺类型 = 事件被
// 浏览器静默丢弃（曾发生：新增 llm_call_started 漏加，等待期指示器完全失效）。
// 本测试锁定：白名单必须 ⊇ trace.ts（Runtime Trace）+ run-events.ts（Host 生命周期/
// 流式增量/批准/工具链准备）声明的全部事件类型。

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = process.cwd();
const API_PATH = path.resolve(PROJECT_ROOT, 'web', 'src', 'api.ts');
const TRACE_PATH = path.resolve(PROJECT_ROOT, 'src', 'runtime', 'trace.ts');
const RUN_EVENTS_PATH = path.resolve(PROJECT_ROOT, 'src', 'host', 'run-events.ts');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 提取源码中的 `type: 'xxx'` 字面量集合。联合写法（如 type: 'a' | 'b'）一行多个，
// 因此按行处理，取该行内全部引号标识符（字段名固定为 type，行内不会混入其他字符串值）。
function extractTypes(src: string): string[] {
  const types = new Set<string>();
  for (const line of src.split('\n')) {
    if (!/\btype:\s*['"]/.test(line)) continue;
    for (const m of line.matchAll(/['"]([A-Za-z_]+)['"]/g)) types.add(m[1]);
  }
  return [...types];
}

// 从 api.ts 提取 connectSSE 的 eventTypes 数组字面量
function extractWhitelist(src: string): string[] | null {
  const m = src.match(/const eventTypes\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return null;
  const types = [...m[1].matchAll(/['"]([A-Za-z_]+)['"]/g)].map((x) => x[1]);
  return types;
}

console.log('PayasoAgent SSE 白名单契约测试（api.ts vs trace.ts + run-events.ts）\n');

const apiSrc = fs.readFileSync(API_PATH, 'utf-8');
const traceSrc = fs.readFileSync(TRACE_PATH, 'utf-8');
const runEventsSrc = fs.readFileSync(RUN_EVENTS_PATH, 'utf-8');

const whitelist = extractWhitelist(apiSrc);
check('api.ts 存在 eventTypes 数组', whitelist !== null);
if (whitelist === null) {
  console.error('\n无法解析 eventTypes，中止');
  process.exit(1);
}

const declared = [...new Set([...extractTypes(traceSrc), ...extractTypes(runEventsSrc)])].sort();
// 生命周期/流式/批准/工具链事件（run-events.ts）里有些类型同时出现在 trace.ts（无冲突）；
// HostEvent 联合里每个 type 字面量都应可被浏览器订阅到。
const missing = declared.filter((t) => !whitelist.includes(t));
check(
  '白名单覆盖全部事件类型',
  missing.length === 0,
  missing.length > 0 ? `缺少: ${missing.join(', ')}` : '',
);

// 反向：白名单里不应有未声明的事件类型（笔误/残留）
const extra = whitelist.filter((t) => !declared.includes(t));
check(
  '白名单不含未声明类型',
  extra.length === 0,
  extra.length > 0 ? `多余: ${extra.join(', ')}` : '',
);

console.log(`\n白名单共 ${whitelist.length} 项，声明事件类型 ${declared.length} 项`);
console.log(`\nSSE whitelist tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
