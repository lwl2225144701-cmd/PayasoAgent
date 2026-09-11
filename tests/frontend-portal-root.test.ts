import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PORTAL_ROOT_ID, portalRoot } from '../web/src/portal-root.js';

// 契约：portal 的落点必须是「不会被全局规则隐藏」的容器。
//
// 背景（真实事故）：Modal 曾被改成 `createPortal(..., document.body)`，
// 而 index.css 有一条全局规则把 <body> 的直接子元素默认全部隐藏
// （body > :not(#root):not(#payaso-portal-root):... { display: none !important }）。
// 结果模态渲染成功、DOM 里也在、控制台无报错，但用户完全看不见——表现为「点了没反应」。
// 这类问题不看 CSS 根本查不出来，所以用契约锁死两侧：
//   1. 容器侧：index.html 提供 #payaso-portal-root，且 index.css 的白名单里有它；
//   2. 使用侧：每个 createPortal 的目标都必须是 portalRoot()。

const PROJECT_ROOT = process.cwd();
const WEB_SRC = path.resolve(PROJECT_ROOT, 'web', 'src');
const INDEX_HTML = path.resolve(PROJECT_ROOT, 'web', 'index.html');
const INDEX_CSS = path.resolve(WEB_SRC, 'index.css');

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

// ---- 1. portalRoot() 的取值行为 ----
function withDocument(fake: unknown, fn: () => void): void {
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fake;
  try {
    fn();
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
}

check('容器存在时返回 #payaso-portal-root', () => {
  const container = { id: PORTAL_ROOT_ID };
  withDocument(
    { getElementById: (id: string) => (id === PORTAL_ROOT_ID ? container : null), body: {} },
    () => {
      assert.equal(portalRoot(), container);
    },
  );
});

check('容器缺失时兜底到 document.body（单测环境）', () => {
  const body = { id: 'body' };
  withDocument({ getElementById: () => null, body }, () => {
    assert.equal(portalRoot(), body);
  });
});

check('容器 id 常量与 index.html 一致', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf-8');
  assert.ok(
    html.includes(`id="${PORTAL_ROOT_ID}"`),
    `index.html 未提供 #${PORTAL_ROOT_ID} 容器（portal 将落到 body 并被隐藏）`,
  );
});

// ---- 2. 容器侧：白名单必须包含该容器 ----
check('index.css 的「隐藏 body 直接子元素」规则白名单包含 portal 容器', () => {
  const css = fs.readFileSync(INDEX_CSS, 'utf-8');
  // 取出 body > :not(...) 这条选择器
  const start = css.indexOf('body\n> :not(#root)');
  const startAlt = css.indexOf('body > :not(#root)');
  const from = start >= 0 ? start : startAlt;
  assert.ok(
    from >= 0,
    'index.css 里找不到「隐藏 body 直接子元素」的规则（规则被删或改写，需重新确认本契约）',
  );
  const brace = css.indexOf('{', from);
  const selector = css.slice(from, brace);
  assert.ok(
    selector.includes(`:not(#${PORTAL_ROOT_ID})`),
    `隐藏规则未豁免 #${PORTAL_ROOT_ID}：${selector.replace(/\s+/g, ' ')}`,
  );
  const block = css.slice(brace, css.indexOf('}', brace));
  assert.ok(
    block.includes('display: none'),
    '该规则不再是 display:none —— 本契约的前提变了，需重新评估',
  );
});

// ---- 3. 使用侧：所有 createPortal 必须走 portalRoot() ----
interface PortalCall {
  file: string;
  line: number;
  target: string;
}

function listWebSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listWebSources(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function collectPortalCalls(): PortalCall[] {
  const calls: PortalCall[] = [];
  for (const file of listWebSources(WEB_SRC)) {
    const text = fs.readFileSync(file, 'utf-8');
    if (!text.includes('createPortal')) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'createPortal') {
          const target = node.arguments[1];
          calls.push({
            file: path.relative(PROJECT_ROOT, file),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            target: target ? target.getText(source).replace(/\s+/g, ' ') : '(缺少容器参数)',
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

const portalCalls = collectPortalCalls();

check('代码里确实存在 createPortal 调用（否则本契约形同虚设）', () => {
  assert.ok(portalCalls.length > 0, '一个 createPortal 调用都没找到，扫描逻辑可能失效');
});

check('每个 createPortal 的目标都是 portalRoot()', () => {
  const offenders = portalCalls.filter((call) => call.target !== 'portalRoot()');
  assert.equal(
    offenders.length,
    0,
    offenders.map((c) => `${c.file}:${c.line} → ${c.target}`).join('; '),
  );
});

console.log(`\n（扫描到 ${portalCalls.length} 处 createPortal）`);
console.log(`Frontend portal-root tests: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exit(1);
