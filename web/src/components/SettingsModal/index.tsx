import { useState, useEffect, useCallback } from 'react';
import {
  listModels,
  createModel,
  updateModel,
  deleteModel,
} from '../../api';
import type { ModelProviderView, CreateModelProviderInput, UpdateModelProviderInput } from '../../types';
import {
  CloseIcon,
  PlusIcon,
  PencilIcon,
  TrashIcon,
  SettingsIcon,
  DatabaseIcon,
  SlidersIcon,
  UserIcon,
} from '../icons';
import { Modal } from '../Modal';
import styles from './SettingsModal.module.css';

type Tab = 'general' | 'models' | 'plugins' | 'presets';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type FormMode = 'list' | 'add' | 'edit';

interface FormState {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  baseUrl: '',
  apiKey: '',
  models: '',
};

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [tab, setTab] = useState<Tab>('models');
  const [models, setModels] = useState<ModelProviderView[]>([]);
  const [loading, setLoading] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>('list');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listModels();
      setModels(resp.models);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`加载模型列表失败：${msg}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && tab === 'models') {
      void refresh();
    }
  }, [open, tab, refresh]);

  useEffect(() => {
    if (!open) {
      setFormMode('list');
      setForm(EMPTY_FORM);
      setError(null);
      setDeletingId(null);
    }
  }, [open]);

  const startAdd = () => {
    setForm({ ...EMPTY_FORM, models: '' });
    setFormMode('add');
    setError(null);
  };

  const startEdit = (m: ModelProviderView) => {
    setForm({
      id: m.id,
      name: m.name,
      baseUrl: m.baseUrl,
      apiKey: '',
      models: m.models.join(', '),
    });
    setFormMode('edit');
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
    const modelsRaw = form.models;
    if (!name || !baseUrl) {
      setError('名称和 Base URL 不能为空。');
      return;
    }
    const modelsList = modelsRaw
      .split(/[,，\n]+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (modelsList.length === 0) {
      setError('至少需要一个模型标识。');
      return;
    }

    setSaving(true);
    try {
      if (formMode === 'add') {
        const input: CreateModelProviderInput = {
          name,
          baseUrl,
          models: modelsList,
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
        };
        if (form.apiKey) {
          input.apiKey = form.apiKey;
        }
        await updateModel(form.id, input);
      }
      await refresh();
      setFormMode('list');
      setForm(EMPTY_FORM);
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
      setForm(prev => ({ ...prev, apiKey: '' }));
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
      setModels(prev => prev.filter(m => m.id !== deletingId));
      setDeletingId(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`删除失败：${msg}`);
      setDeletingId(null);
    }
  };

  const renderModelsTab = () => {
    if (formMode !== 'list') {
      return (
        <div className={styles.formCard}>
          <h3 className={styles.formTitle}>{formMode === 'add' ? '添加提供方' : '编辑提供方'}</h3>
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.field}>
            <label className={styles.label}>名称</label>
            <input
              className={styles.input}
              value={form.name}
              onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder="例如 DeepSeek"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Base URL</label>
            <input
              className={styles.input}
              value={form.baseUrl}
              onChange={e => setForm(prev => ({ ...prev, baseUrl: e.target.value }))}
              placeholder="https://api.deepseek.com"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>API Key</label>
            <input
              className={styles.input}
              type="password"
              value={form.apiKey}
              onChange={e => setForm(prev => ({ ...prev, apiKey: e.target.value }))}
              placeholder="留空 = 不修改"
            />
            {formMode === 'edit' && (
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
            <label className={styles.label}>模型标识（逗号分隔）</label>
            <textarea
              className={styles.textarea}
              value={form.models}
              onChange={e => setForm(prev => ({ ...prev, models: e.target.value }))}
              placeholder="deepseek-chat, deepseek-reasoner"
              rows={3}
            />
          </div>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={cancelForm}
              disabled={saving}
            >
              取消
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className={styles.modelsTab}>
        <div className={styles.toolbar}>
          <button type="button" className={styles.primaryButton} onClick={startAdd}>
            <PlusIcon size={14} />
            <span>添加提供方</span>
          </button>
        </div>
        {error && <div className={styles.error}>{error}</div>}
        {loading ? (
          <div className={styles.placeholder}>加载中…</div>
        ) : models.length === 0 ? (
          <div className={styles.placeholder}>暂无模型提供方，点击上方按钮添加。</div>
        ) : (
          <div className={styles.list}>
            {models.map(m => (
              <div key={m.id} className={styles.item}>
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle}>{m.name}</div>
                  <div className={styles.itemMeta}>{m.baseUrl}</div>
                  <div className={styles.itemMeta}>
                    API Key：{m.hasApiKey ? m.apiKeyMasked : '未设置'}
                  </div>
                  <div className={styles.itemMeta}>
                    状态：<span className={styles.statusUnchecked}>未检测</span>
                  </div>
                </div>
                <div className={styles.itemActions}>
                  <button
                    type="button"
                    className={styles.iconButton}
                    onClick={() => startEdit(m)}
                    title="编辑"
                  >
                    <PencilIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className={`${styles.iconButton} ${styles.dangerButton}`}
                    onClick={() => setDeletingId(m.id)}
                    title="删除"
                  >
                    <TrashIcon size={14} />
                  </button>
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
      <div className={styles.settingGroup}>
        <div className={styles.settingItem}>
          <div className={styles.settingHeader}>
            <div className={styles.settingTitle}>Agent 预设</div>
            <div className={styles.settingDesc}>对此后新建的会话生效。运行中的会话保持它开始时的预设。</div>
          </div>
          <div className={styles.settingControl}>
            <select className={styles.select}>
              <option>标准模式</option>
            </select>
          </div>
        </div>
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingItem}>
          <div className={styles.settingHeader}>
            <div className={styles.settingTitle}>权限</div>
            <div className={styles.settingDesc}>选择新会话的默认权限模式</div>
          </div>
          <div className={styles.settingControl}>
            <select className={styles.select}>
              <option>Workspace Write</option>
            </select>
          </div>
        </div>
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingItem}>
          <div className={styles.settingHeader}>
            <div className={styles.settingTitle}>语言</div>
          </div>
          <div className={styles.settingControl}>
            <select className={styles.select}>
              <option>中文</option>
            </select>
          </div>
        </div>
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingItem}>
          <div className={styles.settingHeader}>
            <div className={styles.settingTitle}>外观</div>
          </div>
          <div className={styles.settingControl}>
            <div className={styles.buttonGroup}>
              <button type="button" className={styles.buttonGroupItem}>浅色</button>
              <button type="button" className={`${styles.buttonGroupItem} ${styles.buttonGroupItemActive}`}>深色</button>
              <button type="button" className={styles.buttonGroupItem}>跟随系统</button>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingItem}>
          <div className={styles.settingHeader}>
            <div className={styles.settingTitle}>字号大小</div>
            <div className={styles.settingDesc}>仅会影响会话内容的字号</div>
          </div>
          <div className={styles.settingControl}>
            <div className={styles.numberControl}>
              <input className={styles.numberInput} type="text" value="14" readOnly />
              <span className={styles.numberUnit}>px</span>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingItem}>
          <div className={styles.settingHeader}>
            <div className={styles.settingTitle}>对话显示</div>
            <div className={styles.settingDesc}>控制已完成轮次的过程内容</div>
          </div>
          <div className={styles.settingControl}>
            <select className={styles.select}>
              <option>Compact</option>
            </select>
          </div>
        </div>
      </div>

      <div className={styles.settingGroup}>
        <div className={styles.settingItem}>
          <div className={styles.settingHeader}>
            <div className={styles.settingTitle}>繁忙时 Enter 行为</div>
            <div className={styles.settingDesc}>仅在智能体运行时生效；Cmd/Ctrl+Enter 使用另一行为</div>
          </div>
          <div className={styles.settingControl}>
            <select className={styles.select}>
              <option>排队发送</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );

  const renderTabContent = () => {
    switch (tab) {
      case 'general':
        return renderGeneralTab();
      case 'models':
        return renderModelsTab();
      case 'plugins':
      case 'presets':
      default:
        return (
          <div className={styles.placeholder}>
            {tab === 'plugins' && '插件管理'}
            {tab === 'presets' && 'Agent 预设'}
            <br />
            后续版本支持。
          </div>
        );
    }
  };

  return (
    <Modal onClose={onClose} ariaLabel="设置">
      <div className={styles.container}>
        <div className={styles.header}>
          <h2 className={styles.title}>设置</h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="关闭"
          >
            <CloseIcon size={16} />
          </button>
        </div>
        <div className={styles.body}>
          <nav className={styles.nav}>
            <button
              type="button"
              className={`${styles.navItem} ${tab === 'general' ? styles.navItemActive : ''}`}
              onClick={() => setTab('general')}
            >
              <SettingsIcon size={16} />
              <span>通用设置</span>
            </button>
            <button
              type="button"
              className={`${styles.navItem} ${tab === 'models' ? styles.navItemActive : ''}`}
              onClick={() => setTab('models')}
            >
              <DatabaseIcon size={16} />
              <span>模型</span>
            </button>
            <button
              type="button"
              className={`${styles.navItem} ${tab === 'plugins' ? styles.navItemActive : ''}`}
              onClick={() => setTab('plugins')}
            >
              <SlidersIcon size={16} />
              <span>插件</span>
            </button>
            <button
              type="button"
              className={`${styles.navItem} ${tab === 'presets' ? styles.navItemActive : ''}`}
              onClick={() => setTab('presets')}
            >
              <UserIcon size={16} />
              <span>Agent 预设</span>
            </button>
          </nav>
          <div className={styles.content}>{renderTabContent()}</div>
        </div>
      </div>

      {deletingId && (
        <div className={styles.confirmBackdrop} onClick={() => setDeletingId(null)}>
          <div className={styles.confirm} onClick={e => e.stopPropagation()}>
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
        </div>
      )}
    </Modal>
  );
}
