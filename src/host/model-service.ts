// 模块: ModelService —— RunManager 的模型/Provider 组合服务。
//
// 为什么单独存在：RunManager 里「产品层状态管理」与「模型配置解析」是两类职责。
// 模型配置解析有真实业务规则（原子元组、视觉能力推断、Run 快照 fail-closed），
// 独立成服务后规则有唯一 owner，RunManager 只保留一行委托。
//
// 边界：只依赖 RunStore（凭证与 Provider 元数据唯一来源），不反向依赖 RunManager。

import type { ModelConfig } from '../llm/llm.js';
import type {
  CreateModelProviderInput,
  ModelProviderView,
  RunStore,
  UpdateModelProviderInput,
} from './persistence/store.js';
import { getPiAiProviderModel } from './pi-ai-providers.js';

export interface ModelServiceDeps {
  store: RunStore;
}

export class ModelService {
  private readonly store: RunStore;

  constructor(deps: ModelServiceDeps) {
    this.store = deps.store;
  }

  listModelProviders() {
    return this.store.listModelProviders();
  }

  getModelProvider(id: string) {
    return this.store.getModelProvider(id);
  }

  // 密钥只在服务端使用（如代拉 /models 目录），绝不进入 API 响应
  getModelProviderSecret(id: string, model?: string) {
    return this.store.getModelProviderSecret(id, model);
  }

  addModelProvider(input: CreateModelProviderInput) {
    return this.store.addModelProvider(input);
  }

  updateModelProvider(id: string, input: UpdateModelProviderInput) {
    return this.store.updateModelProvider(id, input);
  }

  deleteModelProvider(id: string) {
    return this.store.deleteModelProvider(id);
  }

  getDefaultProviderId(): string {
    return this.store.getDefaultProviderId();
  }

  getDefaultModelId(): string {
    return this.store.getDefaultModelId();
  }

  setDefaultModel(providerId: string, modelId?: string): { providerId: string; modelId: string } {
    return this.store.setDefaultModel(providerId, modelId);
  }

  recordModelProbe(id: string, result: { status: 'available' | 'error'; error?: string }) {
    return this.store.recordModelProbe(id, result);
  }

  // Host 启动时一次性导入 .env 环境模型配置（设置中已有导入标记则不重复）
  importEnvModelProvider(input: {
    baseUrl: string;
    apiKey: string;
    model: string;
  }): { providerId: string; modelId: string } | null {
    return this.store.importEnvFallback(input);
  }

  // 视觉能力解析：设置页显式勾选优先；pi-ai 内置 Provider 再兜底查注册表
  // （注册表的 model.input 是权威能力声明）；自定义 OpenAI 兼容端点无法从
  // 协议探测，缺省 false —— 由用户按供应商文档在设置页勾选。
  resolveVision(piProviderId: string | undefined, model: string, explicit?: boolean): boolean {
    // 三态：显式 true/false 均优先（false 可关掉注册表声明的视觉），
    // 缺省才走 pi-ai 注册表推断（非 pi-ai 路径无注册表 → false）。
    if (explicit === true) return true;
    if (explicit === false) return false;
    if (piProviderId) {
      return getPiAiProviderModel(piProviderId, model)?.model.input.includes('image') ?? false;
    }
    return false;
  }

  // 原子解析模型配置：要么返回完整可用的 {providerId, baseUrl, apiKey, model}，
  // 要么返回 undefined（调用方整组回退环境配置）。绝不返回残缺元组：
  // 默认 Provider 只有配置了密钥且有模型时才参与选中，否则跳过（而不是拿着空密钥命中）。
  resolveModelConfig(
    requestedProviderId?: string,
    requestedModelId?: string,
  ): ModelConfig | undefined {
    if (requestedProviderId !== undefined || requestedModelId !== undefined) {
      if (!requestedProviderId || !requestedModelId) {
        throw new Error('providerId and model must be provided together');
      }
      const provider = this.store.getModelProvider(requestedProviderId);
      if (!provider?.hasApiKey) {
        throw new Error(`Provider ${requestedProviderId} is not configured`);
      }
      if (!provider.models.includes(requestedModelId)) {
        throw new Error(`Model ${requestedModelId} is not in provider catalog`);
      }
      const selected = this.store.getModelProviderSecret(requestedProviderId, requestedModelId);
      if (!selected?.apiKey || !selected.baseUrl) {
        throw new Error(`Provider ${requestedProviderId} is not available`);
      }
      return {
        providerId: requestedProviderId,
        ...(selected.piProviderId ? { piProviderId: selected.piProviderId } : {}),
        ...(this.resolveVision(selected.piProviderId, requestedModelId, selected.vision)
          ? { vision: true }
          : {}),
        baseUrl: selected.baseUrl,
        apiKey: selected.apiKey,
        model: requestedModelId,
        ...(selected.contextWindow !== undefined ? { contextWindow: selected.contextWindow } : {}),
        ...(selected.maxOutputTokens !== undefined
          ? { maxOutputTokens: selected.maxOutputTokens }
          : {}),
        ...(selected.thinkingLevel !== undefined ? { thinkingLevel: selected.thinkingLevel } : {}),
      };
    }

    const providers = this.store.listModelProviders();
    const usable = (p: ModelProviderView): boolean => p.hasApiKey && p.models.length > 0;
    const defaultId = this.store.getDefaultProviderId();
    const byDefault = providers.find((p) => p.id === defaultId && usable(p));
    const configured = byDefault ?? providers.find(usable);
    if (!configured) return undefined;
    const defaultModelId = this.store.getDefaultModelId();
    const model =
      defaultId === configured.id && defaultModelId && configured.models.includes(defaultModelId)
        ? defaultModelId
        : configured.models[0];
    if (!model) return undefined;
    // 凭证按最终选定的模型读取（附带设置页按模型配置的能力覆盖）
    const full = this.store.getModelProviderSecret(configured.id, model);
    if (!full?.apiKey || !full.baseUrl) return undefined;
    return {
      providerId: configured.id,
      ...(full.piProviderId ? { piProviderId: full.piProviderId } : {}),
      ...(this.resolveVision(full.piProviderId, model, full.vision) ? { vision: true } : {}),
      baseUrl: full.baseUrl,
      apiKey: full.apiKey,
      model,
      ...(full.contextWindow !== undefined ? { contextWindow: full.contextWindow } : {}),
      ...(full.maxOutputTokens !== undefined ? { maxOutputTokens: full.maxOutputTokens } : {}),
      ...(full.thinkingLevel !== undefined ? { thinkingLevel: full.thinkingLevel } : {}),
    };
  }

  // Run 快照绑定了 provider/model 时，必须仍能组成完整元组（密钥可能事后被清除）；
  // 组不出来就 fail-closed 抛错，由 startAgent 落为 failed Run。
  // 安全语义：Resume 必须使用当前完整配置（当前 baseUrl + 当前 Secret），
  // 禁止历史 baseUrl 与当前 Secret 混用；模型也必须在当前 provider 目录中。
  modelConfigForRun(run: {
    providerId?: string;
    model?: string;
    sessionId: string;
  }): ModelConfig | undefined {
    if (run.providerId && run.model) {
      const secret = this.store.getModelProviderSecret(run.providerId, run.model);
      const provider = this.store.getModelProvider(run.providerId);
      if (!secret?.apiKey || !provider) {
        throw new Error(`Provider ${run.providerId} is not available for run`);
      }
      if (!provider.models.includes(run.model)) {
        throw new Error(`Model ${run.model} is no longer in provider ${run.providerId} catalog`);
      }
      return {
        providerId: run.providerId,
        ...(secret.piProviderId ? { piProviderId: secret.piProviderId } : {}),
        sessionId: run.sessionId,
        ...(this.resolveVision(secret.piProviderId, run.model, secret.vision)
          ? { vision: true }
          : {}),
        baseUrl: secret.baseUrl,
        apiKey: secret.apiKey,
        model: run.model,
        // 设置页按模型配置的能力覆盖（缺省走注册表/fallback）
        ...(secret.contextWindow !== undefined ? { contextWindow: secret.contextWindow } : {}),
        ...(secret.maxOutputTokens !== undefined
          ? { maxOutputTokens: secret.maxOutputTokens }
          : {}),
        ...(secret.thinkingLevel !== undefined ? { thinkingLevel: secret.thinkingLevel } : {}),
      };
    }
    return this.resolveModelConfig();
  }
}
