import { DatabaseSync } from "node:sqlite";

export type ModelProviderKind = "builtin" | "custom";

export interface StoredModelProvider {
  id: string;
  kind: ModelProviderKind;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface ModelProviderView {
  id: string;
  kind: ModelProviderKind;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  models: string[];
  status: "unconfigured" | "configured" | "available" | "error" | "checking";
}

export interface CreateModelProviderInput {
  name: string;
  baseUrl: string;
  apiKey?: string | null;
  models: string[];
  // 内置模板入口：命中同名未配置内置时补齐密钥/目录，而不是创建新记录
  templateId?: string;
}

export interface UpdateModelProviderInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string | null;
  models?: string[];
}

// 默认模型 = provider + model 成对选择，二者必须一起持久化、一起校验
export interface DefaultModelSelection {
  providerId: string;
  modelId: string;
}

// settings 表 key='app' 的完整 blob。读写必须整块进行：
// 任何一次局部重写（例如只写 models）都会把其余字段静默抹掉。
interface AppSettingsBlob {
  models: StoredModelProvider[];
  defaultProviderId: string;
  defaultModelId: string;
  // .env 环境模型配置是否已导入过设置（一次性导入标记，删除导入的 Provider 也不会再导）
  envImported: boolean;
}

const DEFAULT_MODELS: StoredModelProvider[] = [
  {
    id: "deepseek-chat",
    kind: "builtin",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "openai-gpt4o",
    kind: "builtin",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    models: ["gpt-4o", "gpt-4o-mini", "o1-preview", "o1-mini"],
  },
  {
    id: "stepfun-step",
    kind: "builtin",
    name: "StepFun",
    baseUrl: "https://api.stepfun.com/v1",
    apiKey: "",
    models: ["step-2-16k", "step-1-8k"],
  },
];

// 从 baseUrl 推导 Provider 的展示名：环境导入创建的 Provider 不用模型名命名，
// 否则目录扩充后（如 MiniMax-M3 + 8 个模型）每个模型都挂着同一个模型名。
const KNOWN_PROVIDER_NAMES: Record<string, string> = {
  "api.minimaxi.com": "MiniMax",
  "api.openai.com": "OpenAI",
  "api.deepseek.com": "DeepSeek",
  "api.stepfun.com": "StepFun",
  "api.moonshot.cn": "Moonshot",
  "dashscope.aliyuncs.com": "Qwen",
  "api.zhipuai.cn": "Zhipu",
  "api.groq.com": "Groq",
  "api.anthropic.com": "Anthropic",
};

function deriveProviderName(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, "");
    if (KNOWN_PROVIDER_NAMES[host]) return KNOWN_PROVIDER_NAMES[host];
    const main = host.split(".").find(seg => !seg.startsWith("api")) ?? host;
    return main.charAt(0).toUpperCase() + main.slice(1);
  } catch {
    return "Custom Provider";
  }
}

function defaultSettings(): AppSettingsBlob {
  return {
    models: JSON.parse(JSON.stringify(DEFAULT_MODELS)) as StoredModelProvider[],
    defaultProviderId: DEFAULT_MODELS[0]?.id ?? "",
    defaultModelId: DEFAULT_MODELS[0]?.models[0] ?? "",
    envImported: false,
  };
}

export class SettingsStore {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const row = (this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined);
    if (!row) {
      this.writeSettings(defaultSettings());
    } else {
      // 旧库迁移：readSettings 会补齐缺失字段（如 defaultModelId），回写完成迁移
      this.writeSettings(this.readSettings());
    }
  }

  private readSettings(): AppSettingsBlob {
    const fallback = defaultSettings();
    const row = (this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined);
    if (!row) return fallback;
    let settings: AppSettingsBlob;
    try {
      const parsed = JSON.parse(row.value) as Partial<AppSettingsBlob>;
      settings = {
        models: Array.isArray(parsed.models) && parsed.models.length > 0 ? parsed.models : fallback.models,
        defaultProviderId: typeof parsed.defaultProviderId === "string" ? parsed.defaultProviderId : "",
        defaultModelId: typeof parsed.defaultModelId === "string" ? parsed.defaultModelId : "",
        envImported: parsed.envImported === true,
      };
    } catch (err) {
      console.error(`[SettingsStore] settings blob is corrupted, falling back to defaults: ${(err as Error).message}`);
      settings = fallback;
    }
    // 旧库迁移 / 目录变化后的安全网：默认模型必须仍在默认 provider 的模型目录里
    const provider = settings.models.find(m => m.id === settings.defaultProviderId);
    if (!provider || !provider.models.includes(settings.defaultModelId)) {
      settings.defaultModelId = provider?.models[0] ?? "";
    }
    // 旧库迁移：早期环境导入曾用模型名命名自定义 Provider（name === models[0]），
    // 目录扩充后（models.length > 1）名字会与模型混在一起，按 baseUrl 重命名为通用名。
    for (const p of settings.models) {
      if (p.kind === "custom" && p.models.length > 1 && p.name === p.models[0]) {
        p.name = deriveProviderName(p.baseUrl);
      }
    }
    return settings;
  }

  private writeSettings(settings: AppSettingsBlob): void {
    // UPSERT：settings 行可能尚不存在（首次初始化），仅 UPDATE 会静默写入 0 行
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES ('app', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(settings));
  }

  public getAllModels(): StoredModelProvider[] {
    return this.readSettings().models;
  }

  private maskApiKey(apiKey: string): string {
    if (!apiKey || apiKey.length <= 4) return "****";
    return "****" + apiKey.slice(-4);
  }

  private normalizeModels(models: string[]): string[] {
    const normalized = [...new Set(models.map(model => model.trim()).filter(Boolean))];
    if (normalized.length > 50) {
      throw new Error("models cannot exceed 50");
    }
    return normalized;
  }

  private validateUrl(url: string): void {
    if (!/^https?:\/\/\S+$/i.test(url)) {
      throw new Error("baseUrl must be a valid HTTP/HTTPS URL");
    }
  }

  private toView(provider: StoredModelProvider): ModelProviderView {
    const hasApiKey = Boolean(provider.apiKey);
    const status: ModelProviderView["status"] = hasApiKey ? "configured" : "unconfigured";
    return {
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKeyMasked: this.maskApiKey(provider.apiKey),
      hasApiKey,
      models: provider.models,
      status,
    };
  }

  // 列表只暴露"可用的"Provider：自定义始终显示（用户可见可编辑），
  // 内置仅当已配置密钥时显示 —— 未配置的内置模板不出现在列表里。
  listViews(): ModelProviderView[] {
    return this.getAllModels()
      .filter(p => p.kind === "custom" || Boolean(p.apiKey))
      .map(p => this.toView(p));
  }

  getDefaultProviderId(): string {
    return this.readSettings().defaultProviderId;
  }

  getDefaultModelId(): string {
    return this.readSettings().defaultModelId;
  }

  // 设置默认模型（provider + model 成对持久化）。校验：provider 必须存在、
  // 已配置密钥、至少有一个模型；显式传入的 modelId 必须在目录内。
  setDefaultModel(providerId: string, modelId?: string): DefaultModelSelection {
    const settings = this.readSettings();
    const provider = settings.models.find(m => m.id === providerId);
    if (!provider) throw new Error("Provider not found");
    if (!provider.apiKey) throw new Error("Provider has no API key configured");
    if (provider.models.length === 0) throw new Error("Provider has no models");
    let resolvedModelId: string;
    if (modelId !== undefined && modelId !== "") {
      if (!provider.models.includes(modelId)) {
        throw new Error(`Model "${modelId}" is not in provider catalog`);
      }
      resolvedModelId = modelId;
    } else {
      resolvedModelId = provider.models[0];
    }
    this.writeSettings({ ...settings, defaultProviderId: provider.id, defaultModelId: resolvedModelId });
    return { providerId: provider.id, modelId: resolvedModelId };
  }

  // 一次性把 .env 的环境模型配置导入设置：仅当从未导入过时执行（envImported 标记）。
  // baseUrl 与现有 Provider 一致时填入该 Provider（模型不在目录则插到最前），
  // 否则新建以模型 ID 命名的自定义 Provider；导入后即设为默认。
  importEnvFallback(input: { baseUrl: string; apiKey: string; model: string }): DefaultModelSelection | null {
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

    const existing = settings.models.find(m => m.baseUrl.toLowerCase() === baseUrl.toLowerCase());
    if (existing) {
      existing.apiKey = apiKey;
      if (!existing.models.includes(model)) {
        existing.models = [model, ...existing.models];
      }
      settings.defaultProviderId = existing.id;
      settings.defaultModelId = model;
    } else {
      const provider: StoredModelProvider = {
        id: crypto.randomUUID(),
        kind: "custom",
        // 用从 baseUrl 推导的通用名（如 api.minimaxi.com → MiniMax），
        // 避免 provider 名等于模型名、目录扩充后每项重复标注。
        name: deriveProviderName(baseUrl),
        baseUrl,
        apiKey,
        models: [model],
      };
      settings.models.push(provider);
      settings.defaultProviderId = provider.id;
      settings.defaultModelId = model;
    }
    this.writeSettings(settings);
    return { providerId: settings.defaultProviderId, modelId: settings.defaultModelId };
  }

  addModel(input: CreateModelProviderInput): ModelProviderView {
    const name = input.name.trim();
    const baseUrl = input.baseUrl.trim();
    const apiKey = (input.apiKey ?? "").trim();
    const models = this.normalizeModels(input.models);

    if (!name) throw new Error("name is required");
    if (!baseUrl) throw new Error("baseUrl is required");
    this.validateUrl(baseUrl);
    if (models.length === 0) throw new Error("models is required");

    const settings = this.readSettings();

    // 内置模板入口：命中未配置的同 ID 内置时直接补齐配置（不新建记录，
    // 避免与隐藏的内置模板重名冲突）。
    if (input.templateId) {
      const builtin = settings.models.find(m => m.id === input.templateId && m.kind === "builtin");
      if (builtin) {
        if (apiKey) builtin.apiKey = apiKey;
        builtin.baseUrl = baseUrl;
        builtin.models = this.normalizeModels([...builtin.models, ...models]);
        this.writeSettings(settings);
        return this.toView(builtin);
      }
    }

    const id = crypto.randomUUID();
    const provider: StoredModelProvider = {
      id,
      kind: "custom",
      name,
      baseUrl,
      apiKey,
      models,
    };

    if (settings.models.some(m => m.name.toLowerCase() === name.toLowerCase() || m.baseUrl.toLowerCase() === baseUrl.toLowerCase())) {
      throw new Error("Provider with same name or baseUrl already exists");
    }

    settings.models.push(provider);
    this.writeSettings(settings);
    return this.toView(provider);
  }

  updateModel(id: string, input: UpdateModelProviderInput): ModelProviderView | null {
    const settings = this.readSettings();
    const current = settings.models;
    const idx = current.findIndex(m => m.id === id);
    if (idx === -1) return null;

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new Error("name is required");
      if (current.some(m => m.id !== id && m.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("Provider with same name already exists");
      }
      current[idx].name = name;
    }

    if (input.baseUrl !== undefined) {
      const baseUrl = input.baseUrl.trim();
      if (!baseUrl) throw new Error("baseUrl is required");
      this.validateUrl(baseUrl);
      if (current.some(m => m.id !== id && m.baseUrl.toLowerCase() === baseUrl.toLowerCase())) {
        throw new Error("Provider with same baseUrl already exists");
      }
      current[idx].baseUrl = baseUrl;
    }

    if (input.apiKey !== undefined) {
      if (input.apiKey === null) {
        current[idx].apiKey = "";
      } else {
        const apiKey = input.apiKey.trim();
        if (!apiKey) {
          throw new Error("apiKey must be non-empty or null");
        }
        current[idx].apiKey = apiKey;
      }
    }

    if (input.models !== undefined) {
      const models = this.normalizeModels(input.models);
      if (models.length === 0) throw new Error("models is required");
      current[idx].models = models;
    }

    // 默认选择的一致性：默认 provider 被清空密钥或模型目录不再包含默认模型时，
    // 默认选择一并清空/回退，避免留下指向不可用组合的悬挂默认值。
    if (settings.defaultProviderId === id) {
      if (!current[idx].apiKey) {
        settings.defaultProviderId = "";
        settings.defaultModelId = "";
      } else if (!current[idx].models.includes(settings.defaultModelId)) {
        settings.defaultModelId = current[idx].models[0] ?? "";
      }
    }

    this.writeSettings(settings);
    return this.toView(current[idx]);
  }

  deleteModel(id: string): boolean {
    const settings = this.readSettings();
    const target = settings.models.find(m => m.id === id);
    if (target?.kind === "builtin") return false;
    const next = settings.models.filter(m => m.id !== id);
    if (next.length === settings.models.length) return false;
    // 删除的是默认 provider → 默认选择一并清空（解析时回退到第一个可用 provider）
    if (settings.defaultProviderId === id) {
      settings.defaultProviderId = "";
      settings.defaultModelId = "";
    }
    settings.models = next;
    this.writeSettings(settings);
    return true;
  }

  // 任意存在的 Provider 视图（包括未配置的内置模板）——用于编辑/默认校验，
  // 与 listViews（只暴露可见列表）语义不同。
  getModelView(id: string): ModelProviderView | null {
    const provider = this.getModel(id);
    return provider ? this.toView(provider) : null;
  }

  getModel(id: string): StoredModelProvider | null {
    return this.getAllModels().find(m => m.id === id) ?? null;
  }
}
