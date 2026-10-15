import { useI18n } from '../../i18n';
import type { Translate } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
import type { ModelProviderView } from '../../types';
import { PlusIcon, TrashIcon } from '../icons';
import { ModelProviderForm } from './ModelProviderForm';
import styles from './SettingsModal.module.css';
import type { ModelsSection } from './use-models-section';

interface ModelsTabProps {
  /** 模型页状态与操作（SettingsModal 用 useModelsSection 持有，跨 tab 切换存活）。 */
  section: ModelsSection;
  /** 界面语言：思考档次下拉的选项文案跟随它。 */
  language: LanguageMode;
}

function statusLabel(status: ModelProviderView['status'], t: Translate): string {
  switch (status) {
    case 'unconfigured':
      return t('settings.models.status.unconfigured');
    case 'configured':
      return t('settings.models.status.configured');
    case 'available':
      return t('settings.models.status.available');
    case 'error':
      return t('settings.models.status.error');
    case 'checking':
      return t('settings.models.status.checking');
    default:
      return status;
  }
}

/** 设置弹窗的「模型」页：工具栏 + Provider 列表；表单态整体交给 ModelProviderForm。 */
export function ModelsTab({ section, language }: ModelsTabProps) {
  const { t } = useI18n();
  const {
    models,
    loading,
    error,
    formMode,
    defaultId,
    setDeletingId,
    startAdd,
    startAddPiAi,
    startEdit,
  } = section;

  if (formMode !== 'list') {
    return <ModelProviderForm section={section} language={language} />;
  }

  return (
    <div className={styles.modelsTab}>
      <div className={styles.toolbar}>
        <button type="button" className={styles.secondaryButton} onClick={startAddPiAi}>
          <PlusIcon size={14} />
          <span>{t('settings.models.addBuiltinProvider')}</span>
        </button>
        <button type="button" className={styles.primaryButton} onClick={startAdd}>
          <PlusIcon size={14} />
          <span>{t('settings.models.addCustomProvider')}</span>
        </button>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {loading ? (
        <div className={styles.placeholder}>{t('common.loading')}</div>
      ) : models.length === 0 ? (
        <div className={styles.placeholder}>{t('settings.models.emptyList')}</div>
      ) : (
        <div className={styles.list}>
          {models.map((m) => {
            return (
              <div
                key={m.id}
                className={styles.card}
                title={`${m.name} · ${m.baseUrl} · ${
                  m.hasApiKey ? t('settings.models.apiKeySet') : t('settings.models.apiKeyNotSet')
                } · ${statusLabel(m.status, t)}`}
              >
                <div className={styles.cardMain}>
                  <div className={styles.cardTitleRow}>
                    <span className={styles.cardTitle}>{m.name}</span>
                    {!m.piProviderId && m.kind === 'custom' && (
                      <span className={styles.sourceBadge}>
                        {t('settings.models.sourceCustom')}
                      </span>
                    )}
                    {m.id === defaultId && (
                      <span className={styles.defaultBadge}>
                        {t('settings.models.defaultBadge')}
                      </span>
                    )}
                    <span
                      className={styles.statusDot}
                      data-status={m.status}
                      title={statusLabel(m.status, t)}
                    />
                  </div>
                </div>
                <div className={styles.cardActions}>
                  <button
                    type="button"
                    className={`${styles.textButton} ${styles.cardEditButton}`}
                    onClick={() => startEdit(m)}
                  >
                    {t('common.edit')}
                  </button>
                  {m.kind === 'custom' && (
                    <button
                      type="button"
                      className={styles.cardDeleteButton}
                      onClick={() => setDeletingId(m.id)}
                      aria-label={t('common.delete')}
                      title={t('common.delete')}
                    >
                      <TrashIcon size={15} />
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
}
