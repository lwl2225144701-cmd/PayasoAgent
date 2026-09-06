// 模块: 可用模型目录 — 拉取 OpenAI 兼容端点的 GET {baseUrl}/models
// 仅 Host 内部使用：apiKey 只进请求头，绝不进入日志或 API 响应。

import { fetchAvailableModelCatalogSafe, type ProviderModelInfo } from './provider-url.js';

const MAX_MODELS = 200;

export async function fetchAvailableModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const catalog = await fetchAvailableModelCatalog(baseUrl, apiKey);
  return catalog.map((model) => model.id);
}

export async function fetchAvailableModelCatalog(
  baseUrl: string,
  apiKey: string,
): Promise<ProviderModelInfo[]> {
  const models = await fetchAvailableModelCatalogSafe(baseUrl, apiKey, {
    maxBodyBytes: 2_000_000,
    timeoutMs: 15_000,
    allowRedirect: false,
  });
  return models.slice(0, MAX_MODELS);
}
