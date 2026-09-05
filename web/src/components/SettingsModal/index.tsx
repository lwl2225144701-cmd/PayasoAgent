import { useCallback, useEffect, useState } from 'react';
import {
  createModel,
  deleteModel,
  fetchAvailableModels,
  getDefaultModel,
  listModels,
  previewAvailableModels,
  setDefaultModel,
  updateModel,
} from '../../api';
import type { ConversationFontSize, LanguageMode } from '../../preferences';
import type { ThemeMode } from '../../theme';
import type {
  CreateModelProviderInput,
  ModelProviderView,
  PermissionMode,
  UpdateModelProviderInput,
} from '../../types';
import { GeneralSettings } from '../GeneralSettings';
import {
  CloseIcon,
  DatabaseIcon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  SlidersIcon,
  TrashIcon,
  UserIcon,
} from '../icons';
import { Modal } from '../Modal';
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

type FormMode = 'list' | 'add' | 'edit';

interface ModelTag {
  id: string;
  value: string;
  // 可选的上下文窗口（tokens）；空字符串 = 未配置
  contextWindow?: string;
}

interface FormState {
  id?: string;
  kind?: 'builtin' | 'custom';
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
      return '已配置，未检测';
    case 'available':
      return '可用';
    case 'error':
      return '检测失败';
    case 'checking':
      return '正在检测';
    default:
      return status;
  }
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
  const [fetchingModels, setFetchingModels] = useState(false);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('general');

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
    }
  }, [open]);

  const startAdd = () => {
    setForm({ ...EMPTY_FORM, tags: [] });
    setFormMode('add');
    setCustomOpen(false);
    setError(null);
  };

  const startEdit = (m: ModelProviderView) => {
    setForm({
      id: m.id,
      kind: m.kind,
      name: m.name,
      baseUrl: m.baseUrl,
      apiKey: '',
      hadApiKey: m.hasApiKey,
      tags: m.models.map((value, idx) => {
        const window = m.modelCapabilities?.[value]?.contextWindow;
        return { id: `${m.id}-${idx}`, value, contextWindow: window !== undefined ? String(window) : '' };
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
  };

  const handleSave = async () => {
    setError(null);
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    const modelsList = modelsFromTags();
    if (!name || !baseUrl) {
      setError('名称和 Base URL 不能为空。');
      return;
    }
    if (modelsList.length === 0) {
      setError('至少需要一个模型标识。');
      return;
    }
    // 按模型能力覆盖：仅收集填写了上下文窗口的模型；数值必须为正整数
    let modelCapabilities: Record<string, { contextWindow: number }> | undefined;
    for (const tag of form.tags) {
      const raw = (tag.contextWindow ?? '').trim();
      if (!raw) continue;
      const window = Number(raw);
      if (!Number.isSafeInteger(window) || window <= 0) {
        setError(`模型 ${tag.value} 的上下文窗口必须是正整数。`);
        return;
      }
      modelCapabilities = modelCapabilities ?? {};
      modelCapabilities[tag.value] = { contextWindow: window };
    }

    setSaving(true);
    try {
      if (formMode === 'add') {
        const input: CreateModelProviderInput = {
          name,
          baseUrl,
          models: modelsList,
          ...(modelCapabilities ? { modelCapabilities } : {}),
        };
        if (form.apiKey) {
          input.apiKey = form.apiKey;
        }
        await createModel(input);
      } else if (formMode === 'edit' && form.id) {
        const input: UpdateModelProviderInput = {
          name,
          baseUrl,
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
      setModels((prev) => prev.filter((m) => m.id !== deletingId));
      setDeletingId(null);
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

  // 拉取 OpenAI 兼容端点的可用模型并合并进目录（点保存才落库）。
  // 编辑已有 Provider 时通过 providerId 读取服务端配置；
  // 新增 Provider 时通过 baseUrl + apiKey 临时预检（不落盘）。
  const handleFetchModels = async () => {
    setError(null);
    if (formMode === 'edit' && form.id) {
      setFetchingModels(true);
      try {
        const resp = await fetchAvailableModels({ providerId: form.id });
        const known = new Set(form.tags.map((t) => t.value));
        const added = resp.models
          .filter((m) => !known.has(m))
          .map((value) => ({ id: crypto.randomUUID(), value }));
        let tags = [...form.tags, ...added];
        if (tags.length > 50) {
          tags = tags.slice(0, 50);
          setError('模型目录超过 50 个上限，已截取前 50 个，可手动调整后再保存。');
        }
        setForm((prev) => ({ ...prev, tags }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`获取可用模型失败：${msg}`);
      } finally {
        setFetchingModels(false);
      }
    } else if (formMode === 'add') {
      if (!form.baseUrl || !form.apiKey) {
        setError('请填写 API 地址与 API 密钥后再拉取可用模型。');
        return;
      }
      setFetchingModels(true);
      try {
        const resp = await previewAvailableModels({ baseUrl: form.baseUrl, apiKey: form.apiKey });
        const known = new Set(form.tags.map((t) => t.value));
        const added = resp.models
          .filter((m) => !known.has(m))
          .map((value) => ({ id: crypto.randomUUID(), value }));
        let tags = [...form.tags, ...added];
        if (tags.length > 50) {
          tags = tags.slice(0, 50);
          setError('模型目录超过 50 个上限，已截取前 50 个，可手动调整后再保存。');
        }
        setForm((prev) => ({ ...prev, tags }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`获取可用模型失败：${msg}`);
      } finally {
        setFetchingModels(false);
      }
    } else {
      setError('请先保存 Provider 后再拉取可用模型。');
    }
  };

  const renderModelsTab = () => {
    if (formMode !== 'list') {
      const hasApiKey = formMode === 'edit' && (form.hadApiKey || form.apiKey.length > 0);
      const title = formMode === 'add' ? '添加自定义提供方' : '编辑提供方';
      return (
        <div className={styles.formCard}>
          <div className={styles.formHeader}>
            <h3 className={styles.formTitle}>{title}</h3>
          </div>
          {error && <div className={styles.error}>{error}</div>}
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
                <div className={styles.field}>
                  <div className={styles.tagHeader}>
                    <label className={styles.label} htmlFor="provider-new-tag">
                      模型目录
                    </label>
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={handleFetchModels}
                      disabled={
                        fetchingModels ||
                        (formMode === 'edit' ? !form.id : !form.baseUrl || !form.apiKey)
                      }
                    >
                      {fetchingModels ? '获取中…' : '获取可用模型'}
                    </button>
                  </div>
                  <div className={styles.tagHint}>正在使用适配器默认模型</div>
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
          <button type="button" className={styles.primaryButton} onClick={() => startAdd()}>
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
            {models.map((m) => (
              <div key={m.id} className={styles.card}>
                <div className={styles.cardMain}>
                  <div className={styles.cardTitleRow}>
                    <span className={styles.cardTitle}>{m.name}</span>
                    {m.id === defaultId && <span className={styles.defaultBadge}>默认</span>}
                    <span
                      className={styles.statusDot}
                      data-status={m.status}
                      title={statusLabel(m.status)}
                    />
                  </div>
                  <div className={styles.cardMeta}>{m.baseUrl}</div>
                  <div className={styles.cardMeta}>
                    API Key：{m.hasApiKey ? '已配置' : '未设置'}
                  </div>
                  <div className={styles.cardMeta}>
                    状态：
                    <span className={styles.statusText} data-status={m.status}>
                      {statusLabel(m.status)}
                    </span>
                  </div>
                </div>
                <div className={styles.cardActions}>
                  <button type="button" className={styles.textButton} onClick={() => startEdit(m)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className={styles.textButton}
                    disabled={!m.hasApiKey || m.id === defaultId}
                    title={
                      !m.hasApiKey
                        ? '请先配置 API 密钥'
                        : m.id === defaultId
                          ? '当前默认提供方'
                          : undefined
                    }
                    onClick={async () => {
                      setError(null);
                      try {
                        await setDefaultModel(m.id, m.models[0] ?? '');
                        // 立即在卡片上显示"当前默认"，并通知 App 刷新底部下拉
                        setDefaultId(m.id);
                        window.dispatchEvent(
                          new CustomEvent('settings:defaultChanged', {
                            detail: { providerId: m.id },
                          }),
                        );
                      } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        setError(`设为默认失败：${msg}`);
                      }
                    }}
                  >
                    {m.id === defaultId ? '当前默认' : '设为默认'}
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
            ))}
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

  return (
    <Modal onClose={onClose} ariaLabel="设置">
      <div className={styles.container}>
        <div className={styles.header}>
          <h2 className={styles.title}>设置</h2>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="关闭">
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
  );
}
