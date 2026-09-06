// pi-ai 内置 Provider 的安全目录投影与运行时查找。
// 只暴露名称、地址和模型能力；认证信息永远不进入返回值。

import type { Api, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

export const PI_AI_MODEL_LIMIT = 50;

// 仅这几种 API 能用「单个用户填入 baseUrl + apiKey」跑通：
// anthropic-messages / openai-completions / openai-responses 都是标准 HTTP bearer-key 协议。
// bedrock（AWS SigV4）、google-vertex（OAuth/模板地址）、azure（账户专属空地址）、
// cloudflare（{ACCOUNT_ID} 模板）等不走当前流程，由其模型自然落选。
const STANDARD_HTTP_APIS = new Set<Api>([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
]);

// 可入选目录的模型：标准 HTTP API + 现成 https 端点（非 {占位} 模板）。
// opencode / opencode-go 这类 provider 级无 baseUrl，但每个 model 自带 https 地址，
// 用户在新增流程手动填入该地址即可让目录内每个模型都跑通。
function isEligibleModel(model: Model<Api>): boolean {
  return (
    STANDARD_HTTP_APIS.has(model.api) &&
    typeof model.baseUrl === 'string' &&
    /^https:\/\//.test(model.baseUrl) &&
    !model.baseUrl.includes('{')
  );
}

export interface PiAiModelInfo {
  id: string;
  name: string;
  api: Api;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  input: string[];
}

export interface PiAiProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  models: PiAiModelInfo[];
}

function supportedProvider(provider: Provider): boolean {
  if (!provider.auth?.apiKey) return false; // OAuth、AWS profile 不走当前 UI 流程
  const models = provider.getModels();
  if (models.length === 0) return false;
  // 有 provider 级 baseUrl：沿用旧行为，原生 API wire 已自带正确端点（如 google）。
  if (provider.baseUrl) return true;
  // 无 provider 级 baseUrl（如 opencode / opencode-go：地址写在每个 model 上）：
  // 仅当存在可入选模型（标准 HTTP API + 现成 https 端点）才放出来，由用户手动填入 baseUrl。
  // bedrock（SigV4）、azure（空地址）、vertex/cloudflare（{占位}模板）因此自然落选。
  return models.some((model) => isEligibleModel(model as Model<Api>));
}

function getSupportedProvider(providerId: string): Provider | undefined {
  return builtinProviders().find(
    (provider) => provider.id === providerId && supportedProvider(provider),
  );
}

function toModelInfo(model: Model<Api>): PiAiModelInfo {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: [...model.input],
  };
}

export function listPiAiProviderCatalog(): PiAiProviderInfo[] {
  return builtinProviders()
    .filter(supportedProvider)
    .map((provider) => {
      const allModels = provider.getModels();
      // 无 provider 级 baseUrl 时，只暴露能用「用户填入的单个 baseUrl」跑通的标准 HTTP 模型
      // （其原生 API 端点写在 model 上，但非标准 API 的模型无法靠单个地址跑通，故隐藏）。
      // 有 provider 级 baseUrl 时沿用全部模型（原生 wire 已自带正确端点）。
      const models = (
        provider.baseUrl
          ? allModels
          : allModels.filter((model) => isEligibleModel(model as Model<Api>))
      ).slice(0, PI_AI_MODEL_LIMIT);
      return {
        id: provider.id,
        name: provider.name,
        // provider 级无 baseUrl 时返回空串，由用户在新增流程手动填入
        baseUrl: (provider.baseUrl as string | undefined) ?? '',
        models: models.map((model) => toModelInfo(model as Model<Api>)),
      };
    });
}

export function getPiAiProviderModel(
  providerId: string,
  modelId: string,
): { provider: Provider; model: Model<Api> } | undefined {
  const provider = getSupportedProvider(providerId);
  if (!provider) return undefined;
  const model = provider.getModels().find((entry) => entry.id === modelId);
  if (!model) return undefined;
  return { provider, model: model as Model<Api> };
}

// createProvider() 要求的是 API wire 实现；内置 Provider 本身实现了同一份
// ProviderStreams 契约，因此可以复用 pi-ai 已注册的协议分发与流式行为。
export function asProviderStreams(provider: Provider): ProviderStreams {
  return provider;
}
