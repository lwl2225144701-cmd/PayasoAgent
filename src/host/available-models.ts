// 模块: 可用模型目录 — 拉取 OpenAI 兼容端点的 GET {baseUrl}/models
// 仅 Host 内部使用：apiKey 只进请求头，绝不进入日志或 API 响应。

import type { BuiltinRemoteCatalogEntry } from './persistence/settings-store.js';
import {
  listPiAiProviderCatalog,
  type PiAiModelInfo,
  type PiAiProviderInfo,
} from './pi-ai-providers.js';
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

/** 静态条目 → ProviderModelInfo（能力以静态注册表为权威，见下面 mergeBuiltinsAndRemote）。 */
function fromBuiltinModel(model: PiAiModelInfo): ProviderModelInfo {
  return {
    id: model.id,
    category: 'chat',
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    vision: model.input.includes('image'),
    thinkingLevels: model.thinkingLevels,
  };
}

/**
 * 目录合并的**唯一实现** —— 实时网络与读缓存两条路径共用，保证目录永远同构。
 *
 * 规则：
 *   1. 静态条目在前，能力字段以静态注册表为权威（视觉、思考档次、上下文窗口）；
 *   2. 远端独有条目追加（供应商上新早于依赖升级），带远端声明的能力补缺；
 *   3. 远端的非对话模型（embedding / tts / asr / image…）**不进对话 Provider 的
 *      可选目录** —— 混进来会让默认模型可能落在 TTS 上，且它们无法用于对话。
 *
 * 只过滤「展示」：准入名单仍记远端全部 id。分类是启发式的，宁可让用户手动补上一个
 * 被误分类的真实模型，也不能把一个可用的对话模型挡在门外（见 classifyProviderModel）。
 */
function mergeBuiltinsAndRemote(
  builtinModels: PiAiModelInfo[],
  remoteModels: ProviderModelInfo[],
): { merged: ProviderModelInfo[]; builtinById: Map<string, PiAiModelInfo> } {
  const builtinById = new Map<string, PiAiModelInfo>(builtinModels.map((m) => [m.id, m]));
  const merged: ProviderModelInfo[] = builtinModels.map(fromBuiltinModel);
  const known = new Set(merged.map((model) => model.id));
  for (const model of remoteModels) {
    if (known.has(model.id)) continue;
    if (model.category !== 'chat') continue;
    known.add(model.id);
    merged.push(model);
  }
  return { merged: merged.slice(0, MAX_MODELS), builtinById };
}

// 内置 Provider 的目录刷新：远端 /models 与 pi-ai 内置目录（含本地补丁）取并集。
//
// 为什么需要合并而不是直接用远端结果：内置注册表是协议元数据的唯一权威——视觉能力、
// 思考档次、api/compat 只有它知道；远端 /models 只声明 id（以及偶尔的上下文长度）。
//
// remoteModelIds 供 Host 记录准入名单：远端探测是「该内置 Provider 还能保存哪些模型」
// 的证据来源（见 settings-store 的 builtinDiscoveredModels）。
export async function fetchBuiltinProviderCatalog(
  piProviderId: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ catalog: ProviderModelInfo[]; remoteModelIds: string[] }> {
  const remote = await fetchAvailableModelCatalog(baseUrl, apiKey);
  const builtin = listPiAiProviderCatalog().find((provider) => provider.id === piProviderId);
  const { merged } = mergeBuiltinsAndRemote(builtin?.models ?? [], remote);

  return {
    catalog: merged,
    // 准入名单取远端**全部** id（含非对话模型）：它只放宽保存校验，不决定展示，
    // 分类错误不该把用户手动输入的真实模型挡在门外。
    remoteModelIds: remote.map((model) => model.id).slice(0, MAX_MODELS),
  };
}

/**
 * 把缓存的远端目录叠到静态目录上，让设置页**无需用户点刷新**就能看到新模型。
 *
 * 与 fetchBuiltinProviderCatalog（实时网络）的区别：这是纯函数，不发请求。合并规则
 * 共用 mergeBuiltinsAndRemote，因此两条路径给出的目录同构。
 *
 * 缓存为空时原样返回静态目录 —— 冷启动首探尚未完成就是这个状态。
 * catalogStale = 最近一次探测失败、模型列表来自上次成功结果。
 */
export function mergeCachedRemoteCatalog(
  builtin: PiAiProviderInfo[],
  cached: Record<string, BuiltinRemoteCatalogEntry>,
): Array<PiAiProviderInfo & { catalogStale?: boolean; catalogFetchedAt?: string }> {
  return builtin.map((provider) => {
    const entry = cached[provider.id];
    if (!entry) return { ...provider };

    const { merged, builtinById } = mergeBuiltinsAndRemote(provider.models ?? [], entry.models);

    // 远端独有条目要把 ProviderModelInfo 投影回设置页的 PiAiModelInfo 形状：
    //   · api 取该 Provider 静态模型的 api（refreshable 的 Provider 全模型同族，
    //     混 API 的 Provider 拿不到缓存，所以这里一定是单一协议）；
    //   · 能力字段缺省用 0 表示"未声明"，预算解析时由 model-context 注册表兜底
    //     （见 resolveModelContextConfig），不在这里编造窗口。
    const api = provider.models[0]?.api ?? 'openai-completions';
    const project = (model: ProviderModelInfo): PiAiModelInfo => ({
      id: model.id,
      name: model.id,
      api,
      contextWindow: model.contextWindow ?? 0,
      maxOutputTokens: model.maxOutputTokens ?? 0,
      // reasoning 刻意保持 false：远端不声明 thinkingLevelMap，编造推理能力或思考
      // 档次会让设置页给出无法被端点识别的参数。运行时走 getPiAiDiscoveredModel
      // 合成（那里用同族模板的 compat），两边不冲突。
      reasoning: false,
      thinkingLevels: model.thinkingLevels ?? ['off'],
      input: model.vision ? ['text', 'image'] : ['text'],
    });

    return {
      ...provider,
      models: merged.map((model) => builtinById.get(model.id) ?? project(model)),
      ...(entry.stale ? { catalogStale: true } : {}),
      ...(entry.fetchedAt ? { catalogFetchedAt: entry.fetchedAt } : {}),
    };
  });
}
