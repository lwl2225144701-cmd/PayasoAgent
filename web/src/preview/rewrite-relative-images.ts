// 相对路径图片重写：把 Markdown 里的 ![alt](相对路径) 改写为
// /preview/file?path=... 直链，让工作区文档里的本地图片能显示。
//
// 纯函数（无 React/网络），被 MarkdownViewer 与前端单测共用。

import { type PreviewScopeParam, previewFileUrl } from './file-url';

/** 协议/绝对/锚点类前缀：这些不做相对解析。 */
const NON_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;

/**
 * ![alt](url) 或 ![alt](<url> "title")；三组捕获：
 * ① `![alt](` 前缀（含空白）② url（尖括号或裸串）③ title + 收尾括号。
 * 分组重建而不是整段替换——title 等附加语法必须原样保留。
 */
const MARKDOWN_IMAGE = /(!\[[^\]]*\]\(\s*)(<[^>]*>|[^)\s]+)((?:\s+["'][^"']*["'])?\s*\))/g;

/** POSIX 相对路径拼接：'a/b' + './c.png' → 'a/b/c.png'；'a/b' + '../c.png' → 'a/c.png'。 */
export function joinRelPath(baseDir: string, rel: string): string {
  const baseSegs = baseDir.length > 0 ? baseDir.split('/') : [];
  const relSegs = rel.split('/');
  const out = [...baseSegs];
  for (const seg of relSegs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // 逃出 base：保留 ..（后端会按 outside_workspace 拒绝，前端不猜）
      if (out.length > 0) out.pop();
      else out.push('..');
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** 相对路径 → /preview/file?path=... 直链（编码规则与 api.ts 共用 file-url）。 */
export function toPreviewFileUrl(baseDir: string, rel: string, scope?: PreviewScopeParam): string {
  const joined = joinRelPath(baseDir, rel).replace(/^\.\//, '');
  return previewFileUrl(joined, scope);
}

/**
 * 重写 Markdown 文本中的相对路径图片。
 * @param markdown 原始 Markdown 文本
 * @param baseDir 文档所在目录（POSIX 相对路径；'' = 工作区根）
 * @param scope 预览作用域（会话 Run）；图片直链必须带同一个 runId，
 *   否则文档来自历史会话的工作区时图片会 404。
 */
export function rewriteRelativeImages(
  markdown: string,
  baseDir: string,
  scope?: PreviewScopeParam,
): string {
  return markdown.replace(MARKDOWN_IMAGE, (whole, pre: string, rawUrl: string, post: string) => {
    const url = rawUrl.startsWith('<') && rawUrl.endsWith('>') ? rawUrl.slice(1, -1) : rawUrl;
    if (NON_RELATIVE.test(url)) return whole; // http(s)/data/协议相对/锚点/绝对路径：原样
    return `${pre}${toPreviewFileUrl(baseDir, url, scope)}${post}`;
  });
}
