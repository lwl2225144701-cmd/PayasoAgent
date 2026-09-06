// 模块: Provider URL 统一校验与规范化
// 所有 Provider endpoint 必须经过本模块校验，禁止散落各处的正则。

import { getKnownModelCapability } from '../harness/model-context.js';

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);
const LOOPBACK_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i;
const MAX_URL_LENGTH = 2048;

export interface CanonicalizeOptions {
  /** 是否允许 loopback HTTP（默认仅允许 HTTPS） */
  allowLoopbackHttp?: boolean;
  /** 是否允许尾部斜杠（默认去除） */
  allowTrailingSlash?: boolean;
}

export function canonicalizeProviderBaseUrl(
  input: string,
  options: CanonicalizeOptions = {},
): string {
  const trimmed = input.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new Error('baseUrl too long');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('baseUrl must be a valid URL');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('baseUrl protocol not allowed');
  }

  // 禁止 username/password
  if (parsed.username || parsed.password) {
    throw new Error('baseUrl must not contain credentials');
  }

  // 禁止 file/ftp/data/javascript
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('baseUrl protocol not allowed');
  }

  // 空 hostname
  if (!parsed.hostname) {
    throw new Error('baseUrl must have a hostname');
  }

  // HTTP 仅允许 loopback（开发模式）
  if (parsed.protocol === 'http:') {
    if (!options.allowLoopbackHttp || !LOOPBACK_PATTERN.test(trimmed)) {
      throw new Error('baseUrl protocol not allowed');
    }
  }

  // 尾部斜杠策略：默认去除
  let pathname = parsed.pathname;
  if (!options.allowTrailingSlash) {
    pathname = pathname.replace(/\/+$/, '') || '/';
  }

  // 重建 URL（去除 fragment/query 等无关部分）
  const canonical = `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
  if (canonical.length > MAX_URL_LENGTH) {
    throw new Error('baseUrl too long');
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

export type ProviderModelCategory =
  | 'chat'
  | 'embedding'
  | 'rerank'
  | 'image'
  | 'audio'
  | 'moderation';

export interface ProviderModelInfo {
  id: string;
  category: ProviderModelCategory;
  contextWindow?: number;
  maxOutputTokens?: number;
}

function positiveNumber(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = positiveNumber(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function classifyProviderModel(id: string): ProviderModelCategory {
  const value = id.toLowerCase();
  if (/embed|embedding|text-\w*-ada|bge-\w*-en|e5-/.test(value)) return 'embedding';
  if (/rerank|re-rank|cross[-_ ]?encoder/.test(value)) return 'rerank';
  if (/moderation|safety-classifier/.test(value)) return 'moderation';
  if (/whisper|tts|speech|audio|transcrib|voice/.test(value)) return 'audio';
  if (/dall[-_ ]?e|image|stable-diffusion|flux/.test(value)) return 'image';
  // OpenAI-compatible /models endpoints often omit capabilities. Treat unknown
  // models as chat candidates; only exclude unambiguously non-chat families.
  return 'chat';
}

export async function fetchAvailableModelCatalogSafe(
  baseUrl: string,
  apiKey: string,
  opts: FetchAvailableModelsOptions = {},
): Promise<ProviderModelInfo[]> {
  const { maxBodyBytes = 2_000_000, timeoutMs = 15_000, allowRedirect = false } = opts;

  // 再次校验 endpoint（双重保险）
  const canonical = canonicalizeProviderBaseUrl(baseUrl, { allowLoopbackHttp: true });
  const url = `${canonical.replace(/\/+$/, '')}/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        redirect: allowRedirect ? 'follow' : 'error',
      });
    } catch {
      // 不暴露底层 DNS/TLS/系统错误细节
      throw new Error('Provider /models unreachable');
    }

    // 不向前端返回完整 endpoint
    if (!res.ok) {
      try {
        await res.text();
      } catch {
        // ignore
      }
      throw new Error(`Provider /models returned ${res.status}`);
    }

    // 限制响应大小
    const contentLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      throw new Error('Provider /models response too large');
    }

    // 流式读取并限制实际字节数
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('Provider /models returned empty response');
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        reader.cancel();
        throw new Error('Provider /models response too large');
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
      data = JSON.parse(Buffer.from(buffer).toString('utf8'));
    } catch {
      throw new Error('Provider /models returned invalid JSON');
    }

    const rows =
      typeof data === 'object' && data !== null && Array.isArray((data as { data?: unknown }).data)
        ? (data as { data: unknown[] }).data
        : undefined;
    if (!rows) throw new Error('Provider /models response missing data array');

    const models = new Map<string, ProviderModelInfo>();
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const record = row as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      if (!id || models.has(id)) continue;
      const knownCapability = getKnownModelCapability(id);
      const contextWindow =
        firstNumber(record, [
          'context_length',
          'context_window',
          'max_context_length',
          'max_model_len',
          'input_token_limit',
          'max_input_tokens',
        ]) ?? knownCapability?.contextWindowTokens;
      const maxOutputTokens =
        firstNumber(record, ['max_output_tokens', 'max_completion_tokens', 'output_token_limit']) ??
        knownCapability?.maxOutputTokens;
      models.set(id, {
        id,
        category: classifyProviderModel(id),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      });
      if (models.size >= 200) break;
    }
    if (models.size === 0) throw new Error('Provider /models returned no models');
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAvailableModelsSafe(
  baseUrl: string,
  apiKey: string,
  opts: FetchAvailableModelsOptions = {},
): Promise<string[]> {
  const catalog = await fetchAvailableModelCatalogSafe(baseUrl, apiKey, opts);
  return catalog.map((model) => model.id);
}
