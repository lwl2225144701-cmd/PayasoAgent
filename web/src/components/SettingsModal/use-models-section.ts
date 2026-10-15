import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from 'react';
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
import { useI18n } from '../../i18n';
import type {
  CreateModelProviderInput,
  ModelProviderView,
  PiAiProviderInfo,
  ProviderModelInfo,
  UpdateModelProviderInput,
} from '../../types';
import {
  catalogFromModelIds,
  catalogFromPiAiProvider,
  EMPTY_FORM,
  type FormMode,
  type FormState,
  parseModelCapabilities,
  tagsFromPiAiCatalog,
  tagsFromProviderView,
} from './helpers';
import { useModelSync } from './use-model-sync';

interface UseModelsSectionOptions {
  /** 弹窗是否打开：关闭时复位列表/表单/同步对话框。 */
  open: boolean;
  /** 增删改成功后的外部回调（App 侧据此刷新默认模型等）。 */
  onSaved?: () => void;
}

/** 模型页所需的全部状态与操作，由 SettingsModal 经 props 下发给 ModelsTab / ModelProviderForm。 */
export interface ModelsSection {
  // —— 列表与默认档 ——
  models: ModelProviderView[];
  loading: boolean;
  defaultId: string | null;
  refresh: () => Promise<void>;
  // —— 删除确认 ——
  deletingId: string | null;
  setDeletingId: Dispatch<SetStateAction<string | null>>;
  confirmDelete: () => Promise<void>;
  // —— 表单 ——
  formMode: FormMode;
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  saving: boolean;
  error: string | null;
  customOpen: boolean;
  setCustomOpen: Dispatch<SetStateAction<boolean>>;
  startAdd: () => void;
  startAddPiAi: () => void;
  startEdit: (m: ModelProviderView) => void;
  cancelForm: () => void;
  handleSave: () => Promise<void>;
  handleClearApiKey: () => Promise<void>;
  addTag: () => void;
  removeTag: (id: string) => void;
  detectingModels: boolean;
  handleDetectModels: () => Promise<void>;
  // —— 内置（pi-ai）Provider 注册表 ——
  piAiProviders: PiAiProviderInfo[];
  loadingPiAiProviders: boolean;
  handlePiAiProviderChange: (providerId: string) => void;
  // —— 目录同步对话框 ——
  syncDialogOpen: boolean;
  syncCatalog: ProviderModelInfo[];
  syncSelectedIds: string[];
  syncError: string | null;
  syncResultModelCount: number;
  setSyncError: Dispatch<SetStateAction<string | null>>;
  setSyncSelectedIds: Dispatch<SetStateAction<string[]>>;
  setSyncDialogOpen: Dispatch<SetStateAction<boolean>>;
  openSyncDialog: (catalog: ProviderModelInfo[], notice?: string | null) => void;
  applySyncSelection: () => void;
}

/**
 * 模型页的状态机：列表刷新、表单（新增自定义 / 新增内置 / 编辑）、保存与删除、
 * 目录探测，以及把探测结果送进同步对话框（useModelSync）。
 *
 * 它必须挂在 SettingsModal 上而不是 ModelsTab 内部：这些 state 要跨 tab 切换存活
 * （切到「通用」页再回来，进行到一半的表单不能丢），与拆分前的行为一致。
 */
export function useModelsSection({ open, onSaved }: UseModelsSectionOptions): ModelsSection {
  const { t } = useI18n();
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

  const {
    syncDialogOpen,
    syncCatalog,
    syncSelectedIds,
    syncError,
    syncResultModelCount,
    setSyncError,
    setSyncSelectedIds,
    setSyncDialogOpen,
    openSyncDialog,
    applySyncSelection,
  } = useModelSync({
    open,
    tags: form.tags,
    onApplyTags: (nextTags) => setForm((prev) => ({ ...prev, tags: nextTags })),
    setFormError: setError,
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [resp, defResp] = await Promise.all([listModels(), getDefaultModel()]);
      setModels(resp.models);
      setDefaultId(defResp.defaultProviderId || null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(t('settings.models.loadListFailed', { message: msg }));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
      setError(t('settings.models.loadProvidersFailed', { message: msg }));
      return [];
    } finally {
      setLoadingPiAiProviders(false);
    }
  }, [t]);

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
    const tags = tagsFromPiAiCatalog(catalogFromPiAiProvider(provider));
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
      tags: tagsFromProviderView(m),
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
      setError(
        isBuiltIn ? t('settings.models.nameRequired') : t('settings.models.nameAndBaseUrlRequired'),
      );
      return;
    }
    if (modelsList.length === 0) {
      setError(t('settings.models.atLeastOneModel'));
      return;
    }
    if (formMode === 'add-pi-ai' && !form.piProviderId) {
      setError(t('settings.models.providerRequired'));
      return;
    }
    if (formMode === 'add-pi-ai' && !form.apiKey.trim()) {
      setError(t('settings.models.apiKeyRequiredToSave'));
      return;
    }
    // 按模型能力覆盖：收集填写了上下文窗口/最大输出/思考档次或开启了视觉能力的
    // 模型；数值必须为正整数。最大输出留空时由后端按上下文窗口推导（不再固定 4K）。
    const parsed = parseModelCapabilities(form.tags, t);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const modelCapabilities = parsed.capabilities;

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
      setError(t('settings.models.saveFailed', { message: msg }));
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
      setError(t('settings.models.clearApiKeyFailed', { message: msg }));
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
      setError(t('settings.models.deleteFailed', { message: msg }));
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

  // 检测模型目录。三条来源，优先级从高到低：
  //   ① 内置 Provider 且可远端刷新 → Host 合并「远端 /models + 内置目录」
  //   ② 内置 Provider 不可刷新     → 纯内置目录（pi-ai 注册表 + 本地补丁）
  //   ③ 自定义 Provider            → 端点 /models（编辑用已存密钥，新增用表单密钥预检）
  // 内置 Provider 的远端刷新失败不阻断流程：回退到内置目录，并在对话框里说明原因。
  const handleDetectModels = async () => {
    setError(null);
    if (form.piProviderId) {
      setDetectingModels(true);
      try {
        const providers = piAiProviders.length > 0 ? piAiProviders : await loadPiAiProviders();
        const provider = providers.find((item) => item.id === form.piProviderId);
        if (!provider) throw new Error(t('settings.models.builtinProviderNotFound'));
        const builtinCatalog = catalogFromPiAiProvider(provider);
        if (!provider.refreshable) {
          openSyncDialog(builtinCatalog);
          return;
        }
        const typedApiKey = form.apiKey.trim();
        let notice: string | null = null;
        let catalog = builtinCatalog;
        try {
          if (typedApiKey) {
            // 表单里刚输入的密钥优先：编辑态下它可能还没保存，服务端读到的是旧值
            const resp = await previewAvailableModels({
              baseUrl: provider.baseUrl,
              apiKey: typedApiKey,
              piProviderId: provider.id,
            });
            catalog = resp.catalog ?? catalogFromModelIds(resp.models);
          } else if (formMode === 'edit' && form.id) {
            const resp = await fetchAvailableModels({ providerId: form.id });
            catalog = resp.catalog ?? catalogFromModelIds(resp.models);
          } else {
            notice = t('settings.models.builtinCatalogNeedsApiKey');
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notice = t('settings.models.builtinCatalogRefreshFailed', { message: msg });
        }
        openSyncDialog(catalog, notice);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(t('settings.models.builtinCatalogRefreshFailed', { message: msg }));
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
        setError(t('settings.models.detectFailed', { message: msg }));
      } finally {
        setDetectingModels(false);
      }
    } else if (formMode === 'add') {
      if (!form.baseUrl || !form.apiKey) {
        setError(t('settings.models.baseUrlAndApiKeyRequired'));
        return;
      }
      setDetectingModels(true);
      try {
        const resp = await previewAvailableModels({ baseUrl: form.baseUrl, apiKey: form.apiKey });
        const catalog = resp.catalog ?? catalogFromModelIds(resp.models);
        openSyncDialog(catalog);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(t('settings.models.detectFailed', { message: msg }));
      } finally {
        setDetectingModels(false);
      }
    } else {
      setError(t('settings.models.saveProviderFirst'));
    }
  };

  return {
    models,
    loading,
    defaultId,
    refresh,
    deletingId,
    setDeletingId,
    confirmDelete,
    formMode,
    form,
    setForm,
    saving,
    error,
    customOpen,
    setCustomOpen,
    startAdd,
    startAddPiAi,
    startEdit,
    cancelForm,
    handleSave,
    handleClearApiKey,
    addTag,
    removeTag,
    detectingModels,
    handleDetectModels,
    piAiProviders,
    loadingPiAiProviders,
    handlePiAiProviderChange,
    syncDialogOpen,
    syncCatalog,
    syncSelectedIds,
    syncError,
    syncResultModelCount,
    setSyncError,
    setSyncSelectedIds,
    setSyncDialogOpen,
    openSyncDialog,
    applySyncSelection,
  };
}
