// 内嵌浏览器只接受用户自己打开的 http/https。
// 没有协议时按主机补全：本机用 http（开发服务器常见），其余用 https。

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeBrowserUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  // javascript: / file: 这类没有 // 的协议不能被当成主机名补全。
  if (/^(javascript|data|file|blob|vbscript|about):/i.test(trimmed)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    if (!isHttpUrl(trimmed)) return null;
    return new URL(trimmed).toString();
  }
  const host = trimmed.split(/[/?#]/, 1)[0] ?? '';
  const candidate = `${LOCAL_HOST.test(host) ? 'http' : 'https'}://${trimmed}`;
  if (!isHttpUrl(candidate)) return null;
  return new URL(candidate).toString();
}
