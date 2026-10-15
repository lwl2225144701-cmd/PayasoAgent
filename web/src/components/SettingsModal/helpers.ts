import type { Translate } from '../../i18n/translate';
import type {
  ModelProviderView,
  ModelThinkingLevel,
  PiAiProviderInfo,
  ProviderModelInfo,
} from '../../types';

/** 模型设置表单的四种形态：列表 / 新增自定义 / 新增内置（pi-ai）/ 编辑。 */
export type FormMode = 'list' | 'add' | 'add-pi-ai' | 'edit';

export interface ModelTag {
  id: string;
  value: string;
  // 可选的上下文窗口（tokens）；空字符串 = 未配置
  contextWindow?: string;
  // 可选的最大输出（tokens）；空字符串 = 未配置（由后端按窗口推导）
  maxOutputTokens?: string;
  // 模型支持图片输入（视觉能力）；显式配置优先于 pi-ai 注册表声明
  vision?: boolean;
  // 思考档次（可选）；undefined = 不设置（请求不带思考参数）
  thinkingLevel?: ModelThinkingLevel;
}

export interface FormState {
  id?: string;
  kind?: 'builtin' | 'custom';
  piProviderId?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  hadApiKey: boolean;
  tags: ModelTag[];
  newTag: string;
}

/** 按模型能力覆盖：只收集填写了数值或打开了开关的模型（与后端入参同构）。 */
export type ModelCapabilities = Record<
  string,
  {
    contextWindow?: number;
    maxOutputTokens?: number;
    vision?: boolean;
    thinkingLevel?: ModelThinkingLevel;
  }
>;

/** 同步对话框的模型数上限，与 <ModelSyncDialog maxModels> 保持一致。 */
export const MAX_SYNC_MODELS = 50;

/** 空表单：所有"新增"入口都从它起步（tags 每次显式给新数组，避免共享引用）。 */
export const EMPTY_FORM: FormState = {
  name: '',
  baseUrl: '',
  apiKey: '',
  hadApiKey: false,
  tags: [],
  newTag: '',
};

export function catalogFromModelIds(models: string[]): ProviderModelInfo[] {
  return models.map((id) => {
    // 兼容旧 Host 只返回 models:[id] 的响应；MiniMax-M3 的能力已在项目注册表中确认。
    const contextWindow = id.trim().toLowerCase() === 'minimax-m3' ? 512_000 : undefined;
    return {
      id,
      category: 'chat' as const,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
  });
}

export function catalogFromPiAiProvider(provider: PiAiProviderInfo): ProviderModelInfo[] {
  return provider.models.map((model) => ({
    id: model.id,
    category: 'chat' as const,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    // pi-ai 模型 input modalities 含 'image' 即声明视觉能力
    vision: model.input.includes('image'),
    // pi-ai 注册表声明的思考档次（用于下拉选项，不自动预选）
    thinkingLevels: model.thinkingLevels,
  }));
}

function mergeCatalogIntoTags(
  currentTags: ModelTag[],
  catalog: ProviderModelInfo[],
): { tags: ModelTag[]; addedCount: number; contextFilledCount: number; chatCount: number } {
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  let contextFilledCount = 0;
  const tags = currentTags.map((tag) => {
    const model = catalogById.get(tag.value);
    if (!model) return tag;
    let next = tag;
    if (model.contextWindow !== undefined && !(tag.contextWindow ?? '').trim()) {
      contextFilledCount += 1;
      next = { ...next, contextWindow: String(model.contextWindow) };
    }
    if (model.maxOutputTokens !== undefined && !(next.maxOutputTokens ?? '').trim()) {
      next = { ...next, maxOutputTokens: String(model.maxOutputTokens) };
    }
    return next;
  });

  const known = new Set(tags.map((tag) => tag.value));
  const chatModels = catalog.filter((model) => model.category === 'chat');
  const added = chatModels
    .filter((model) => !known.has(model.id))
    .map((model) => ({
      id: crypto.randomUUID(),
      value: model.id,
      ...(model.contextWindow !== undefined ? { contextWindow: String(model.contextWindow) } : {}),
      ...(model.maxOutputTokens !== undefined
        ? { maxOutputTokens: String(model.maxOutputTokens) }
        : {}),
      ...(model.vision ? { vision: true } : {}),
    }));
  contextFilledCount += added.filter((tag) => tag.contextWindow !== undefined).length;

  return {
    tags: [...tags, ...added],
    addedCount: added.length,
    contextFilledCount,
    chatCount: chatModels.length,
  };
}

/** 编辑态：把已存 Provider 的模型与能力还原成表单标签。 */
export function tagsFromProviderView(m: ModelProviderView): ModelTag[] {
  return m.models.map((value, idx) => {
    const window = m.modelCapabilities?.[value]?.contextWindow;
    const output = m.modelCapabilities?.[value]?.maxOutputTokens;
    const vision = m.modelCapabilities?.[value]?.vision === true;
    const thinkingLevel = m.modelCapabilities?.[value]?.thinkingLevel;
    return {
      id: `${m.id}-${idx}`,
      value,
      contextWindow: window !== undefined ? String(window) : '',
      maxOutputTokens: output !== undefined ? String(output) : '',
      ...(vision ? { vision: true } : {}),
      // 'off' 与"未设置"行为等价（都不介入请求），归一为空值，避免下拉
      // 出现无匹配选项的空白显示。
      ...(thinkingLevel && thinkingLevel !== 'off' ? { thinkingLevel } : {}),
    };
  });
}

/** 内置 Provider 目录 → 表单标签（截断到上限个数，与保存时的数量上限一致）。 */
export function tagsFromPiAiCatalog(catalog: ProviderModelInfo[]): ModelTag[] {
  return catalog.slice(0, MAX_SYNC_MODELS).map((model) => ({
    id: crypto.randomUUID(),
    value: model.id,
    contextWindow: model.contextWindow !== undefined ? String(model.contextWindow) : '',
    maxOutputTokens: model.maxOutputTokens !== undefined ? String(model.maxOutputTokens) : '',
    ...(model.vision ? { vision: true } : {}),
  }));
}

/** 目录收敛为「按 id 去重的 chat 模型」，供同步对话框展示。 */
export function chatCatalogById(catalog: ProviderModelInfo[]): ProviderModelInfo[] {
  return Array.from(
    new Map(
      catalog.filter((model) => model.category === 'chat').map((model) => [model.id, model]),
    ).values(),
  );
}

/**
 * 收集表单标签里的模型能力覆盖：数值必须为正整数，最大输出留空时由后端按上下文窗口推导
 * （不再固定 4K）。返回 ok:false 时 error 已是可直展示的文案，调用方 setError 后 return。
 */
export function parseModelCapabilities(
  tags: ModelTag[],
  t: Translate,
): { ok: true; capabilities: ModelCapabilities | undefined } | { ok: false; error: string } {
  let modelCapabilities: ModelCapabilities | undefined;
  for (const tag of tags) {
    const rawWindow = (tag.contextWindow ?? '').trim();
    let contextWindow: number | undefined;
    if (rawWindow) {
      const window = Number(rawWindow);
      if (!Number.isSafeInteger(window) || window <= 0) {
        return {
          ok: false,
          error: t('settings.models.contextWindowPositiveInteger', { model: tag.value }),
        };
      }
      contextWindow = window;
    }
    const rawOutput = (tag.maxOutputTokens ?? '').trim();
    let maxOutputTokens: number | undefined;
    if (rawOutput) {
      const output = Number(rawOutput);
      if (!Number.isSafeInteger(output) || output <= 0) {
        return {
          ok: false,
          error: t('settings.models.maxOutputPositiveInteger', { model: tag.value }),
        };
      }
      maxOutputTokens = output;
    }
    if (
      contextWindow === undefined &&
      maxOutputTokens === undefined &&
      !tag.vision &&
      !tag.thinkingLevel
    ) {
      continue;
    }
    modelCapabilities = modelCapabilities ?? {};
    modelCapabilities[tag.value] = {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(tag.vision ? { vision: true } : {}),
      ...(tag.thinkingLevel ? { thinkingLevel: tag.thinkingLevel } : {}),
    };
  }
  return { ok: true, capabilities: modelCapabilities };
}

/**
 * 合并同步对话框的选择结果：保留手工添加的标签 + 选中的目录项（目录声明的能力补进空缺）。
 * 超出上限时返回 error 文案而不是标签，由调用方显示在对话框内。
 */
export function mergeSyncSelection(
  currentTags: ModelTag[],
  catalog: ProviderModelInfo[],
  selectedIds: string[],
  t: Translate,
  maxModels: number,
): { tags: ModelTag[] } | { error: string } {
  const selected = new Set(selectedIds);
  const syncedIds = new Set(catalog.map((model) => model.id));
  const preservedTags = currentTags.filter(
    (tag) => !syncedIds.has(tag.value) || selected.has(tag.value),
  );
  const selectedCatalog = catalog.filter((model) => selected.has(model.id));
  const merged = mergeCatalogIntoTags(preservedTags, selectedCatalog);
  if (merged.tags.length > maxModels) {
    return {
      error: t('settings.models.tooManyModels', { count: merged.tags.length, max: maxModels }),
    };
  }
  return { tags: merged.tags };
}
