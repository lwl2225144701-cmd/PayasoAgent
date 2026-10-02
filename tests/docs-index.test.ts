// 模块: 文档索引契约测试 — 锁定 docs/README.md 的目录树与链接健康
// 用法: npx tsx tests/docs-index.test.ts （或随 npm run test:all 运行）
// 契约:
//   1. 目录树（README 首个 ``` 围栏）登记的每个条目都真实存在 —— 防改名/移动后残留幽灵条目；
//   2. docs/ 下手写文档全部被目录树登记 —— 防新增文档只进目录不进索引；
//   3. README 的 markdown 链接（非 http/mailto）均可解析 —— 防断链。
// 背景：2026-09 docs 按主题重组后，目录树漏登了 7 份已存在文档（新子目录 + 研究报告）。
//       本测试把「索引 == 事实」变成机器契约，避免再次腐化。
// 边界：baseline/ archify/ swebench/ 为生成产物，不参与登记校验（见 README「约定」）。

import fs from 'node:fs';
import path from 'node:path';

const DOCS_DIR = path.resolve(process.cwd(), 'docs');
const README_PATH = path.resolve(DOCS_DIR, 'README.md');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

/**
 * 解析 README 首个代码围栏（目录树），返回相对 docs/ 的登记条目集合。
 *
 * 树的三类行都要兼容：
 *   - 目录行 `├── plans/`（名字不含点，避免把 `v1.0-design.md` 误判成目录）；
 *   - 条目合并写 `harness-phase2-plan.md / harness-phase2-status.md`；
 *   - 花括号 `multimodal-format-preview.{png,svg}` 须展开成两个完整文件名（只拆括号
 *     会丢基名，第二项变成裸 `svg`）。
 * 行尾 `# 注释` 先剥掉：注释里会出现 `docs-contract` 之类的词，不能当文件名。
 */
function parseTreeEntries(fence: string): Set<string> {
  const entries = new Set<string>();
  let curDir = '';
  for (const raw of fence.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line === 'docs/') continue;
    const dirMatch = line.match(/^(?:[├└]──\s*)?([A-Za-z0-9._-]+)\/\s*$/);
    if (dirMatch && !dirMatch[1].includes('.')) {
      curDir = dirMatch[1];
      continue;
    }
    const body = line
      .replace(/^[├└]──\s*/, '')
      .replace(/([A-Za-z0-9._-]+)\.\{([^}]*)\}/g, (_m, stem: string, group: string) =>
        group
          .split(',')
          .map((ext) => `${stem}.${ext.trim()}`)
          .join(' '),
      );
    for (const token of body.split(/\s+/)) {
      if (!/\.(md|png|svg|html)$/.test(token)) continue;
      entries.add(curDir ? `${curDir}/${token}` : token);
    }
  }
  return entries;
}

/** 递归收集 docs/ 下手写文档（相对 docs/ 的路径）；生成产物目录与索引自身不计。 */
function listDocFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      // 基线输出 / 架构图产物 / 压测现场：由工具生成，不要求登记（README「约定」）。
      if (['baseline', 'archify', 'swebench'].includes(entry.name)) continue;
      out.push(
        ...listDocFiles(path.join(dir, entry.name), base ? `${base}/${entry.name}` : entry.name),
      );
    } else if (/\.(md|png|svg)$/.test(entry.name) && entry.name !== 'README.md') {
      out.push(base ? `${base}/${entry.name}` : entry.name);
    }
  }
  return out;
}

const readme = fs.readFileSync(README_PATH, 'utf-8');
const fenceMatch = readme.match(/```\n([\s\S]*?)```/);
check('README.md 含目录树代码围栏', fenceMatch !== null);

const listed = fenceMatch ? parseTreeEntries(fenceMatch[1]) : new Set<string>();
const actual = listDocFiles(DOCS_DIR);
const phantom = [...listed].filter((rel) => !fs.existsSync(path.join(DOCS_DIR, rel)));
const missing = actual.filter((rel) => !listed.has(rel));
check(
  '目录树条目全部存在（无幽灵条目）',
  phantom.length === 0,
  `不存在: ${phantom.join(', ') || '无'}`,
);
check('手写文档全部登记进目录树', missing.length === 0, `漏登: ${missing.join(', ') || '无'}`);

const brokenLinks: string[] = [];
const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
// matchAll 而非 while+exec：避免在 while 条件里赋值（lint/suspicious/noAssignInExpressions）。
for (const [, target] of readme.matchAll(linkRe)) {
  if (/^(https?:|mailto:)/.test(target)) continue;
  const rel = target.split('#')[0];
  if (!rel) continue; // 纯锚点（#小节）不落盘
  if (!fs.existsSync(path.resolve(DOCS_DIR, rel))) brokenLinks.push(target);
}
check(
  'README 的文档链接全部可解析',
  brokenLinks.length === 0,
  `断链: ${brokenLinks.join(', ') || '无'}`,
);

console.log(`\n文档索引契约测试汇总: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) {
  console.log('提示: 新增/移动 docs/ 下文档时，请同步 docs/README.md 的目录树与快速入口。');
}
process.exit(failed ? 1 : 0);
