// 模块: 文档引用完整性契约 — 文档里抄的代码路径 / 链接目标必须真实存在
// 用法: npx tsx tests/docs-code-paths.test.ts （或随 npm run test:all 运行）
// 契约:
//   1. 手写文档中所有反嵌号仓库相对路径（src/tests/web/eval/apps/scripts/bin/docs/.github）
//      去掉 :行号 / #锚点 后必须存在 —— 文件被改名/移动/删除 → 本套件红
//   2. 手写文档中所有相对 markdown 链接（非 http/mailto/file）必须可解析
//      —— 文档间搬家忘改链接 → 本套件红（docs-index 只锁 docs/README.md 一份）
// 边界（默认强制执行，以下显式豁免）：
//   - 计划/设计/历史类文档按 docs/README.md  taxonomy 记录"过去与将来"，不描述当前事实：
//     docs/plans/、docs/attachment/、docs/architecture/（冻结历史）、
//     docs/sandbox/cross-platform-sandbox-plan.md、docs/sandbox/windows-mac-compat.md、
//     docs/distribute/npx-distribution-plan.md
//   - 生成产物/构建产物：docs/baseline、docs/archify、docs/swebench、web/dist、
//     apps/desktop/release、dist（本地有、git 里没有，或本就是输出）
//   - 作者声明逃生标记：所在行含「拟建 / 未落地 / 示例」视为作者声明的非现实引用
//     （计划中要建的文件、举的例子），单独计数不判红 —— 新增这类引用时请在行内标注
//   - 反引号内容按空白拆分后逐个判定；含 < > * { } 的模板/glob 占位符跳过；
//     空链接文本 `[](...)` 是 markdown 语法示例，跳过
// 背景：2026-10 大文件拆分曾让 15 处 Timeline 行号引用与 4 处 llm 模块归属静默失效，
//   当时靠临时脚本人肉扫。本测试把「文档引用 == 文件系统事实」变成机器契约。

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = process.cwd();

/** 不参与校验的目录/文件：计划·设计·历史·生成产物（理由见文件头）。 */
const SKIP_PATHS = [
  'docs/baseline',
  'docs/archify',
  'docs/swebench',
  'docs/architecture',
  'docs/plans',
  'docs/attachment',
  'docs/sandbox/cross-platform-sandbox-plan.md',
  'docs/sandbox/windows-mac-compat.md',
  'docs/distribute/npx-distribution-plan.md',
  'web/dist',
  'apps/desktop/release',
  'dist',
];

/** 作者声明逃生标记：行内出现即视为"声明的非现实引用"（拟建/举的例子），不判红。 */
const DECLARED_MARKERS = ['拟建', '未落地', '示例'];

/** 手写文档集合（默认全收，SKIP_PATHS 里的计划/设计/历史/生成产物除外）。 */
function collectHandwrittenDocs(): string[] {
  const roots = ['README.md', 'PAYASO.md', 'web/src/i18n/CONVENTIONS.md', 'docs'];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (isSkipped(rel)) continue;
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.name.endsWith('.md')) {
        files.push(rel);
      }
    }
  };
  for (const root of roots) {
    if (isSkipped(root)) continue;
    const abs = path.resolve(PROJECT_ROOT, root);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) walk(root);
    else files.push(root);
  }
  return files.sort();
}

/** 仓库相对路径的合法顶层前缀。 */
const PATH_PREFIXES = [
  'src/',
  'tests/',
  'web/',
  'eval/',
  'apps/',
  'scripts/',
  'bin/',
  'docs/',
  '.github/',
];

function isSkipped(relPath: string): boolean {
  return SKIP_PATHS.some((g) => relPath === g || relPath.startsWith(`${g}/`));
}

/** 代码围栏内的行不算引用（如 `![](img/x.png)` 是 markdown 语法示例，不是真链接）。 */
function fencedLineSet(text: string): Set<number> {
  const lines = new Set<number>();
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      lines.add(i + 1);
      return;
    }
    if (inFence) lines.add(i + 1);
  });
  return lines;
}

/** 去掉行号/锚点后缀：`foo/bar.ts:12`、`foo/bar.ts:121/124-126`、`foo/bar.ts#L31-L33`。 */
function stripLineAnchors(token: string): string {
  const cut = token.search(/[:#]/);
  return cut >= 0 ? token.slice(0, cut) : token;
}

/** 去掉误捕的中英文句尾标点。 */
function trimPunctuation(token: string): string {
  return token.replace(/[。，、；：）)》」』]+$/, '');
}

/** 模板/glob 占位符（tests/<suite>.test.ts、src/**\/*.ts 之类）不可能是真实路径。 */
function hasPlaceholder(token: string): boolean {
  return /[<>*{}]/.test(token) || token.includes('node_modules');
}

/** 像路径的 token：已知顶层前缀 + 扩展名或目录斜杠结尾。 */
function looksLikePath(token: string): boolean {
  if (!PATH_PREFIXES.some((p) => token.startsWith(p))) return false;
  return token.endsWith('/') || /\.[A-Za-z0-9]+$/.test(token);
}

interface Finding {
  line: number;
  target: string;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** 契约 1：反引号里的仓库相对路径（按空白拆分，一个反引号可含多条命令/多个路径）。 */
function collectBacktickPaths(text: string): Finding[] {
  const findings: Finding[] = [];
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: 正则逐次匹配的惯用写法，循环体依赖 m 非空
  while ((m = re.exec(text))) {
    for (const rawToken of m[1].split(/\s+/)) {
      const token = trimPunctuation(rawToken.trim());
      if (!looksLikePath(token)) continue;
      const rel = stripLineAnchors(token);
      if (hasPlaceholder(rel)) continue;
      findings.push({ line: lineOf(text, m.index), target: rel });
    }
  }
  return findings;
}

/** 契约 2：相对 markdown 链接目标（按文档所在目录解析）。 */
function collectLinkTargets(text: string): Finding[] {
  const findings: Finding[] = [];
  const re = /\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: 同上，正则逐次匹配
  while ((m = re.exec(text))) {
    // 空链接文本 `[](...)` 是 markdown 语法示例（如 `![](img/x.png)`），不是引用
    if (m[1].trim().length === 0) continue;
    const target = m[2];
    if (/^(https?:|mailto:|file:|#)/.test(target)) continue;
    const [pure] = target.split('#');
    if (!pure) continue;
    findings.push({ line: lineOf(text, m.index), target: pure });
  }
  return findings;
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

console.log('PayasoAgent 文档引用完整性契约（反引号路径 + markdown 链接 vs 文件系统）\n');

const docs = collectHandwrittenDocs();
check('手写文档集合非空', docs.length > 0, `${docs.length} 份`);

const missingPaths: string[] = [];
const missingLinks: string[] = [];
const declaredRefs: string[] = [];
let pathChecks = 0;
let linkChecks = 0;

for (const doc of docs) {
  const text = fs.readFileSync(path.resolve(PROJECT_ROOT, doc), 'utf8');
  const lines = text.split('\n');
  const fencedLines = fencedLineSet(text);
  // 作者声明逃生：所在行含标记词 → 计为"声明的非现实引用"，不判红
  const isDeclared = (line: number): boolean =>
    DECLARED_MARKERS.some((marker) => (lines[line - 1] ?? '').includes(marker));

  for (const { line, target } of collectBacktickPaths(text)) {
    if (isSkipped(target)) continue;
    pathChecks++;
    if (!fs.existsSync(path.resolve(PROJECT_ROOT, target))) {
      if (isDeclared(line)) {
        declaredRefs.push(`${doc}:${line} → ${target}`);
        continue;
      }
      missingPaths.push(`${doc}:${line} → ${target}`);
    }
  }

  for (const { line, target } of collectLinkTargets(text)) {
    if (fencedLines.has(line)) continue;
    // 链接目标按文档目录解析；跳过目录内的目标本地有、git 没有，不校验
    const resolved = path.resolve(path.dirname(path.resolve(PROJECT_ROOT, doc)), target);
    const relFromRoot = path.relative(PROJECT_ROOT, resolved);
    if (isSkipped(relFromRoot)) continue;
    linkChecks++;
    if (!fs.existsSync(resolved)) {
      if (isDeclared(line)) {
        declaredRefs.push(`${doc}:${line} → [链接] ${target}`);
        continue;
      }
      missingLinks.push(`${doc}:${line} → ${target}`);
    }
  }
}

check(
  `反引号代码路径全部存在（${pathChecks} 个）`,
  missingPaths.length === 0,
  missingPaths.join('; '),
);
check(
  `markdown 链接目标全部可解析（${linkChecks} 个）`,
  missingLinks.length === 0,
  missingLinks.join('; '),
);
if (declaredRefs.length > 0) {
  console.log(`  [INFO] 作者声明的非现实引用 ${declaredRefs.length} 处（拟建/示例，不判红）:`);
  for (const ref of declaredRefs) console.log(`         ${ref}`);
}

console.log(
  `\n文档引用完整性契约汇总: ${passed} PASS / ${failed} FAIL` +
    `（扫描 ${docs.length} 份手写文档，路径 ${pathChecks} 个 / 链接 ${linkChecks} 个）`,
);
process.exit(failed > 0 ? 1 : 0);
