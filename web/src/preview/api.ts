// Preview 域 API 客户端。
//
// 为什么不用通用 jsonFetch（web/src/api.ts）：它把错误体丢成纯文本
// （`API 400: 原文`），前端无法按错误码分叉。这里保留解析后的 { error: code }
// 并转成 PreviewApiError —— unsupported 要转 FallbackViewer、
// permission_denied 要禁写回按钮，全都以 code 为身份。
//
// 只读优先：M1/M2 只有 GET；写回（M5）在此文件扩展。

import { type PreviewScopeParam, previewFileUrl, previewQueryUrl } from './file-url';
import type { PreviewErrorCode, PreviewFileStat, PreviewTreeListing } from './types';

const PREVIEW_ERROR_CODE_SET: ReadonlySet<string> = new Set([
  'invalid_path',
  'outside_workspace',
  'not_found',
  'unsupported',
  'permission_denied',
  'no_workspace',
]);

/** 按码分叉的预览 API 异常（code 即身份，不携带 detail）。 */
export class PreviewApiError extends Error {
  constructor(readonly code: PreviewErrorCode) {
    super(code);
    this.name = 'PreviewApiError';
  }
}

/** 非 PreviewError 的网络/解析失败：带 HTTP 状态的普通错误。 */
export class PreviewNetworkError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewNetworkError';
  }
}

async function parseError(resp: Response): Promise<Error> {
  let payload: unknown;
  try {
    payload = (await resp.json()) as unknown;
  } catch {
    return new PreviewNetworkError(resp.status, `preview api ${resp.status}`);
  }
  const code = (payload as { error?: unknown } | null)?.error;
  if (typeof code === 'string' && PREVIEW_ERROR_CODE_SET.has(code)) {
    return new PreviewApiError(code as PreviewErrorCode);
  }
  return new PreviewNetworkError(resp.status, `preview api ${resp.status}`);
}

/** 列一层目录（懒加载：点开目录才请求下一级）。 */
export async function fetchTree(
  path: string,
  includeIgnored = false,
  scope?: PreviewScopeParam,
): Promise<PreviewTreeListing> {
  const resp = await fetch(
    previewQueryUrl('tree', path, { includeIgnored: String(includeIgnored) }, scope),
    {
      cache: 'no-store',
    },
  );
  if (!resp.ok) throw await parseError(resp);
  return (await resp.json()) as PreviewTreeListing;
}

/** 读文本文件内容（utf8）。图片/文档走 previewFileUrl / fetchFileBytes。 */
export async function fetchFileText(path: string, scope?: PreviewScopeParam): Promise<string> {
  const resp = await fetch(previewQueryUrl('file', path, undefined, scope), { cache: 'no-store' });
  if (!resp.ok) throw await parseError(resp);
  return resp.text();
}

/** 读文件原始字节（M3 的 PDF/Word/Excel viewer 用；M2 备用）。 */
export async function fetchFileBytes(
  path: string,
  scope?: PreviewScopeParam,
): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  const resp = await fetch(previewQueryUrl('file', path, undefined, scope), { cache: 'no-store' });
  if (!resp.ok) throw await parseError(resp);
  return {
    buffer: await resp.arrayBuffer(),
    mimeType: resp.headers.get('content-type') ?? 'application/octet-stream',
  };
}

/** 文件二进制直链（<img src> / 下载锚点用）。 */
export { previewFileUrl };

/** 单文件元数据。 */
export async function fetchStat(path: string, scope?: PreviewScopeParam): Promise<PreviewFileStat> {
  const resp = await fetch(previewQueryUrl('stat', path, undefined, scope), { cache: 'no-store' });
  if (!resp.ok) throw await parseError(resp);
  return (await resp.json()) as PreviewFileStat;
}
