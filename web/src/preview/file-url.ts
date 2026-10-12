// /preview URL 构造：全模块唯一一处编码规则。
//
// 约定：路径逐段 encodeURIComponent、段间保留裸 '/'（可读，且后端
// URLSearchParams 解码后 split(/[\\/]+/) 同样按 / 分段，两种形式都通）。
// api.ts 与 rewrite-relative-images.ts 共用本模块，杜绝两处编码漂移。

/** POSIX 相对路径 → 查询串安全的路径值（逐段编码）。 */
export function encodeRelPath(rel: string): string {
  return rel
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * 预览作用域参数：`runId` 存在时后端按**该会话 Run 的工作区**取文件。
 *
 * 为什么要它：Host 的"当前工作区"是进程内状态（重启即丢），而用户经常是
 * 直接点开一条历史会话看文件——没有它时面板只能报 no_workspace。
 * 与 `/runs/:id/files` 同一套信任模型（那条端点本来就能读任意 Run 的工作区）。
 */
export interface PreviewScopeParam {
  runId?: string | null;
}

function scopeQuery(scope?: PreviewScopeParam): Record<string, string> {
  return scope?.runId ? { runId: scope.runId } : {};
}

/** 文件直链（<img src> / 下载锚点用）。 */
export function previewFileUrl(path: string, scope?: PreviewScopeParam): string {
  const extra = new URLSearchParams(scopeQuery(scope)).toString();
  return `/preview/file?path=${encodeRelPath(path)}${extra ? `&${extra}` : ''}`;
}

/** 带 path 参数的预览端点 URL（tree/stat/file 通用）。 */
export function previewQueryUrl(
  sub: string,
  path: string,
  extra?: Record<string, string>,
  scope?: PreviewScopeParam,
): string {
  const params = new URLSearchParams({ path, ...extra, ...scopeQuery(scope) });
  // URLSearchParams 会把空格编码成 '+'；统一替换为 %20 保持可读与一致
  const query = params.toString().replace(/\+/g, '%20').replace(/%2F/g, '/');
  return `/preview/${sub}?${query}`;
}
