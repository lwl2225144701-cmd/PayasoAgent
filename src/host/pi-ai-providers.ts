// pi-ai 内置 Provider 的安全目录投影与运行时查找。
// 只暴露名称、地址和模型能力；认证信息永远不进入返回值。

import type { Api, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
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
// 保存时由 Host 按所选模型解析真实地址。
function isEligibleModel(model: Model<Api>): boolean {
  return (
    STANDARD_HTTP_APIS.has(model.api) &&
    typeof model.baseUrl === 'string' &&
    /^https:\/\//.test(model.baseUrl) &&
    !model.baseUrl.includes('{')
  );
}

// ── 本地模型补丁（overlay）──────────────────────────────────────────────────
//
// 内置目录来自 pi-ai 的构建期静态数据：供应商上新（如 MiMo v2.6 系列）到依赖升级
// 之间存在时间差，期间新模型在目录里查不到——设置页选不到、保存被校验拒绝、运行时
// 也拿不到协议元数据。补丁让官方文档已确认的模型立刻在这三处成为一等公民。
//
// 只声明与模板模型不同的字段：api / baseUrl / compat / cost / reasoning /
// thinkingLevelMap 从同 Provider 的模板模型继承。MiMo v2.6 与 v2.5 同协议族
// （openai-completions + deepseek thinkingFormat），差异只在 id / 名称 / 上下文能力。
// 依赖升级后 pi-ai 自带这些模型时，补丁会被同 id 的静态条目自动让位（见
// providerRuntimeModels 的去重），因此补丁可以长期保留、无需人工下线。
interface BuiltinModelOverlay {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: ('text' | 'image')[];
  /** 继承 api / baseUrl / compat / cost / thinkingLevelMap 的同 Provider 模板模型 */
  templateModelId: string;
}

// MiMo v2.6 系列能力（官方模型列表 + pi 注册表确认）：1M 上下文 / 128K 最大输出 /
// 全模态理解（text + image）/ 深度思考。
const MIMO_V26_CAPABILITY: Omit<BuiltinModelOverlay, 'id' | 'name'> = {
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  input: ['text', 'image'],
  templateModelId: 'mimo-v2.5',
};

const BUILTIN_MODEL_OVERLAY: Record<string, BuiltinModelOverlay[]> = {
  // API 计费端点：v2.6 三款（UltraSpeed 为定制服务）
  xiaomi: [
    { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', ...MIMO_V26_CAPABILITY },
    { id: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', ...MIMO_V26_CAPABILITY },
    { id: 'mimo-v2.6-pro-ultraspeed', name: 'MiMo-V2.6-Pro-UltraSpeed', ...MIMO_V26_CAPABILITY },
  ],
  // Token Plan 三区域：官方只开放 pro / flash 两款
  'xiaomi-token-plan-cn': [
    { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', ...MIMO_V26_CAPABILITY },
    { id: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', ...MIMO_V26_CAPABILITY },
  ],
  'xiaomi-token-plan-ams': [
    { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', ...MIMO_V26_CAPABILITY },
    { id: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', ...MIMO_V26_CAPABILITY },
  ],
  'xiaomi-token-plan-sgp': [
    { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', ...MIMO_V26_CAPABILITY },
    { id: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', ...MIMO_V26_CAPABILITY },
  ],
};

function buildOverlayModel(
  provider: Provider,
  overlay: BuiltinModelOverlay,
): Model<Api> | undefined {
  const models = provider.getModels() as Model<Api>[];
  const template = models.find((model) => model.id === overlay.templateModelId) ?? models[0];
  if (!template) return undefined;
  return {
    ...template,
    id: overlay.id,
    name: overlay.name,
    provider: provider.id,
    contextWindow: overlay.contextWindow,
    maxTokens: overlay.maxTokens,
    input: [...overlay.input],
  };
}

export interface PiAiModelInfo {
  id: string;
  name: string;
  api: Api;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  // 该模型真正支持的思考档次（off 恒在列；xhigh/max 仅注册表显式声明时出现）。
  // 设置页按此列表渲染档次下拉；自定义端点无注册表，由前端给全量 5 档。
  thinkingLevels: string[];
  input: string[];
}

export interface PiAiProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  // 能否用已保存的 apiKey 直接 GET {baseUrl}/models 刷新目录（见
  // isRemoteRefreshableProvider）。false 时目录只有静态数据，设置页不做远端探测。
  refreshable: boolean;
  models: PiAiModelInfo[];
}

function supportedProvider(provider: Provider): boolean {
  if (!provider.auth?.apiKey) return false; // OAuth、AWS profile 不走当前 UI 流程
  const models = provider.getModels();
  if (models.length === 0) return false;
  // 有 provider 级 baseUrl：沿用旧行为，原生 API wire 已自带正确端点（如 google）。
  if (provider.baseUrl) return true;
  // 无 provider 级 baseUrl（如 opencode / opencode-go：地址写在每个 model 上）：
  // 仅当存在可入选模型（标准 HTTP API + 现成 https 端点）才放出来。
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
    thinkingLevels: getSupportedThinkingLevels(model),
    input: [...model.input],
  };
}

// 目录里实际对外的模型集合 = pi-ai 静态目录（按 eligibility 过滤）+ 本地补丁。
// 顺序稳定：静态在前、补丁在后，且同 id 时静态条目胜出——依赖升级后补丁自动让位，
// 不会出现两份元数据互相覆盖。
export function providerRuntimeModels(provider: Provider): Model<Api>[] {
  const all = provider.getModels() as Model<Api>[];
  // 无 provider 级 baseUrl 时，只暴露有独立地址且能由当前协议适配层跑通的模型
  // （非标准 API 的模型无法在当前运行时安全解析，故隐藏）。
  // 有 provider 级 baseUrl 时沿用全部模型（原生 wire 已自带正确端点）。
  const eligible = provider.baseUrl ? all : all.filter((model) => isEligibleModel(model));
  const overlay = overlayModelsFor(provider).filter(
    (model) => !eligible.some((existing) => existing.id === model.id),
  );
  return [...eligible, ...overlay];
}

function overlayModelsFor(provider: Provider): Model<Api>[] {
  const entries = BUILTIN_MODEL_OVERLAY[provider.id];
  if (!entries) return [];
  return entries
    .map((entry) => buildOverlayModel(provider, entry))
    .filter((model): model is Model<Api> => model !== undefined);
}

export function listPiAiProviderCatalog(): PiAiProviderInfo[] {
  return builtinProviders()
    .filter(supportedProvider)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      // provider 级无 baseUrl 时返回空串；保存/调用阶段按模型解析真实地址
      baseUrl: (provider.baseUrl as string | undefined) ?? '',
      refreshable: isRemoteRefreshableProvider(provider.id),
      models: providerRuntimeModels(provider)
        .slice(0, PI_AI_MODEL_LIMIT)
        .map((model) => toModelInfo(model)),
    }));
}

// 能否用「已保存的 apiKey」直接 GET {baseUrl}/models 刷新目录。
//
// 资格由两件**协议事实**决定（都是稳定的，不像模型清单会随发布而变）：
//   ① Provider 级 https 地址（模型级地址没有端点可探）；
//   ② 全部模型走 Bearer 鉴权 + OpenAI 约定的 `{baseUrl}/models` 端点 ——
//      openai-completions / openai-responses 同属这一族。
//
// 明确排除（不要为了覆盖度去猜）：
//   · `anthropic-messages`：鉴权头是 `x-api-key` + `anthropic-version`，且路径约定
//     各家不同（官方是 `${baseUrl}/v1/models`，emulation 端点可能带 `/anthropic` 前缀），
//     无凭据时无法验证，猜错=每次启动都报一次无用告警；
//   · 混合 API 的 Provider（openrouter / fireworks / github-copilot）：单一 baseUrl 下
//     混了多种 wire，无法从 API 类型推出唯一鉴权与路径；
//   · 非标准 API（google-generative-ai / mistral-conversations）与按模型地址的 Provider。
// 这些属已知缺口，见 docs/plans/builtin-model-catalog-refresh.md §5.2。
const MODEL_LIST_APIS = new Set<Api>(['openai-completions', 'openai-responses']);

export function isRemoteRefreshableProvider(providerId: string): boolean {
  const provider = getSupportedProvider(providerId);
  if (!provider) return false;
  const baseUrl = provider.baseUrl;
  if (typeof baseUrl !== 'string' || !/^https:\/\//.test(baseUrl) || baseUrl.includes('{')) {
    return false;
  }
  const models = provider.getModels();
  return models.length > 0 && models.every((model) => MODEL_LIST_APIS.has(model.api));
}

export function getPiAiProviderModel(
  providerId: string,
  modelId: string,
): { provider: Provider; model: Model<Api> } | undefined {
  const provider = getSupportedProvider(providerId);
  if (!provider) return undefined;
  const model = providerRuntimeModels(provider).find((entry) => entry.id === modelId);
  if (!model) return undefined;
  return { provider, model };
}

// 远端 /models 探测到、但不在静态目录（含本地补丁）里的模型：供应商上新总是早于
// 依赖升级。这些 id 已由 Host 用远端探测结果校验过（只允许已配置 Provider 目录内的
// 模型进入 Run），运行时按同 Provider 的模板模型合成等价 Model ——
// api / baseUrl / compat / reasoning / cost / thinkingLevelMap 与同族模型一致。
// 视觉能力刻意不继承模板：远端 /models 无法可靠声明图片输入，按自定义端点的同一套
// 规则处理（设置页勾选后才把 image 加入 input，见 llm.ts）。
// 仅对可用远端刷新的 Provider 生效：其余 Provider 的目录不可能出现静态目录之外的
// 合法模型，此处合成只会掩盖配置错误。
export function getPiAiDiscoveredModel(
  providerId: string,
  modelId: string,
): { provider: Provider; model: Model<Api> } | undefined {
  if (!isRemoteRefreshableProvider(providerId)) return undefined;
  const provider = getSupportedProvider(providerId);
  if (!provider) return undefined;
  const template = (provider.getModels() as Model<Api>[]).find((model) => isEligibleModel(model));
  if (!template) return undefined;
  return {
    provider,
    model: {
      ...template,
      id: modelId,
      name: modelId,
      provider: provider.id,
      input: ['text'],
    },
  };
}

// 运行时解析模型的唯一入口：先查目录（静态 + 本地补丁），再兜底合成远端发现的模型。
export function resolvePiAiRuntimeModel(
  providerId: string,
  modelId: string,
): { provider: Provider; model: Model<Api> } | undefined {
  return getPiAiProviderModel(providerId, modelId) ?? getPiAiDiscoveredModel(providerId, modelId);
}

// 返回运行时真正使用的地址。大多数 Provider 在 Provider 级声明地址；
// opencode 这类 Provider 把地址写在模型级，内置流程不需要用户填写 baseUrl。
export function getPiAiProviderBaseUrl(providerId: string, modelId?: string): string | undefined {
  const provider = getSupportedProvider(providerId);
  if (!provider) return undefined;
  if (provider.baseUrl) return provider.baseUrl;
  if (!modelId) return undefined;
  const model = providerRuntimeModels(provider).find((entry) => entry.id === modelId);
  return model?.baseUrl || undefined;
}

// createProvider() 要求的是 API wire 实现；内置 Provider 本身实现了同一份
// ProviderStreams 契约，因此可以复用 pi-ai 已注册的协议分发与流式行为。
export function asProviderStreams(provider: Provider): ProviderStreams {
  return provider;
}
