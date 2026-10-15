// 模块: 套件数量契约测试 — 锁定「文档手写套件数 == run-all.ts 实际登记数」
// 用法: npx tsx tests/suite-count-contract.test.ts （或随 npm run test:all 运行）
// 契约:
//   1. run-all.ts 的 SUITES 登记可解析：每条 file 真实存在、name/file 无重复
//   2. README.md / PAYASO.md / docs/architecture-current.md 中所有「套件数」表述
//      必须等于实际登记数 —— 新增/删除套件忘改文档 → 本套件红
//   3. 每个数字形态的正则都必须至少命中一次 —— 文档改写法导致闸件静默失效同样红
// 背景：套件数曾经五处五个数字（README/PAYASO 82、architecture 84、run-all 注释 90、
//   另一处注释 113，实际 120）全线漂移。本测试把「数字只有一个来源（SUITES 数组），
//   文档只能引用不能手抄」变成机器契约：此后增删套件只需改 run-all.ts 一处，
//   文档数字忘改会在这里红，而不是漂到下游。

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = process.cwd();
const RUN_ALL = path.resolve(PROJECT_ROOT, 'tests', 'run-all.ts');

interface SuiteEntry {
  name: string;
  file: string;
}

/** 单一来源：从 run-all.ts 的 SUITES 数组字面量解析登记条目（不 import——那会执行整套）。 */
function parseRegisteredSuites(): SuiteEntry[] {
  const src = fs.readFileSync(RUN_ALL, 'utf8');
  const start = src.indexOf('const SUITES');
  if (start < 0) throw new Error('run-all.ts 找不到 SUITES 数组');
  const end = src.indexOf('\n];', start);
  if (end < 0) throw new Error('run-all.ts 的 SUITES 数组没有闭合（找不到 ];）');
  const block = src.slice(start, end);
  const entries: SuiteEntry[] = [];
  const re = /\{\s*name:\s*'([^']+)',\s*file:\s*'([^']+)'\s*\}/g;
  let m = re.exec(block);
  while (m !== null) {
    entries.push({ name: m[1], file: m[2] });
    m = re.exec(block);
  }
  return entries;
}

/** 文档侧「套件数」表述的每种形态：捕获组即手抄的数字。新增表述形态时在这里加一行。 */
const COUNT_PATTERNS: { doc: string; pattern: RegExp; label: string }[] = [
  { doc: 'README.md', pattern: /(\d+)\s*个确定性套件/g, label: '「N 个确定性套件」' },
  {
    doc: 'PAYASO.md',
    pattern: /确定性套件（无 LLM，(\d+)\s*个）/g,
    label: '「确定性套件（无 LLM，N 个）」',
  },
  {
    doc: 'docs/architecture-current.md',
    pattern: /(\d+)\s*个确定性套件/g,
    label: '「N 个确定性套件」',
  },
  {
    doc: 'docs/architecture-current.md',
    pattern: /确定性\s*(\d+)\s*套件/g,
    label: '「确定性 N 套件」',
  },
  {
    doc: 'docs/architecture-current.md',
    pattern: /(\d+)\s*套件全绿/g,
    label: '「N 套件全绿」',
  },
];

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('PayasoAgent 套件数量契约测试（run-all.ts SUITES ↔ 文档手抄数字）\n');

// ---- 契约 1: SUITES 登记健康 ----
let suites: SuiteEntry[] = [];
try {
  suites = parseRegisteredSuites();
  check('run-all.ts SUITES 数组可解析', suites.length > 0, `解析到 ${suites.length} 条`);
} catch (err) {
  check('run-all.ts SUITES 数组可解析', false, (err as Error).message);
}

const missingFiles = suites.filter((s) => !fs.existsSync(path.resolve(PROJECT_ROOT, s.file)));
check(
  'SUITES 登记的 file 全部存在',
  missingFiles.length === 0,
  missingFiles.map((s) => `${s.name} → ${s.file}`).join(', '),
);

const dupNames = suites.map((s) => s.name).filter((n, i, all) => all.indexOf(n) !== i);
check('SUITES name 无重复', dupNames.length === 0, [...new Set(dupNames)].join(', '));

const dupFiles = suites.map((s) => s.file).filter((f, i, all) => all.indexOf(f) !== i);
check('SUITES file 无重复', dupFiles.length === 0, [...new Set(dupFiles)].join(', '));

const actual = suites.length;

// ---- 契约 2/3: 文档手抄数字 == 实际登记数，且每种形态都仍在文中 ----
for (const { doc, pattern, label } of COUNT_PATTERNS) {
  const abs = path.resolve(PROJECT_ROOT, doc);
  if (!fs.existsSync(abs)) {
    check(`${doc} 存在`, false, abs);
    continue;
  }
  const text = fs.readFileSync(abs, 'utf8');
  const found: { line: number; value: number }[] = [];
  for (const m of text.matchAll(pattern)) {
    found.push({ line: lineOf(text, m.index ?? 0), value: Number(m[1]) });
  }
  // 形态消失（文档被改写）→ 闸门静默失效，必须红
  check(`${doc} 仍含${label}表述`, found.length > 0, '一处都没匹配到——文档写法变了？');
  const wrong = found.filter((f) => f.value !== actual);
  check(
    `${doc} 的${label}均为 ${actual}`,
    wrong.length === 0,
    wrong.map((w) => `L${w.line} 写成 ${w.value}`).join('; ') +
      (wrong.length > 0 ? `（实际 ${actual}，请改成 ${actual}）` : ''),
  );
}

console.log(`\n套件数量契约测试汇总: ${passed} PASS / ${failed} FAIL（实际登记 ${actual} 套件）`);
process.exit(failed > 0 ? 1 : 0);
