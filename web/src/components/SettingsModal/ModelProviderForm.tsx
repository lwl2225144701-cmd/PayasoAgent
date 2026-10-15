import { useI18n } from '../../i18n';
import type { LanguageMode } from '../../preferences';
import type { ModelThinkingLevel } from '../../types';
import { TrashIcon } from '../icons';
import { ProviderPicker } from './ProviderPicker';
import styles from './SettingsModal.module.css';
import {
  thinkingLevelOptionsFor,
  thinkingLevelSelectAriaLabel,
  thinkingLevelSelectTitle,
} from './thinking-level-options';
import type { ModelsSection } from './use-models-section';

interface ModelProviderFormProps {
  /** 模型页状态与操作（SettingsModal 用 useModelsSection 持有，跨 tab 切换存活）。 */
  section: ModelsSection;
  /** 界面语言：思考档次下拉的选项文案跟随它。 */
  language: LanguageMode;
}

/** 模型页的表单态：新增自定义 / 新增内置（pi-ai）/ 编辑共用同一套字段。 */
export function ModelProviderForm({ section, language }: ModelProviderFormProps) {
  const { t } = useI18n();
  const {
    formMode,
    form,
    setForm,
    error,
    saving,
    customOpen,
    setCustomOpen,
    detectingModels,
    piAiProviders,
    loadingPiAiProviders,
    handleSave,
    cancelForm,
    handleClearApiKey,
    handleDetectModels,
    handlePiAiProviderChange,
    addTag,
    removeTag,
  } = section;

  const hasApiKey = formMode === 'edit' && (form.hadApiKey || form.apiKey.length > 0);
  const isPiAiForm = formMode === 'add-pi-ai';
  // 当前内置 Provider 是否支持远端 /models 刷新（Host 判定，见 pi-ai-providers.ts）。
  // 决定按钮文案与提示：可刷新时说清"目录含远端"，不可刷新时仍按纯内置目录描述。
  const refreshableBuiltinProvider =
    Boolean(form.piProviderId) &&
    (piAiProviders.find((item) => item.id === form.piProviderId)?.refreshable ?? false);
  // 最近一次远端探测失败（目录沿用上次成功结果）→ 提示可能过期
  const staleBuiltinProvider =
    Boolean(form.piProviderId) &&
    (piAiProviders.find((item) => item.id === form.piProviderId)?.catalogStale ?? false);
  const title = isPiAiForm
    ? t('settings.models.addBuiltinProvider')
    : formMode === 'add'
      ? t('settings.models.addCustomProvider')
      : t('settings.models.editProvider');

  return (
    <div className={styles.formCard}>
      <div className={styles.formHeader}>
        <h3 className={styles.formTitle}>{title}</h3>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {isPiAiForm && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pi-ai-provider">
            {t('settings.models.builtinProvider')}
          </label>
          <ProviderPicker
            providers={piAiProviders}
            value={form.piProviderId ?? ''}
            loading={loadingPiAiProviders}
            onChange={handlePiAiProviderChange}
          />
          <div className={styles.tagHint}>{t('settings.models.builtinCatalogHint')}</div>
        </div>
      )}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="provider-name">
          {t('settings.models.name')}
        </label>
        <input
          id="provider-name"
          className={styles.input}
          value={form.name}
          onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
          placeholder={t('settings.models.namePlaceholder')}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="provider-api-key">
          {t('settings.models.apiKey')}
        </label>
        <input
          id="provider-api-key"
          className={styles.input}
          type="password"
          value={form.apiKey}
          onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
          placeholder={
            hasApiKey
              ? t('settings.models.apiKeyConfiguredPlaceholder')
              : formMode === 'edit'
                ? t('settings.models.apiKeyUnchangedPlaceholder')
                : t('settings.models.apiKeyPlaceholder')
          }
        />
        {formMode === 'edit' && hasApiKey && (
          <button
            type="button"
            className={styles.linkButton}
            onClick={handleClearApiKey}
            disabled={saving}
          >
            {t('settings.models.clearApiKey')}
          </button>
        )}
      </div>
      <div className={styles.field}>
        <button
          type="button"
          className={styles.collapseButton}
          onClick={() => setCustomOpen((v) => !v)}
        >
          <span>
            {customOpen ? '▾' : '▸'} {t('settings.models.customSettings')}
          </span>
        </button>
        {customOpen && (
          <div className={styles.collapseBody}>
            {!isPiAiForm && !form.piProviderId && (
              <div className={styles.field}>
                <label className={styles.label} htmlFor="provider-base-url">
                  {t('settings.models.baseUrl')}
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
                  {t('settings.models.catalog')}
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
                    ? t('common.refreshing')
                    : isPiAiForm || form.piProviderId
                      ? refreshableBuiltinProvider
                        ? t('settings.models.refreshBuiltinModelsOnline')
                        : t('settings.models.refreshBuiltinModels')
                      : t('settings.models.detectAndSync')}
                </button>
              </div>
              <div className={styles.tagHint}>
                {isPiAiForm || form.piProviderId
                  ? refreshableBuiltinProvider
                    ? t('settings.models.builtinRemoteCatalogHint')
                    : t('settings.models.builtinCatalogSourceHint')
                  : t('settings.models.detectHint')}
              </div>
              {/* 远端探测失败时的过期提示：目录来自上次成功结果，仍可用但可能缺新模型 */}
              {staleBuiltinProvider && (
                <div className={styles.error}>{t('settings.models.builtinCatalogStale')}</div>
              )}
              <div className={styles.tagList}>
                {form.tags.map((tag) => {
                  // 选项随模型与界面语言变化：pi 内置模型只列注册表声明的档次，
                  // 自定义端点列通用档；文案跟随语言偏好（见 thinking-level-options.ts）
                  const thinkingOptions = thinkingLevelOptionsFor({
                    supportedLevels: piAiProviders
                      .find((p) => p.id === form.piProviderId)
                      ?.models.find((m) => m.id === tag.value)?.thinkingLevels,
                    isPiProvider: Boolean(form.piProviderId),
                    language,
                  });
                  return (
                    <div key={tag.id} className={styles.tag}>
                      <div className={styles.tagHead}>
                        <span className={styles.tagValue} title={tag.value}>
                          {tag.value}
                        </span>
                        {/* 视觉是单个开关，不占字段网格的一格 —— 放标题行右侧更紧凑，
                            也让下方三个数值字段正好铺满一行（之前它换行后右侧留白）。 */}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={tag.vision ?? false}
                          className={`${styles.tagVisionToggle} ${tag.vision ? styles.tagVisionOn : ''}`}
                          title={t('settings.models.visionTitle')}
                          onClick={() =>
                            setForm((prev) => ({
                              ...prev,
                              tags: prev.tags.map((t) =>
                                t.id === tag.id ? { ...t, vision: !t.vision } : t,
                              ),
                            }))
                          }
                        >
                          <span className={styles.tagVisionDot} aria-hidden="true" />
                          {t('settings.models.vision')}
                        </button>
                        <button
                          type="button"
                          className={styles.tagRemove}
                          onClick={() => removeTag(tag.id)}
                          aria-label={t('settings.models.removeModel')}
                          title={t('settings.models.removeModel')}
                        >
                          <TrashIcon size={12} />
                        </button>
                      </div>
                      <div className={styles.tagFields}>
                        <label className={styles.tagField}>
                          <span className={styles.tagFieldLabel}>
                            {t('settings.models.contextWindow')}
                          </span>
                          <input
                            type="number"
                            min={1}
                            className={styles.tagWindowInput}
                            placeholder={t('settings.models.optional')}
                            title={t('settings.models.contextWindowTitle')}
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
                        </label>
                        <label className={styles.tagField}>
                          <span className={styles.tagFieldLabel}>
                            {t('settings.models.maxOutput')}
                          </span>
                          <input
                            type="number"
                            min={1}
                            className={styles.tagOutputInput}
                            placeholder={t('settings.models.optional')}
                            title={t('settings.models.maxOutputTitle')}
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
                        </label>
                        <label className={styles.tagField}>
                          <span className={styles.tagFieldLabel}>
                            {t('settings.thinking.selectAria')}
                          </span>
                          <select
                            className={styles.tagThinkingSelect}
                            value={tag.thinkingLevel ?? ''}
                            title={thinkingLevelSelectTitle(language)}
                            aria-label={thinkingLevelSelectAriaLabel(language)}
                            onChange={(e) =>
                              setForm((prev) => ({
                                ...prev,
                                tags: prev.tags.map((t) =>
                                  t.id === tag.id
                                    ? {
                                        ...t,
                                        thinkingLevel:
                                          e.target.value === ''
                                            ? undefined
                                            : (e.target.value as ModelThinkingLevel),
                                      }
                                    : t,
                                ),
                              }))
                            }
                          >
                            {thinkingOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                  );
                })}
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
                  placeholder={t('settings.models.modelIdPlaceholder')}
                />
                <button type="button" className={styles.tagAddButton} onClick={addTag}>
                  + {t('settings.models.addModel')}
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
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
}
