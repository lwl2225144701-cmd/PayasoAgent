import { DatabaseSync } from "node:sqlite";

export interface StoredModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface ModelProviderView {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  models: string[];
  status: "unchecked" | "connected" | "error";
}

export interface CreateModelProviderInput {
  name: string;
  baseUrl: string;
  apiKey?: string | null;
  models: string[];
}

export interface UpdateModelProviderInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string | null;
  models?: string[];
}

const DEFAULT_MODELS: StoredModelProvider[] = [];

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
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run(JSON.stringify({ models: DEFAULT_MODELS }));
    }
  }

  public getAllModels(): StoredModelProvider[] {
    const row = (this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined);
    if (!row) return JSON.parse(JSON.stringify(DEFAULT_MODELS));
    try {
      const parsed = JSON.parse(row.value) as { models?: StoredModelProvider[] };
      return Array.isArray(parsed.models) ? parsed.models : JSON.parse(JSON.stringify(DEFAULT_MODELS));
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_MODELS));
    }
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
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKeyMasked: this.maskApiKey(provider.apiKey),
      hasApiKey: Boolean(provider.apiKey),
      models: provider.models,
      status: "unchecked",
    };
  }

  listViews(): ModelProviderView[] {
    return this.getAllModels().map(p => this.toView(p));
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

    const id = crypto.randomUUID();
    const provider: StoredModelProvider = {
      id,
      name,
      baseUrl,
      apiKey,
      models,
    };

    const current = this.getAllModels();
    if (current.some(m => m.name.toLowerCase() === name.toLowerCase() || m.baseUrl.toLowerCase() === baseUrl.toLowerCase())) {
      throw new Error("Provider with same name or baseUrl already exists");
    }

    current.push(provider);
    this.persist(current);
    return this.toView(provider);
  }

  updateModel(id: string, input: UpdateModelProviderInput): ModelProviderView | null {
    const current = this.getAllModels();
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

    this.persist(current);
    return this.toView(current[idx]);
  }

  deleteModel(id: string): boolean {
    const current = this.getAllModels();
    const next = current.filter(m => m.id !== id);
    if (next.length === current.length) return false;
    this.persist(next);
    return true;
  }

  getModel(id: string): StoredModelProvider | null {
    return this.getAllModels().find(m => m.id === id) ?? null;
  }

  private persist(models: StoredModelProvider[]): void {
    this.db.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify({ models }));
  }
}
