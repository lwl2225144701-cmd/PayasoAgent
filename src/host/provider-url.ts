// 模块: Provider URL 统一校验与规范化
// 所有 Provider endpoint 必须经过本模块校验，禁止散落各处的正则。

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);
const LOOPBACK_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i;
const MAX_URL_LENGTH = 2048;

export interface CanonicalizeOptions {
  /** 是否允许 loopback HTTP（默认仅允许 HTTPS） */
  allowLoopbackHttp?: boolean;
  /** 是否允许尾部斜杠（默认去除） */
  allowTrailingSlash?: boolean;
}

export function canonicalizeProviderBaseUrl(input: string, options: CanonicalizeOptions = {}): string {
  const trimmed = input.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new Error("baseUrl too long");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("baseUrl must be a valid URL");
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("baseUrl protocol not allowed");
  }

  // 禁止 username/password
  if (parsed.username || parsed.password) {
    throw new Error("baseUrl must not contain credentials");
  }

  // 禁止 file/ftp/data/javascript
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("baseUrl protocol not allowed");
  }

  // 空 hostname
  if (!parsed.hostname) {
    throw new Error("baseUrl must have a hostname");
  }

  // HTTP 仅允许 loopback（开发模式）
  if (parsed.protocol === "http:") {
    if (!options.allowLoopbackHttp || !LOOPBACK_PATTERN.test(trimmed)) {
      throw new Error("baseUrl protocol not allowed");
    }
  }

  // 尾部斜杠策略：默认去除
  let pathname = parsed.pathname;
  if (!options.allowTrailingSlash) {
    pathname = pathname.replace(/\/+$/, "") || "/";
  }

  // 重建 URL（去除 fragment/query 等无关部分）
  const canonical = `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
  if (canonical.length > MAX_URL_LENGTH) {
    throw new Error("baseUrl too long");
  }

  return canonical;
}

export interface FetchAvailableModelsOptions {
  /** 响应体大小上限（默认 2MB） */
  maxBodyBytes?: number;
  /** 请求超时（默认 15s） */
  timeoutMs?: number;
  /** 是否允许 redirect（默认拒绝） */
  allowRedirect?: boolean;
}

export async function fetchAvailableModelsSafe(
  baseUrl: string,
  apiKey: string,
  opts: FetchAvailableModelsOptions = {},
): Promise<string[]> {
  const { maxBodyBytes = 2_000_000, timeoutMs = 15_000, allowRedirect = false } = opts;

  // 再次校验 endpoint（双重保险）
  const canonical = canonicalizeProviderBaseUrl(baseUrl, { allowLoopbackHttp: true });
  const url = `${canonical.replace(/\/+$/, "")}/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        redirect: allowRedirect ? "follow" : "error",
      });
    } catch (err) {
      const reason = controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : (err as Error).message;
      // 不暴露底层 DNS/TLS/系统错误细节
      throw new Error("Provider /models unreachable");
    }

    // 不向前端返回完整 endpoint
    if (!res.ok) {
      let body = "";
      try {
        const text = await res.text();
        body = text.slice(0, 300);
      } catch {
        // ignore
      }
      throw new Error(`Provider /models returned ${res.status}`);
    }

    // 限制响应大小
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      throw new Error("Provider /models response too large");
    }

    // 流式读取并限制实际字节数
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("Provider /models returned empty response");
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        reader.cancel();
        throw new Error("Provider /models response too large");
      }
      chunks.push(value);
    }

    const buffer = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    let data: unknown;
    try {
      data = JSON.parse(Buffer.from(buffer).toString("utf8"));
    } catch {
      throw new Error("Provider /models returned invalid JSON");
    }

    const rows = typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)
      ? (data as { data: unknown[] }).data
      : undefined;
    if (!rows) throw new Error("Provider /models response missing data array");

    const ids = new Set<string>();
    for (const row of rows) {
      const id = typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string"
        ? (row as { id: string }).id.trim()
        : "";
      if (id) ids.add(id);
      if (ids.size >= 200) break;
    }
    if (ids.size === 0) throw new Error("Provider /models returned no models");
    return [...ids].sort((a, b) => a.localeCompare(b));
  } finally {
    clearTimeout(timer);
  }
}
