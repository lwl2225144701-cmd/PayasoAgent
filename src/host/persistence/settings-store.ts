import type { DatabaseSync } from 'node:sqlite';
import { getPiAiProviderBaseUrl, listPiAiProviderCatalog } from '../pi-ai-providers.js';
import { canonicalizeProviderBaseUrl } from '../provider-url.js';
import { createSecretStore, providerSecretKey, type SecretStore } from '../secrets/secret-store.js';

export type ModelProviderKind = 'builtin' | 'custom';
export type ModelProviderProbeStatus = 'available' | 'error';

// 模型级能力元数据：用户按模型供应商文档填写的上下文窗口/最大输出/视觉支持。
// 缺省字段走"内置注册表 → fallback 256K"链路；预算解析优先级见 model-context.ts。
export interface ModelCapabilitySetting {
  contextWindow?: number;
  maxOutputTokens?: number;
  // 该模型是否支持图片输入（视觉）。自定义 OpenAI 兼容端点无法从协议探测，
  // 由用户按供应商文档勾选；pi-ai 内置模型另走注册表自动识别。
  vision?: boolean;
}

// Provider metadata（SQLite 持久化）。raw apiKey 不在此结构中：
// 凭证唯一存放在 SecretStore（macOS Keychain），以 providerSecretKey(id) 引用。
export interface StoredModelProvider {
  id: string;
  kind: ModelProviderKind;
  name: string;
  baseUrl: string;
  // 若存在，则该记录使用 pi-ai 的内置 Provider 工厂/协议分发。
  // 这里保存的是公开的 Provider id，不保存任何认证信息。
  piProviderId?: string;
  // 凭证存在性元数据（UI / 解析判定的唯一依据）；真实密钥经 SecretStore 读取
  hasApiKey: boolean;
  models: string[];
  // 按模型 ID 的能力覆盖（可选；预算解析时优先于内置注册表）
  modelCapabilities?: Record<string, ModelCapabilitySetting>;
  // /models 最近一次检测结果；不保存响应原文或凭证
  lastProbeAt?: string;
  lastProbeStatus?: ModelProviderProbeStatus;
  lastProbeError?: string;
}

export interface ModelProviderView {
  id: string;
  kind: ModelProviderKind;
  name: string;
  baseUrl: string;
  piProviderId?: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  models: string[];
  modelCapabilities?: Record<string, ModelCapabilitySetting>;
  lastCheckedAt?: string;
  probeError?: string;
  status: 'unconfigured' | 'configured' | 'available' | 'error' | 'checking';
}

export interface CreateModelProviderInput {
  name: string;
  baseUrl?: string;
  piProviderId?: string;
  // 提供即设置凭证（SecretStore）；缺省/空 = 不设置。响应绝不回传 key（只回 hasApiKey）。
  apiKey?: string | null;
  models: string[];
  modelCapabilities?: Record<string, ModelCapabilitySetting>;
}

// API Key 编辑三态（明确、可测试）：
//   undefined  → 保持原 Secret 不变
//   null       → 删除 Secret（hasApiKey=false）
//   非空字符串 → 替换 Secret
//   空字符串   → 拒绝（歧义输入，fail-fast）
export interface UpdateModelProviderInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string | null;
  models?: string[];
  // 提供即整表替换（先校验引用的模型都在目录内）
  modelCapabilities?: Record<string, ModelCapabilitySetting>;
}

// 默认模型 = provider + model 成对选择，二者必须一起持久化、一起校验
export interface DefaultModelSelection {
  providerId: string;
  modelId: string;
}

// settings 表 key='app' 的完整 blob。读写必须整块进行：
// 任何一次局部重写（例如只写 models）都会把其余字段静默抹掉。
// 注意：这里只有 metadata —— raw apiKey 永远不进入这个 blob。
interface AppSettingsBlob {
  models: StoredModelProvider[];
  defaultProviderId: string;
  defaultModelId: string;
  // .env 环境模型配置是否已导入过设置（一次性导入标记，删除导入的 Provider 也不会再导）
  envImported: boolean;
}

// legacy（< v1.6）blob 中的 provider 形状：含明文 apiKey，构造器迁移后剥离
interface LegacyStoredModelProvider extends StoredModelProvider {
  apiKey?: string;
}

// 内置模板已移除（产品决策：仅保留"添加自定义提供方"）。
// 新库不再有任何预置 Provider；默认选择为空，由用户创建后自行设定。
const DEFAULT_MODELS: StoredModelProvider[] = [];

// 旧内置模板 id 白名单：用于迁移识别历史 builtin 记录。
// 早期 schema 可能缺少 kind 字段（kind 为 undefined），故除 kind==="builtin" 外，
// 也按 id 命中这些固定 id 来兜底清理，避免"隐藏的内置"继续占用名字/出现在列表。
const BUILTIN_PROVIDER_IDS = new Set(['deepseek-chat', 'openai-gpt4o', 'stepfun-step']);

// 从 baseUrl 推导 Provider 的展示名：环境导入创建的 Provider 不用模型名命名，
// 否则目录扩充后（如 MiniMax-M3 + 8 个模型）每个模型都挂着同一个模型名。
const KNOWN_PROVIDER_NAMES: Record<string, string> = {
  'api.minimaxi.com': 'MiniMax',
  'api.openai.com': 'OpenAI',
  'api.deepseek.com': 'DeepSeek',
  'api.stepfun.com': 'StepFun',
  'api.moonshot.cn': 'Moonshot',
  'dashscope.aliyuncs.com': 'Qwen',
  'api.zhipuai.cn': 'Zhipu',
  'api.groq.com': 'Groq',
  'api.anthropic.com': 'Anthropic',
};

function deriveProviderName(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (KNOWN_PROVIDER_NAMES[host]) return KNOWN_PROVIDER_NAMES[host];
    const main = host.split('.').find((seg) => !seg.startsWith('api')) ?? host;
    return main.charAt(0).toUpperCase() + main.slice(1);
  } catch {
    return 'Custom Provider';
  }
}

function defaultSettings(): AppSettingsBlob {
  return {
    models: JSON.parse(JSON.stringify(DEFAULT_MODELS)) as StoredModelProvider[],
    defaultProviderId: DEFAULT_MODELS[0]?.id ?? '',
    defaultModelId: DEFAULT_MODELS[0]?.models[0] ?? '',
    envImported: false,
  };
}

export class SettingsStore {
  private db: DatabaseSync;
  private readonly secrets: SecretStore;

  constructor(db: DatabaseSync, secrets: SecretStore = createSecretStore()) {
    this.db = db;
    this.secrets = secrets;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      this.writeSettings(defaultSettings());
    } else {
      // 旧库迁移：readSettings 会补齐缺失字段（如 defaultModelId / hasApiKey），回写完成迁移
      const settings = this.readSettings();
      this.migrateLegacyPlaintextKeys(settings);
      this.writeSettings(settings);
    }
  }

  private readSettings(): AppSettingsBlob {
    const fallback = defaultSettings();
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as
      | { value: string }
      | undefined;
    if (!row) return fallback;
    let settings: AppSettingsBlob;
    try {
      const parsed = JSON.parse(row.value) as Partial<AppSettingsBlob>;
      settings = {
        models:
          Array.isArray(parsed.models) && parsed.models.length > 0
            ? parsed.models
            : fallback.models,
        defaultProviderId:
          typeof parsed.defaultProviderId === 'string' ? parsed.defaultProviderId : '',
        defaultModelId: typeof parsed.defaultModelId === 'string' ? parsed.defaultModelId : '',
        envImported: parsed.envImported === true,
      };
    } catch (err) {
      console.error(
        `[SettingsStore] settings blob is corrupted, falling back to defaults: ${(err as Error).message}`,
      );
      settings = fallback;
    }
    // 内置模板概念移除（仅保留自定义提供方）：一次性清理历史 builtin 记录，
    // 连同其 Secret 一并删除，避免"隐藏的内置"继续占用名字或出现在任何视图。
    // 兼容旧 schema：kind 丢失（undefined）的内置模板按 id 白名单兜底识别。
    const isLegacyBuiltin = (p: StoredModelProvider): boolean =>
      p.kind === 'builtin' || (p.kind == null && BUILTIN_PROVIDER_IDS.has(p.id));
    const builtins = settings.models.filter(isLegacyBuiltin);
    if (builtins.length > 0) {
      for (const b of builtins) {
        try {
          this.secrets.delete(providerSecretKey(b.id));
        } catch {
          /* best-effort */
        }
      }
      settings.models = settings.models.filter((p) => !isLegacyBuiltin(p));
      if (
        settings.defaultProviderId &&
        !settings.models.some((m) => m.id === settings.defaultProviderId)
      ) {
        settings.defaultProviderId = '';
        settings.defaultModelId = '';
      }
      // 持久化回写，避免下次启动再次重复清理（幂等但保持库干净）
      this.writeSettings(settings);
    }
    // 旧库迁移 / 目录变化后的安全网：默认模型必须仍在默认 provider 的模型目录里
    const provider = settings.models.find((m) => m.id === settings.defaultProviderId);
    if (!provider?.models.includes(settings.defaultModelId)) {
      settings.defaultModelId = provider?.models[0] ?? '';
    }
    // 旧库迁移：早期环境导入曾用模型名命名自定义 Provider（name === models[0]），
    // 目录扩充后（models.length > 1）名字会与模型混在一起，按 baseUrl 重命名为通用名。
    for (const p of settings.models) {
      if (p.kind === 'custom' && p.models.length > 1 && p.name === p.models[0]) {
        p.name = deriveProviderName(p.baseUrl);
      }
    }
    return settings;
  }

  private writeSettings(settings: AppSettingsBlob): void {
    // UPSERT：settings 行可能尚不存在（首次初始化），仅 UPDATE 会静默写入 0 行
    this.db
      .prepare(`
      INSERT INTO settings (key, value) VALUES ('app', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
      .run(JSON.stringify(settings));
  }

  // v1.6 SecretStore 迁移：legacy blob 中的明文 apiKey → SecretStore，成功后才从
  // metadata 剥离。顺序不可颠倒（先删 SQLite 再写 Keychain 失败 = 凭证永久丢失）。
  // 任一写入失败即抛出：blob 保持原样（凭证不丢），Host 以明确错误启动失败，
  // 绝不静默回退明文。迁移天然幂等：剥离完成后再次启动为 no-op。
  private migrateLegacyPlaintextKeys(settings: AppSettingsBlob): void {
    const legacy = settings.models.filter(
      (m): m is LegacyStoredModelProvider =>
        typeof (m as LegacyStoredModelProvider).apiKey === 'string',
    );
    if (legacy.length === 0) return;
    for (const model of legacy) {
      if (model.apiKey) {
        this.secrets.set(providerSecretKey(model.id), model.apiKey);
      }
    }
    for (const model of settings.models) {
      const raw = model as LegacyStoredModelProvider;
      if (typeof raw.apiKey === 'string') {
        raw.hasApiKey = raw.apiKey.length > 0;
        delete raw.apiKey;
      }
    }
  }

  public getAllModels(): StoredModelProvider[] {
    return this.readSettings().models;
  }

  private normalizeModels(models: string[]): string[] {
    const normalized = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
    if (normalized.length > 50) {
      throw new Error('models cannot exceed 50');
    }
    return normalized;
  }

  // 模型能力元数据校验：引用的模型必须在目录内；数值必须为正整数。
  // 只保留有字段的条目；空表返回 undefined（不写无意义的空对象）。
  private normalizeModelCapabilities(
    input: Record<string, ModelCapabilitySetting> | undefined,
    models: string[],
  ): Record<string, ModelCapabilitySetting> | undefined {
    if (input === undefined) return undefined;
    const result: Record<string, ModelCapabilitySetting> = {};
    for (const [modelId, capability] of Object.entries(input)) {
      if (!models.includes(modelId)) {
        throw new Error(`modelCapabilities references model outside catalog: ${modelId}`);
      }
      const entry: ModelCapabilitySetting = {};
      if (capability.contextWindow !== undefined) {
        if (!Number.isSafeInteger(capability.contextWindow) || capability.contextWindow <= 0) {
          throw new Error('contextWindow must be a positive integer');
        }
        entry.contextWindow = capability.contextWindow;
      }
      if (capability.maxOutputTokens !== undefined) {
        if (!Number.isSafeInteger(capability.maxOutputTokens) || capability.maxOutputTokens <= 0) {
          throw new Error('maxOutputTokens must be a positive integer');
        }
        entry.maxOutputTokens = capability.maxOutputTokens;
      }
      if (capability.vision !== undefined) {
        if (typeof capability.vision !== 'boolean') {
          throw new Error('vision must be a boolean');
        }
        entry.vision = capability.vision;
      }
      if (Object.keys(entry).length > 0) result[modelId] = entry;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  private validateUrl(url: string): void {
    // 统一走 provider-url 校验模块：协议白名单、凭证拒绝、HTTP 仅限 loopback、空 hostname 拒绝
    try {
      canonicalizeProviderBaseUrl(url, { allowLoopbackHttp: false });
    } catch (err) {
      throw new Error((err as Error).message || 'baseUrl must be a valid HTTP/HTTPS URL');
    }
  }

  private toView(provider: StoredModelProvider): ModelProviderView {
    const hasApiKey = Boolean(provider.hasApiKey);
    const status: ModelProviderView['status'] = !hasApiKey
      ? 'unconfigured'
      : provider.lastProbeStatus === 'available'
        ? 'available'
        : provider.lastProbeStatus === 'error'
          ? 'error'
          : 'configured';
    return {
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      ...(provider.piProviderId ? { piProviderId: provider.piProviderId } : {}),
      // 掩码不再来自真实密钥（Host 不为展示读取它），只反映凭证存在性
      apiKeyMasked: hasApiKey ? '********' : '****',
      hasApiKey,
      models: provider.models,
      ...(provider.modelCapabilities ? { modelCapabilities: provider.modelCapabilities } : {}),
      ...(provider.lastProbeAt ? { lastCheckedAt: provider.lastProbeAt } : {}),
      ...(provider.lastProbeError ? { probeError: provider.lastProbeError } : {}),
      status,
    };
  }

  // 列表暴露所有自定义 Provider（内置模板已移除，无隐藏项）。
  listViews(): ModelProviderView[] {
    return this.getAllModels().map((p) => this.toView(p));
  }

  getDefaultProviderId(): string {
    return this.readSettings().defaultProviderId;
  }

  getDefaultModelId(): string {
    return this.readSettings().defaultModelId;
  }

  // 设置默认模型（provider + model 成对持久化）。校验：provider 必须存在、
  // 已配置凭证、至少有一个模型；显式传入的 modelId 必须在目录内。
  setDefaultModel(providerId: string, modelId?: string): DefaultModelSelection {
    const settings = this.readSettings();
    const provider = settings.models.find((m) => m.id === providerId);
    if (!provider) throw new Error('Provider not found');
    if (!provider.hasApiKey) throw new Error('Provider has no API key configured');
    if (provider.models.length === 0) throw new Error('Provider has no models');
    let resolvedModelId: string;
    if (modelId !== undefined && modelId !== '') {
      if (!provider.models.includes(modelId)) {
        throw new Error(`Model "${modelId}" is not in provider catalog`);
      }
      resolvedModelId = modelId;
    } else {
      resolvedModelId = provider.models[0];
    }
    this.writeSettings({
      ...settings,
      defaultProviderId: provider.id,
      defaultModelId: resolvedModelId,
    });
    return { providerId: provider.id, modelId: resolvedModelId };
  }

  // 一次性把 .env 的环境模型配置导入设置：仅当从未导入过时执行（envImported 标记）。
  // baseUrl 与现有 Provider 一致时填入该 Provider（模型不在目录则插到最前），
  // 否则新建以 baseUrl 推导命名的自定义 Provider；导入后即设为默认。
  // 凭证路径：.env → SecretStore → metadata(hasApiKey)，key 不写 SQLite。
  importEnvFallback(input: {
    baseUrl: string;
    apiKey: string;
    model: string;
  }): DefaultModelSelection | null {
    const settings = this.readSettings();
    if (settings.envImported) return null;
    settings.envImported = true;

    const baseUrl = input.baseUrl.trim();
    const apiKey = input.apiKey.trim();
    const model = input.model.trim();
    if (!baseUrl || !apiKey || !model) {
      this.writeSettings(settings);
      return null;
    }

    const existing = settings.models.find((m) => m.baseUrl.toLowerCase() === baseUrl.toLowerCase());
    if (existing) {
      this.secrets.set(providerSecretKey(existing.id), apiKey);
      existing.hasApiKey = true;
      if (!existing.models.includes(model)) {
        existing.models = [model, ...existing.models];
      }
      settings.defaultProviderId = existing.id;
      settings.defaultModelId = model;
    } else {
      const provider: StoredModelProvider = {
        id: crypto.randomUUID(),
        kind: 'custom',
        // 用从 baseUrl 推导的通用名（如 api.minimaxi.com → MiniMax），
        // 避免 provider 名等于模型名、目录扩充后每项重复标注。
        name: deriveProviderName(baseUrl),
        baseUrl,
        hasApiKey: true,
        models: [model],
      };
      this.secrets.set(providerSecretKey(provider.id), apiKey);
      settings.models.push(provider);
      settings.defaultProviderId = provider.id;
      settings.defaultModelId = model;
    }
    this.writeSettings(settings);
    return { providerId: settings.defaultProviderId, modelId: settings.defaultModelId };
  }

  // 凭证读取路径（RunManager / available-models 共用）：metadata + SecretStore 合成。
  // model 提供时附带该模型的能力覆盖（contextWindow/maxOutputTokens，来自设置页配置）。
  // provider 不存在、未配置凭证、或 SecretStore 中已不存在 → null（调用方 fail-closed）。
  getProviderCredentials(
    id: string,
    model?: string,
  ): {
    apiKey: string;
    baseUrl: string;
    models: string[];
    piProviderId?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    vision?: boolean;
  } | null {
    const provider = this.getAllModels().find((m) => m.id === id);
    if (!provider?.hasApiKey) return null;
    const apiKey = this.secrets.get(providerSecretKey(id));
    if (!apiKey) return null;
    const capability = model ? provider.modelCapabilities?.[model] : undefined;
    const baseUrl = provider.piProviderId
      ? (getPiAiProviderBaseUrl(provider.piProviderId, model) ?? provider.baseUrl)
      : provider.baseUrl;
    return {
      apiKey,
      baseUrl,
      models: provider.models,
      ...(provider.piProviderId ? { piProviderId: provider.piProviderId } : {}),
      ...(capability?.contextWindow !== undefined
        ? { contextWindow: capability.contextWindow }
        : {}),
      ...(capability?.maxOutputTokens !== undefined
        ? { maxOutputTokens: capability.maxOutputTokens }
        : {}),
      ...(capability?.vision !== undefined ? { vision: capability.vision } : {}),
    };
  }

  addModel(input: CreateModelProviderInput): ModelProviderView {
    const name = input.name.trim();
    const piProviderId = input.piProviderId?.trim();
    const apiKey = (input.apiKey ?? '').trim();
    const models = this.normalizeModels(input.models);
    const modelCapabilities = this.normalizeModelCapabilities(input.modelCapabilities, models);

    const piProvider = piProviderId
      ? listPiAiProviderCatalog().find((provider) => provider.id === piProviderId)
      : undefined;
    if (piProviderId && !piProvider) throw new Error('内置提供方不存在');
    if (piProvider) {
      const supportedModels = new Set(piProvider.models.map((model) => model.id));
      const unsupportedModel = models.find((model) => !supportedModels.has(model));
      if (unsupportedModel) {
        throw new Error(`内置提供方不支持模型: ${unsupportedModel}`);
      }
    }
    const piModelId = piProvider?.models.find((model) => models.includes(model.id))?.id;
    const baseUrl = piProviderId
      ? (getPiAiProviderBaseUrl(piProviderId, piModelId) ?? '')
      : (input.baseUrl ?? '').trim();

    // 1. 标准化输入 + 基础校验
    if (!name) throw new Error('name is required');
    if (!piProviderId && !baseUrl) throw new Error('baseUrl is required');
    if (input.piProviderId !== undefined && !piProviderId) {
      throw new Error('piProviderId must be non-empty when provided');
    }
    if (!piProviderId) this.validateUrl(baseUrl);
    if (models.length === 0) throw new Error('models is required');

    // 2. 读取 settings（校验前快照，用于后续判断）
    const settings = this.readSettings();

    // 3. 通用创建：业务校验必须在 Secret 写入之前完成
    const existing = settings.models.find(
      (m) =>
        m.name.toLowerCase() === name.toLowerCase() ||
        m.baseUrl.toLowerCase() === baseUrl.toLowerCase(),
    );
    if (existing) {
      throw new Error(
        `Provider with same name or baseUrl already exists: ${existing.name} (${existing.baseUrl})`,
      );
    }

    const id = crypto.randomUUID();
    const provider: StoredModelProvider = {
      id,
      kind: 'custom',
      name,
      baseUrl,
      ...(piProviderId ? { piProviderId } : {}),
      hasApiKey: Boolean(apiKey),
      models,
      ...(modelCapabilities ? { modelCapabilities } : {}),
    };

    // 4. 所有业务校验通过后，再写入 Secret
    let secretWritten = false;
    const secretKey = providerSecretKey(id);
    try {
      if (apiKey) {
        this.secrets.set(secretKey, apiKey);
        secretWritten = true;
      }
      settings.models.push(provider);
      this.writeSettings(settings);
      return this.toView(provider);
    } catch (err) {
      // 补偿：删除本次新增 Secret，防止孤儿凭证
      if (secretWritten) {
        try {
          this.secrets.delete(secretKey);
        } catch {
          /* best-effort compensation */
        }
      }
      throw err;
    }
  }

  updateModel(id: string, input: UpdateModelProviderInput): ModelProviderView | null {
    const settings = this.readSettings();
    const current = settings.models;
    const idx = current.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    const piProvider = current[idx].piProviderId
      ? listPiAiProviderCatalog().find((provider) => provider.id === current[idx].piProviderId)
      : undefined;
    if (current[idx].piProviderId && !piProvider) throw new Error('内置提供方不存在');

    // 保存旧 Secret 状态，以便 writeSettings 失败时恢复（补偿事务）。
    // 旧版本可能留下 hasApiKey=true 但 SecretStore 中已没有密钥的元数据；
    // 这种情况可安全自愈为未配置，允许用户重新输入密钥或仅修改其他信息。
    const oldHasApiKey = current[idx].hasApiKey;
    let oldApiKey: string | null = null;
    if (oldHasApiKey) {
      oldApiKey = this.secrets.get(providerSecretKey(id));
      if (oldApiKey === null) current[idx].hasApiKey = false;
    }
    const oldSecretPresent = oldApiKey !== null;

    // 先做所有业务校验，再修改 Secret
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new Error('name is required');
      if (current.some((m) => m.id !== id && m.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('Provider with same name already exists');
      }
      current[idx].name = name;
    }

    // 内置 Provider 的地址由 pi-ai 的 Provider/Model 目录决定；兼容旧前端传来的空地址，
    // 但不允许用户覆盖内置运行时地址。自定义 Provider 仍必须校验并保存 baseUrl。
    if (input.baseUrl !== undefined && !current[idx].piProviderId) {
      const baseUrl = input.baseUrl.trim();
      if (!baseUrl) throw new Error('baseUrl is required');
      this.validateUrl(baseUrl);
      if (current.some((m) => m.id !== id && m.baseUrl.toLowerCase() === baseUrl.toLowerCase())) {
        throw new Error('Provider with same baseUrl already exists');
      }
      current[idx].baseUrl = baseUrl;
    }

    if (input.models !== undefined) {
      const models = this.normalizeModels(input.models);
      if (models.length === 0) throw new Error('models is required');
      if (piProvider) {
        const supportedModels = new Set(piProvider.models.map((model) => model.id));
        const unsupportedModel = models.find((model) => !supportedModels.has(model));
        if (unsupportedModel) {
          throw new Error(`内置提供方不支持模型: ${unsupportedModel}`);
        }
      }
      current[idx].models = models;
      // 目录收缩时清掉已移除模型的能力覆盖
      if (current[idx].modelCapabilities) {
        const pruned: Record<string, ModelCapabilitySetting> = {};
        for (const [modelId, capability] of Object.entries(current[idx].modelCapabilities)) {
          if (models.includes(modelId)) pruned[modelId] = capability;
        }
        if (Object.keys(pruned).length > 0) current[idx].modelCapabilities = pruned;
        else delete current[idx].modelCapabilities;
      }
    }

    // 地址、模型目录或密钥变化后，旧的 /models 检测结果不能继续沿用。
    if (input.baseUrl !== undefined || input.apiKey !== undefined) {
      delete current[idx].lastProbeAt;
      delete current[idx].lastProbeStatus;
      delete current[idx].lastProbeError;
    }

    // 模型能力覆盖：提供即整表替换（引用模型必须都在最终目录内）
    if (input.modelCapabilities !== undefined) {
      const validated = this.normalizeModelCapabilities(
        input.modelCapabilities,
        current[idx].models,
      );
      if (validated) current[idx].modelCapabilities = validated;
      else delete current[idx].modelCapabilities;
    }

    // API Key 三态：undefined=保持 / null=删除 Secret / 非空=替换 Secret / ""=拒绝。
    // Secret 操作在 metadata 持久化之前完成；若 metadata 持久化失败，则回滚 Secret 到旧状态。
    let secretMutated = false;
    let newSecretWritten = false;
    if (input.apiKey !== undefined) {
      if (input.apiKey === null) {
        this.secrets.delete(providerSecretKey(id));
        current[idx].hasApiKey = false;
        secretMutated = true;
      } else {
        const apiKey = input.apiKey.trim();
        if (!apiKey) {
          throw new Error('apiKey must be non-empty or null');
        }
        this.secrets.set(providerSecretKey(id), apiKey);
        current[idx].hasApiKey = true;
        secretMutated = true;
        newSecretWritten = true;
      }
    }

    // 默认选择一致性：在 API Key 状态更新后再检查（避免旧值导致的悬挂默认引用；
    // 例如清除默认 Provider 的凭证时 hasApiKey 刚变为 false，必须立即清空默认引用）
    if (settings.defaultProviderId === id) {
      if (!current[idx].hasApiKey) {
        settings.defaultProviderId = '';
        settings.defaultModelId = '';
      } else if (!current[idx].models.includes(settings.defaultModelId)) {
        settings.defaultModelId = current[idx].models[0] ?? '';
      }
    }

    // 持久化 metadata
    try {
      this.writeSettings(settings);
    } catch (err) {
      // 补偿：恢复旧 Secret 状态
      if (secretMutated) {
        if (oldSecretPresent && oldApiKey !== null) {
          try {
            this.secrets.set(providerSecretKey(id), oldApiKey);
          } catch (secretErr) {
            // 补偿失败：返回统一的脱敏一致性错误
            console.error(
              `[SettingsStore] updateModel recovery failed for ${id}: ${(secretErr as Error).message}`,
            );
            throw new Error('settings_consistency_recovery_failed');
          }
        } else if (newSecretWritten) {
          // 原来没有可恢复的 Secret，本次新增了 Secret → 删除本次新增
          try {
            this.secrets.delete(providerSecretKey(id));
          } catch (secretErr) {
            console.error(
              `[SettingsStore] updateModel recovery delete failed for ${id}: ${(secretErr as Error).message}`,
            );
            throw new Error('settings_consistency_recovery_failed');
          }
        }
      }
      throw err;
    }
    return this.toView(current[idx]);
  }

  deleteModel(id: string): boolean {
    const settings = this.readSettings();
    const target = settings.models.find((m) => m.id === id);
    if (!target) return false;

    const next = settings.models.filter((m) => m.id !== id);
    if (next.length === settings.models.length) return false;

    // 读取旧 Secret 状态，以便 metadata 删除失败时恢复
    const oldHasApiKey = target.hasApiKey;
    let oldSecretValue: string | null = null;
    if (oldHasApiKey) {
      oldSecretValue = this.secrets.get(providerSecretKey(id));
    }

    // 删除资格校验通过后，先删 Secret
    let secretDeleted = false;
    try {
      if (oldHasApiKey) {
        this.secrets.delete(providerSecretKey(id));
      }
      secretDeleted = true;
    } catch (err) {
      // Secret 删除失败则中止，避免前端收到 deleted=true 但 Secret 仍可被使用的半完成状态
      console.error(
        `[SettingsStore] provider secret delete failed for ${id}: ${(err as Error).message}`,
      );
      throw new Error('Failed to delete provider credentials');
    }

    // 删除的是默认 provider → 默认选择一并清空（与 metadata 在同一次写入中完成）
    if (settings.defaultProviderId === id) {
      settings.defaultProviderId = '';
      settings.defaultModelId = '';
    }
    settings.models = next;

    try {
      this.writeSettings(settings);
    } catch (err) {
      // metadata 删除失败：尝试恢复 Secret
      if (secretDeleted && oldHasApiKey) {
        if (oldSecretValue !== null) {
          try {
            this.secrets.set(providerSecretKey(id), oldSecretValue);
          } catch (secretErr) {
            console.error(
              `[SettingsStore] deleteModel recovery failed for ${id}: ${(secretErr as Error).message}`,
            );
            throw new Error('settings_consistency_recovery_failed');
          }
        } else {
          // 原来有 Secret 标记但读取不到值 → 不恢复（保持已删状态）
        }
      }
      throw err;
    }
    return true;
  }

  // 任意存在的 Provider 视图——用于编辑/默认校验（内置模板已移除）。
  getModelView(id: string): ModelProviderView | null {
    const provider = this.getModel(id);
    return provider ? this.toView(provider) : null;
  }

  getModel(id: string): StoredModelProvider | null {
    return this.getAllModels().find((m) => m.id === id) ?? null;
  }

  recordModelProbe(
    id: string,
    result: { status: ModelProviderProbeStatus; error?: string },
  ): ModelProviderView | null {
    const settings = this.readSettings();
    const provider = settings.models.find((m) => m.id === id);
    if (!provider) return null;

    provider.lastProbeAt = new Date().toISOString();
    provider.lastProbeStatus = result.status;
    if (result.status === 'error' && result.error) {
      provider.lastProbeError = result.error.slice(0, 240);
    } else {
      delete provider.lastProbeError;
    }
    this.writeSettings(settings);
    return this.toView(provider);
  }
}
