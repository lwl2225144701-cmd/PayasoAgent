import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createModel,
  deleteModel,
  fetchAvailableModels,
  getDefaultModel,
  listModels,
  listPiAiProviders,
  previewAvailableModels,
  updateModel,
} from '../../api';
import type { ConversationFontSize, LanguageMode } from '../../preferences';
import type { ThemeMode } from '../../theme';
import type {
  CreateModelProviderInput,
  ModelProviderView,
  PermissionMode,
  PiAiProviderInfo,
  ProviderModelInfo,
  UpdateModelProviderInput,
} from '../../types';
import { GeneralSettings } from '../GeneralSettings';
import {
  ChevronDownIcon,
  CloseIcon,
  DatabaseIcon,
  PlusIcon,
  SettingsIcon,
  SlidersIcon,
  TrashIcon,
  UserIcon,
} from '../icons';
import { Modal } from '../Modal';
import { ModelSyncDialog } from '../ModelSyncDialog';
import styles from './SettingsModal.module.css';

type Tab = 'general' | 'models';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  language: LanguageMode;
  onLanguageChange: (mode: LanguageMode) => void;
  fontSize: ConversationFontSize;
  onFontSizeChange: (size: ConversationFontSize) => void;
  onSaved?: () => void;
}

type FormMode = 'list' | 'add' | 'add-pi-ai' | 'edit';

interface ModelTag {
  id: string;
  value: string;
  // 可选的上下文窗口（tokens）；空字符串 = 未配置
  contextWindow?: string;
  // 可选的最大输出（tokens）；空字符串 = 未配置（由后端按窗口推导）
  maxOutputTokens?: string;
  // 模型支持图片输入（视觉能力）；显式配置优先于 pi-ai 注册表声明
  vision?: boolean;
}

interface FormState {
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

function statusLabel(status: ModelProviderView['status']): string {
  switch (status) {
    case 'unconfigured':
      return '未配置';
    case 'configured':
      return '待检测';
    case 'available':
      return '可用（已检测）';
    case 'error':
      return '检测失败';
    case 'checking':
      return '正在检测';
    default:
      return status;
  }
}

function ProviderPicker({
  providers,
  value,
  loading,
  onChange,
}: {
  providers: PiAiProviderInfo[];
  value: string;
  loading: boolean;
  onChange: (providerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selected = providers.find((provider) => provider.id === value);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className={styles.providerPicker} ref={pickerRef}>
      <button
        type="button"
        className={styles.providerPickerTrigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={loading}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          className={selected ? styles.providerPickerSelected : styles.providerPickerPlaceholder}
        >
          {selected?.name ?? (loading ? '加载内置提供方…' : '选择提供方')}
        </span>
        <ChevronDownIcon size={15} />
      </button>
      {open && (
        <div className={styles.providerPickerMenu} role="listbox" aria-label="内置提供方">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              role="option"
              aria-selected={provider.id === value}
              className={styles.providerPickerOption}
              onClick={() => {
                onChange(provider.id);
                setOpen(false);
              }}
            >
              <span className={styles.providerPickerName}>{provider.name}</span>
              <span className={styles.providerPickerMeta}>
                {provider.id} · {provider.models.length} 个模型
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function catalogFromModelIds(models: string[]): ProviderModelInfo[] {
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

function catalogFromPiAiProvider(provider: PiAiProviderInfo): ProviderModelInfo[] {
  return provider.models.map((model) => ({
    id: model.id,
    category: 'chat' as const,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    // pi-ai 模型 input modalities 含 'image' 即声明视觉能力
    vision: model.input.includes('image'),
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

const EMPTY_FORM: FormState = {
  name: '',
  baseUrl: '',
  apiKey: '',
  hadApiKey: false,
  tags: [],
  newTag: '',
};

export function SettingsModal({
  open,
  onClose,
  themeMode,
  onThemeModeChange,
  permissionMode,
  onPermissionModeChange,
  language,
  onLanguageChange,
  fontSize,
  onFontSizeChange,
  onSaved,
}: SettingsModalProps) {
  const [models, setModels] = useState<ModelProviderView[]>([]);
  const [loading, setLoading] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>('list');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [detectingModels, setDetectingModels] = useState(false);
  const [piAiProviders, setPiAiProviders] = useState<PiAiProviderInfo[]>([]);
  const [loadingPiAiProviders, setLoadingPiAiProviders] = useState(false);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [syncCatalog, setSyncCatalog] = useState<ProviderModelInfo[]>([]);
  const [syncSelectedIds, setSyncSelectedIds] = useState<string[]>([]);
  const [syncError, setSyncError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [resp, defResp] = await Promise.all([listModels(), getDefaultModel()]);
      setModels(resp.models);
      setDefaultId(defResp.defaultProviderId || null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`加载模型列表失败：${msg}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  useEffect(() => {
    if (!open) {
      setFormMode('list');
      setForm(EMPTY_FORM);
      setError(null);
      setDeletingId(null);
      setActiveTab('general');
      setSyncDialogOpen(false);
      setSyncCatalog([]);
      setSyncSelectedIds([]);
      setSyncError(null);
    }
  }, [open]);

  const startAdd = () => {
    setForm({ ...EMPTY_FORM, tags: [] });
    setFormMode('add');
    setCustomOpen(false);
    setError(null);
  };

  const loadPiAiProviders = useCallback(async () => {
    setLoadingPiAiProviders(true);
    try {
      const resp = await listPiAiProviders();
      setPiAiProviders(resp.providers);
      return resp.providers;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`加载内置提供方失败：${msg}`);
      return [];
    } finally {
      setLoadingPiAiProviders(false);
    }
  }, []);

  const startAddPiAi = () => {
    setForm({ ...EMPTY_FORM, tags: [] });
    setFormMode('add-pi-ai');
    setCustomOpen(false);
    setError(null);
    if (piAiProviders.length === 0) void loadPiAiProviders();
  };

  const handlePiAiProviderChange = (providerId: string) => {
    const provider = piAiProviders.find((item) => item.id === providerId);
    if (!provider) return;
    const catalog = catalogFromPiAiProvider(provider);
    const tags = catalog.slice(0, 50).map((model) => ({
      id: crypto.randomUUID(),
      value: model.id,
      contextWindow: model.contextWindow !== undefined ? String(model.contextWindow) : '',
      maxOutputTokens: model.maxOutputTokens !== undefined ? String(model.maxOutputTokens) : '',
      ...(model.vision ? { vision: true } : {}),
    }));
    setForm((prev) => ({
      ...prev,
      piProviderId: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      tags,
    }));
    setError(null);
  };

  const startEdit = (m: ModelProviderView) => {
    setForm({
      id: m.id,
      kind: m.kind,
      piProviderId: m.piProviderId,
      name: m.name,
      baseUrl: m.baseUrl,
      apiKey: '',
      hadApiKey: m.hasApiKey,
      tags: m.models.map((value, idx) => {
        const window = m.modelCapabilities?.[value]?.contextWindow;
        const output = m.modelCapabilities?.[value]?.maxOutputTokens;
        const vision = m.modelCapabilities?.[value]?.vision === true;
        return {
          id: `${m.id}-${idx}`,
          value,
          contextWindow: window !== undefined ? String(window) : '',
          maxOutputTokens: output !== undefined ? String(output) : '',
          ...(vision ? { vision: true } : {}),
        };
      }),
      newTag: '',
    });
    setFormMode('edit');
    setCustomOpen(false);
    setError(null);
  };

  const cancelForm = () => {
    setFormMode('list');
    setForm(EMPTY_FORM);
    setError(null);
    setSyncDialogOpen(false);
    setSyncError(null);
  };

  const handleSave = async () => {
    setError(null);
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    const isBuiltIn = Boolean(form.piProviderId);
    const modelsList = modelsFromTags();
    if (!name || (!isBuiltIn && !baseUrl)) {
      setError(isBuiltIn ? '名称不能为空。' : '名称和 Base URL 不能为空。');
      return;
    }
    if (modelsList.length === 0) {
      setError('至少需要一个模型标识。');
      return;
    }
    if (formMode === 'add-pi-ai' && !form.piProviderId) {
      setError('请选择一个内置提供方。');
      return;
    }
    if (formMode === 'add-pi-ai' && !form.apiKey.trim()) {
      setError('请填写 API 密钥后再保存内置提供方。');
      return;
    }
    // 按模型能力覆盖：收集填写了上下文窗口/最大输出或开启了视觉能力的模型；
    // 数值必须为正整数。最大输出留空时由后端按上下文窗口推导（不再固定 4K）。
    let modelCapabilities:
      | Record<string, { contextWindow?: number; maxOutputTokens?: number; vision?: boolean }>
      | undefined;
    for (const tag of form.tags) {
      const rawWindow = (tag.contextWindow ?? '').trim();
      let contextWindow: number | undefined;
      if (rawWindow) {
        const window = Number(rawWindow);
        if (!Number.isSafeInteger(window) || window <= 0) {
          setError(`模型 ${tag.value} 的上下文窗口必须是正整数。`);
          return;
        }
        contextWindow = window;
      }
      const rawOutput = (tag.maxOutputTokens ?? '').trim();
      let maxOutputTokens: number | undefined;
      if (rawOutput) {
        const output = Number(rawOutput);
        if (!Number.isSafeInteger(output) || output <= 0) {
          setError(`模型 ${tag.value} 的最大输出必须是正整数。`);
          return;
        }
        maxOutputTokens = output;
      }
      if (contextWindow === undefined && maxOutputTokens === undefined && !tag.vision) continue;
      modelCapabilities = modelCapabilities ?? {};
      modelCapabilities[tag.value] = {
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(tag.vision ? { vision: true } : {}),
      };
    }

    setSaving(true);
    try {
      if (formMode === 'add' || formMode === 'add-pi-ai') {
        const input: CreateModelProviderInput = {
          name,
          ...(isBuiltIn ? {} : { baseUrl }),
          models: modelsList,
          ...(form.piProviderId ? { piProviderId: form.piProviderId } : {}),
          ...(modelCapabilities ? { modelCapabilities } : {}),
        };
        if (form.apiKey) {
          input.apiKey = form.apiKey;
        }
        await createModel(input);
      } else if (formMode === 'edit' && form.id) {
        const input: UpdateModelProviderInput = {
          name,
          ...(isBuiltIn ? {} : { baseUrl }),
          models: modelsList,
          modelCapabilities,
        };
        if (form.apiKey) {
          input.apiKey = form.apiKey;
        }
        await updateModel(form.id, input);
      }
      await refresh();
      setFormMode('list');
      setForm(EMPTY_FORM);
      setCustomOpen(false);
      onSaved?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`保存失败：${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const handleClearApiKey = async () => {
    if (!form.id) return;
    setSaving(true);
    setError(null);
    try {
      await updateModel(form.id, { apiKey: null });
      onSaved?.();
      await refresh();
      setForm((prev) => ({ ...prev, apiKey: '', hadApiKey: false }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`清除密钥失败：${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deletingId) return;
    try {
      await deleteModel(deletingId);
      onSaved?.();
      setModels((prev) => prev.filter((m) => m.id !== deletingId));
      setDeletingId(null);
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`删除失败：${msg}`);
      setDeletingId(null);
    }
  };

  const addTag = () => {
    const value = form.newTag.trim();
    if (!value) return;
    setForm((prev) => ({
      ...prev,
      tags: [...prev.tags, { id: crypto.randomUUID(), value }],
      newTag: '',
    }));
    setError(null);
  };

  const removeTag = (id: string) => {
    setForm((prev) => ({
      ...prev,
      tags: prev.tags.filter((t) => t.id !== id),
    }));
  };

  const modelsFromTags = () => form.tags.map((t) => t.value);

  const openSyncDialog = (catalog: ProviderModelInfo[]) => {
    const chatCatalog = Array.from(
      new Map(
        catalog.filter((model) => model.category === 'chat').map((model) => [model.id, model]),
      ).values(),
    );
    if (chatCatalog.length === 0) {
      setError('检测到模型目录，但没有识别到可用于 Agent 的对话模型；请手动添加模型标识。');
      return;
    }
    setSyncError(null);
    setSyncCatalog(chatCatalog);
    setSyncSelectedIds(chatCatalog.map((model) => model.id));
    setSyncDialogOpen(true);
  };

  const syncResultModelCount = (() => {
    if (!syncDialogOpen) return form.tags.length;
    const syncedIds = new Set(syncCatalog.map((model) => model.id));
    const existingManualCount = form.tags.filter((tag) => !syncedIds.has(tag.value)).length;
    return existingManualCount + syncSelectedIds.length;
  })();

  const applySyncSelection = () => {
    const selectedIds = new Set(syncSelectedIds);
    const syncedIds = new Set(syncCatalog.map((model) => model.id));
    const preservedTags = form.tags.filter(
      (tag) => !syncedIds.has(tag.value) || selectedIds.has(tag.value),
    );
    const selectedCatalog = syncCatalog.filter((model) => selectedIds.has(model.id));
    const merged = mergeCatalogIntoTags(preservedTags, selectedCatalog);
    if (merged.tags.length > 50) {
      setSyncError(
        `当前选择 ${merged.tags.length} 个模型，最多只能保存 50 个，请将选择调整到 50 个以内。`,
      );
      return;
    }
    setForm((prev) => ({ ...prev, tags: merged.tags }));
    setSyncDialogOpen(false);
    setSyncError(null);
    setError(null);
  };

  // 检测 OpenAI 兼容端点的模型目录，自动合并对话模型与上下文能力（点保存才落库）。
  // 编辑已有 Provider 时通过 providerId 读取服务端配置；
  // 新增 Provider 时通过 baseUrl + apiKey 临时预检（不落盘）。
  const handleDetectModels = async () => {
    setError(null);
    if (form.piProviderId) {
      setDetectingModels(true);
      try {
        const providers = piAiProviders.length > 0 ? piAiProviders : await loadPiAiProviders();
        const provider = providers.find((item) => item.id === form.piProviderId);
        if (!provider) throw new Error('内置提供方未找到');
        const catalog = catalogFromPiAiProvider(provider);
        openSyncDialog(catalog);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`内置模型目录刷新失败：${msg}`);
      } finally {
        setDetectingModels(false);
      }
      return;
    }
    if (formMode === 'edit' && form.id) {
      setDetectingModels(true);
      try {
        const resp = await fetchAvailableModels({ providerId: form.id });
        const catalog = resp.catalog ?? catalogFromModelIds(resp.models);
        openSyncDialog(catalog);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`模型检测失败：${msg}`);
      } finally {
        setDetectingModels(false);
      }
    } else if (formMode === 'add') {
      if (!form.baseUrl || !form.apiKey) {
        setError('请填写 API 地址与 API 密钥后再检测模型目录。');
        return;
      }
      setDetectingModels(true);
      try {
        const resp = await previewAvailableModels({ baseUrl: form.baseUrl, apiKey: form.apiKey });
        const catalog = resp.catalog ?? catalogFromModelIds(resp.models);
        openSyncDialog(catalog);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`模型检测失败：${msg}`);
      } finally {
        setDetectingModels(false);
      }
    } else {
      setError('请先保存 Provider 后再检测模型目录。');
    }
  };

  const renderModelsTab = () => {
    if (formMode !== 'list') {
      const hasApiKey = formMode === 'edit' && (form.hadApiKey || form.apiKey.length > 0);
      const isPiAiForm = formMode === 'add-pi-ai';
      const title = isPiAiForm
        ? '添加内置提供方'
        : formMode === 'add'
          ? '添加自定义提供方'
          : '编辑提供方';
      return (
        <div className={styles.formCard}>
          <div className={styles.formHeader}>
            <h3 className={styles.formTitle}>{title}</h3>
          </div>
          {error && <div className={styles.error}>{error}</div>}
          {isPiAiForm && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="pi-ai-provider">
                内置提供方
              </label>
              <ProviderPicker
                providers={piAiProviders}
                value={form.piProviderId ?? ''}
                loading={loadingPiAiProviders}
                onChange={handlePiAiProviderChange}
              />
              <div className={styles.tagHint}>
                目录来自内置模型库；保存后会按模型的真实 API 协议流式调用。
              </div>
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="provider-name">
              名称
            </label>
            <input
              id="provider-name"
              className={styles.input}
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="例如 DeepSeek"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="provider-api-key">
              API 密钥
            </label>
            <input
              id="provider-api-key"
              className={styles.input}
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder={
                hasApiKey
                  ? '已配置——输入新值可替换'
                  : formMode === 'edit'
                    ? '留空 = 不修改'
                    : '输入 API 密钥'
              }
            />
            {formMode === 'edit' && hasApiKey && (
              <button
                type="button"
                className={styles.linkButton}
                onClick={handleClearApiKey}
                disabled={saving}
              >
                清除密钥
              </button>
            )}
          </div>
          <div className={styles.field}>
            <button
              type="button"
              className={styles.collapseButton}
              onClick={() => setCustomOpen((v) => !v)}
            >
              <span>{customOpen ? '▾' : '▸'} 自定义设置</span>
            </button>
            {customOpen && (
              <div className={styles.collapseBody}>
                {!isPiAiForm && !form.piProviderId && (
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="provider-base-url">
                      API 地址
                    </label>
                    <input
                      id="provider-base-url"
                      className={styles.input}
                      value={form.baseUrl}
                      onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
                      placeholder="https://api.deepseek.com"
                    />
                  </div>
                )}
                <div className={styles.field}>
                  <div className={styles.tagHeader}>
                    <label className={styles.label} htmlFor="provider-new-tag">
                      模型目录
                    </label>
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={handleDetectModels}
                      disabled={
                        detectingModels ||
                        (formMode === 'edit'
                          ? !form.id
                          : form.piProviderId
                            ? false
                            : !form.baseUrl || !form.apiKey)
                      }
                    >
                      {detectingModels
                        ? '刷新中…'
                        : isPiAiForm || form.piProviderId
                          ? '刷新内置模型'
                          : '检测并同步模型'}
                    </button>
                  </div>
                  <div className={styles.tagHint}>
                    {isPiAiForm || form.piProviderId
                      ? '使用内置模型目录；模型上下文和协议由模型库提供。'
                      : '检测后自动同步对话模型和上下文窗口；已手动填写的上下文不会覆盖。'}
                  </div>
                  <div className={styles.tagList}>
                    {form.tags.map((tag) => (
                      <span key={tag.id} className={styles.tag}>
                        <span className={styles.tagValue}>{tag.value}</span>
                        <input
                          type="number"
                          min={1}
                          className={styles.tagWindowInput}
                          placeholder="上下文窗口"
                          title="上下文窗口（tokens，可选；来自模型供应商文档）"
                          value={tag.contextWindow ?? ''}
                          onChange={(e) =>
                            setForm((prev) => ({
                              ...prev,
                              tags: prev.tags.map((t) =>
                                t.id === tag.id ? { ...t, contextWindow: e.target.value } : t,
                              ),
                            }))
                          }
                        />
                        <input
                          type="number"
                          min={1}
                          className={styles.tagOutputInput}
                          placeholder="最大输出"
                          title="单次回复最大输出（tokens，可选）；留空时按上下文窗口推导"
                          value={tag.maxOutputTokens ?? ''}
                          onChange={(e) =>
                            setForm((prev) => ({
                              ...prev,
                              tags: prev.tags.map((t) =>
                                t.id === tag.id ? { ...t, maxOutputTokens: e.target.value } : t,
                              ),
                            }))
                          }
                        />
                        <button
                          type="button"
                          role="switch"
                          aria-checked={tag.vision ?? false}
                          className={`${styles.tagVisionToggle} ${tag.vision ? styles.tagVisionOn : ''}`}
                          title="该模型支持图片输入（视觉能力）；已按模型声明预选"
                          onClick={() =>
                            setForm((prev) => ({
                              ...prev,
                              tags: prev.tags.map((t) =>
                                t.id === tag.id ? { ...t, vision: !t.vision } : t,
                              ),
                            }))
                          }
                        >
                          视觉
                        </button>
                        <button
                          type="button"
                          className={styles.tagRemove}
                          onClick={() => removeTag(tag.id)}
                        >
                          <TrashIcon size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className={styles.tagAddRow}>
                    <input
                      id="provider-new-tag"
                      className={styles.tagInput}
                      value={form.newTag}
                      onChange={(e) => setForm((prev) => ({ ...prev, newTag: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addTag();
                        }
                      }}
                      placeholder="输入模型标识"
                    />
                    <button type="button" className={styles.tagAddButton} onClick={addTag}>
                      + 添加模型
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={cancelForm}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className={styles.modelsTab}>
        <div className={styles.toolbar}>
          <button type="button" className={styles.secondaryButton} onClick={startAddPiAi}>
            <PlusIcon size={14} />
            <span>添加内置提供方</span>
          </button>
          <button type="button" className={styles.primaryButton} onClick={startAdd}>
            <PlusIcon size={14} />
            <span>添加自定义提供方</span>
          </button>
        </div>
        {error && <div className={styles.error}>{error}</div>}
        {loading ? (
          <div className={styles.placeholder}>加载中…</div>
        ) : models.length === 0 ? (
          <div className={styles.placeholder}>暂无模型提供方，点击上方按钮添加。</div>
        ) : (
          <div className={styles.list}>
            {models.map((m) => {
              return (
                <div
                  key={m.id}
                  className={styles.card}
                  title={`${m.name} · ${m.baseUrl} · ${m.hasApiKey ? 'API Key 已配置' : 'API Key 未设置'} · ${statusLabel(m.status)}`}
                >
                  <div className={styles.cardMain}>
                    <div className={styles.cardTitleRow}>
                      <span className={styles.cardTitle}>{m.name}</span>
                      {!m.piProviderId && m.kind === 'custom' && (
                        <span className={styles.sourceBadge}>自定义</span>
                      )}
                      {m.id === defaultId && <span className={styles.defaultBadge}>默认</span>}
                      <span
                        className={styles.statusDot}
                        data-status={m.status}
                        title={statusLabel(m.status)}
                      />
                    </div>
                  </div>
                  <div className={styles.cardActions}>
                    <button
                      type="button"
                      className={`${styles.textButton} ${styles.cardEditButton}`}
                      onClick={() => startEdit(m)}
                    >
                      编辑
                    </button>
                    {m.kind === 'custom' && (
                      <button
                        type="button"
                        className={`${styles.textButton} ${styles.textButtonDanger}`}
                        onClick={() => setDeletingId(m.id)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderGeneralTab = () => (
    <div className={styles.generalTab}>
      <GeneralSettings
        themeMode={themeMode}
        onThemeModeChange={onThemeModeChange}
        permissionMode={permissionMode}
        onPermissionModeChange={onPermissionModeChange}
        language={language}
        onLanguageChange={onLanguageChange}
        fontSize={fontSize}
        onFontSizeChange={onFontSizeChange}
      />
    </div>
  );

  const handleModalClose = () => {
    if (syncDialogOpen) {
      setSyncDialogOpen(false);
      return;
    }
    onClose();
  };

  return (
    <>
      <Modal onClose={handleModalClose} ariaLabel="设置">
        <div className={styles.container}>
          <div className={styles.header}>
            <h2 className={styles.title}>设置</h2>
            <button
              type="button"
              className={styles.closeButton}
              onClick={handleModalClose}
              aria-label="关闭"
            >
              <CloseIcon size={16} />
            </button>
          </div>
          <div className={styles.body}>
            <nav className={styles.nav}>
              <button
                type="button"
                className={`${styles.navItem} ${activeTab === 'general' ? styles.navItemActive : ''}`}
                onClick={() => setActiveTab('general')}
              >
                <SettingsIcon size={16} />
                <span>通用设置</span>
              </button>
              <button
                type="button"
                className={`${styles.navItem} ${activeTab === 'models' ? styles.navItemActive : ''}`}
                onClick={() => setActiveTab('models')}
              >
                <DatabaseIcon size={16} />
                <span>模型</span>
              </button>
              <button
                type="button"
                className={`${styles.navItem} ${styles.navItemDisabled}`}
                disabled
              >
                <SlidersIcon size={16} />
                <span>插件</span>
              </button>
              <button
                type="button"
                className={`${styles.navItem} ${styles.navItemDisabled}`}
                disabled
              >
                <UserIcon size={16} />
                <span>Agent 预设</span>
              </button>
            </nav>
            <div className={styles.content}>
              {activeTab === 'general' ? renderGeneralTab() : renderModelsTab()}
            </div>
          </div>
        </div>

        {deletingId && (
          <button
            type="button"
            className={styles.confirmBackdrop}
            aria-label="取消删除"
            onClick={() => setDeletingId(null)}
          >
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: 确认容器仅用于阻止遮罩冒泡，键盘操作由内部"取消"按钮提供 */}
            <div
              className={styles.confirm}
              role="alertdialog"
              aria-modal="true"
              aria-label="删除提供方确认"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className={styles.confirmTitle}>删除提供方</h3>
              <p className={styles.confirmText}>确定要删除这个模型提供方吗？此操作不可恢复。</p>
              <div className={styles.confirmActions}>
                <button
                  type="button"
                  className={`${styles.primaryButton} ${styles.dangerButton}`}
                  onClick={confirmDelete}
                >
                  删除
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => setDeletingId(null)}
                >
                  取消
                </button>
              </div>
            </div>
          </button>
        )}
      </Modal>
      <ModelSyncDialog
        open={syncDialogOpen}
        models={syncCatalog}
        selectedIds={syncSelectedIds}
        resultModelCount={syncResultModelCount}
        maxModels={50}
        error={syncError}
        onToggle={(modelId, checked) => {
          setSyncError(null);
          setSyncSelectedIds((current) =>
            checked
              ? current.includes(modelId)
                ? current
                : [...current, modelId]
              : current.filter((id) => id !== modelId),
          );
        }}
        onSelectAll={() => {
          setSyncError(null);
          setSyncSelectedIds(syncCatalog.map((model) => model.id));
        }}
        onClearAll={() => {
          setSyncError(null);
          setSyncSelectedIds([]);
        }}
        onCancel={() => {
          setSyncError(null);
          setSyncDialogOpen(false);
        }}
        onConfirm={applySyncSelection}
      />
    </>
  );
}
