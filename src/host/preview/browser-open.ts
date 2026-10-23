// 内嵌浏览器打开请求 —— Agent / curl 把 http(s) URL 推给 GUI，由前端打开预览坞标签。
//
// 为什么不走工具清单：shell 任务里经常已经起好了本机服务，只差一跳「在面板里打开」；
// 单独 POST 比再塞一个 LLM 工具更轻，也避免扩大 Runtime 工具面。

type BrowserOpenListener = (url: string) => void;

const listeners = new Set<BrowserOpenListener>();

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 与前端 browser-url.ts 同口径：只接受 http/https，本机补 http。 */
export function normalizePreviewBrowserUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
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

export function subscribeBrowserOpen(listener: BrowserOpenListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishBrowserOpen(url: string): void {
  for (const listener of listeners) {
    try {
      listener(url);
    } catch {
      // 单个 SSE 客户端异常不能挡住其它订阅者
    }
  }
}
