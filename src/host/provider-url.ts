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
  // 视觉能力有两个来源：内置注册表（内置 Provider 合并时带入，权威）与远端 /models
  // 的显式声明（见 extractVision，只在供应商明确表态时填）。自定义端点两者皆可能缺，
  // 缺省由设置页手工勾选。
  vision?: boolean;
  thinkingLevels?: string[];
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
  // asr 用分隔符锚定：只要求 `asr` 是独立段（mimo-v2.5-asr / whisper-large-asr），
  // 避免误伤把 asr 当子串的普通模型名。
  if (/whisper|tts|speech|audio|transcrib|voice|(^|[-_.])asr($|[-_.])/.test(value)) return 'audio';
  if (/dall[-_ ]?e|image|stable-diffusion|flux/.test(value)) return 'image';
  // OpenAI-compatible /models endpoints often omit capabilities. Treat unknown
  // models as chat candidates; only exclude unambiguously non-chat families.
  return 'chat';
}

/**
 * 从远端 /models 声明里读出「图片输入」能力。
 *
 * 只在**显式声明**时返回值，缺字段返回 `undefined` —— 远端不表态就绝不猜，视觉开关
 * 交给设置页手工勾选（自定义端点一直是这个规则）。已知形态：OpenRouter 风格的
 * `architecture.input_modalities`、`input_modalities` / `modalities` 列表，以及
 * `supports_vision` / `supports_image_input` 布尔标志。
 *
 * 优先级上，内置 Provider 的**静态注册表始终压过这里**（见 available-models 的合并：
 * 静态条目在前、远端条目只补缺口），所以本函数只对「远端独有的新模型」真正生效 ——
 * 不会把已知有视觉的模型改坏，也不会覆盖用户在设置页手填的值。
 */
function extractVision(record: Record<string, unknown>): boolean | undefined {
  const architecture =
    typeof record.architecture === 'object' &&
    record.architecture !== null &&
    !Array.isArray(record.architecture)
      ? (record.architecture as Record<string, unknown>)
      : undefined;
  const lists: unknown[] = [
    record.input_modalities,
    record.modalities,
    record.supported_modalities,
    architecture?.input_modalities,
    architecture?.modalities,
  ];
  for (const list of lists) {
    if (Array.isArray(list)) {
      return list.some((entry) => /^(image|vision|images)$/i.test(String(entry).trim()));
    }
    if (typeof list === 'string') {
      const parts = list.split(/[,|\s/]+/).filter(Boolean);
      if (parts.length > 0) {
        return parts.some((entry) => /^(image|vision|images)$/i.test(entry));
      }
    }
  }
  for (const flag of ['supports_vision', 'supports_image_input', 'vision']) {
    if (record[flag] === true) return true;
    if (record[flag] === false) return false;
  }
  return undefined;
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
      const vision = extractVision(record);
      models.set(id, {
        id,
        category: classifyProviderModel(id),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(vision !== undefined ? { vision } : {}),
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
