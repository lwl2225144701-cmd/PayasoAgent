// i18n 扫描器：找出「用户可见位置仍写死中文」的代码。
//
// 用 TypeScript AST 精确判定，而不是正则/手写状态机——只有这四类节点会被检查：
//   - 字符串字面量（含 JSX 属性值，如 title="…"）
//   - 无插值模板字面量
//   - 模板字面量的各段（`${x} 中文` 里的中文同样会渲染给用户）
//   - JSX 文本节点
// 注释（行/块/JSDoc）不是 AST 节点，天然不在检查范围内——仓库约定注释保留中文。
//
// 豁免：
//   - `i18n/` 目录（消息表本体）
//   - 行内或上一行的 `i18n-exempt: <理由>` 注释（语言自称「中文」、`/permission 只读`
//     这类用户输入别名、纯开发期日志）

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const EXEMPT_MARK = 'i18n-exempt';

export interface CjkHit {
  file: string;
  line: number;
  text: string;
}

/** 扫描一份源码里所有用户可见位置的中文。 */
export function scanSource(file: string, source: string): CjkHit[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split('\n');
  const hits: CjkHit[] = [];

  const exempted = (line: number): boolean =>
    (lines[line - 1] ?? '').includes(EXEMPT_MARK) || (lines[line - 2] ?? '').includes(EXEMPT_MARK);

  const record = (pos: number, text: string): void => {
    if (!CJK.test(text)) return;
    const { line } = sf.getLineAndCharacterOfPosition(pos);
    if (exempted(line + 1)) return;
    hits.push({ file, line: line + 1, text: (lines[line] ?? '').trim().slice(0, 140) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node.getStart(sf), node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      record(node.getStart(sf), node.text);
    } else if (ts.isJsxText(node)) {
      record(node.getStart(sf), node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** 扫描指定文件列表，返回仍然含中文的用户可见位置。 */
export function scanUserVisibleCjk(files: string[], root = process.cwd()): CjkHit[] {
  const hits: CjkHit[] = [];
  for (const file of files) {
    if (file.split(path.sep).join('/').includes('/i18n/')) continue;
    const source = fs.readFileSync(path.resolve(root, file), 'utf8');
    hits.push(...scanSource(file, source));
  }
  return hits;
}

/** 递归列出目录下所有需要扫描的前端源码（.ts/.tsx，排除 i18n 目录）。 */
export function listWebSources(root = process.cwd()): string[] {
  const base = path.resolve(root, 'web/src');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'i18n') continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      out.push(path.relative(root, full));
    }
  };
  walk(base);
  return out.sort();
}
