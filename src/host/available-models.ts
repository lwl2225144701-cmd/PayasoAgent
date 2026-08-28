// 模块: 可用模型目录 — 拉取 OpenAI 兼容端点的 GET {baseUrl}/models
// 仅 Host 内部使用：apiKey 只进请求头，绝不进入日志或 API 响应。

const MAX_MODELS = 200; // 返回上限（存储层另有单 Provider ≤50 的目录上限，由前端合并时截取）
const TIMEOUT_MS = 15_000;
const MAX_CONTENT_LENGTH = 2_000_000; // /models 响应体上限（防御异常端点）

export async function fetchAvailableModels(baseUrl: string, apiKey: string): Promise<string[]> {
  if (!/^https?:\/\/\S+$/i.test(baseUrl)) {
    throw new Error("baseUrl must be a valid HTTP/HTTPS URL");
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
    } catch (err) {
      const reason = controller.signal.aborted
        ? `timed out after ${TIMEOUT_MS}ms`
        : (err as Error).message;
      throw new Error(`Failed to reach ${url}: ${reason}`);
    }
    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 300);
      } catch {
        // 读取错误 body 失败不影响状态码信息
      }
      throw new Error(`Provider /models returned ${res.status}${body ? `: ${body}` : ""}`);
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_LENGTH) {
      throw new Error("Provider /models response too large");
    }
    let data: unknown;
    try {
      data = await res.json();
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
      if (ids.size >= MAX_MODELS) break;
    }
    if (ids.size === 0) throw new Error("Provider /models returned no models");
    return [...ids].sort((a, b) => a.localeCompare(b));
  } finally {
    clearTimeout(timer);
  }
}
