import { useI18n } from '../../i18n';
import { translate } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
import type { ProviderModelInfo } from '../../types';
import styles from './ModelSyncDialog.module.css';

interface ModelSyncDialogProps {
  open: boolean;
  models: ProviderModelInfo[];
  selectedIds: string[];
  resultModelCount: number;
  maxModels: number;
  error?: string | null;
  onToggle: (modelId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function formatContextWindow(value: number | undefined, language: LanguageMode): string | null {
  if (value === undefined) return null;
  if (value >= 1_000_000) {
    return translate(language, 'settings.sync.contextWindowM', {
      value: (value / 1_000_000).toFixed(1),
    });
  }
  if (value >= 1_000) {
    return translate(language, 'settings.sync.contextWindowK', {
      value: Math.round(value / 1_000),
    });
  }
  return translate(language, 'settings.sync.contextWindowTokens', { value });
}

export function ModelSyncDialog({
  open,
  models,
  selectedIds,
  resultModelCount,
  maxModels,
  error,
  onToggle,
  onSelectAll,
  onClearAll,
  onCancel,
  onConfirm,
}: ModelSyncDialogProps) {
  const { t, language } = useI18n();
  if (!open) return null;

  const selectedCount = selectedIds.length;
  const allSelected = selectedCount === models.length;

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 遮罩用于承接点击关闭，键盘关闭由 Escape 处理 */}
      <div
        className={styles.backdrop}
        role="presentation"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onCancel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      >
        <div
          className={styles.dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby="model-sync-title"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onCancel();
              return;
            }
            event.stopPropagation();
          }}
        >
          <div className={styles.header}>
            <div>
              <h2 id="model-sync-title" className={styles.title}>
                {t('settings.sync.title')}
              </h2>
              <p className={styles.subtitle}>
                {t('settings.sync.subtitle', { count: models.length })}
              </p>
            </div>
            <button
              type="button"
              className={styles.closeButton}
              onClick={onCancel}
              aria-label={t('common.close')}
            >
              ×
            </button>
          </div>

          <div className={styles.toolbar}>
            <span className={styles.count}>
              {t('settings.sync.selectedLabel')} <strong>{selectedCount}</strong> / {models.length}
            </span>
            <div className={styles.toolbarActions}>
              <button
                type="button"
                className={styles.textButton}
                onClick={onSelectAll}
                disabled={allSelected}
              >
                {t('settings.sync.selectAll')}
              </button>
              <button
                type="button"
                className={styles.textButton}
                onClick={onClearAll}
                disabled={selectedCount === 0}
              >
                {t('settings.sync.clearAll')}
              </button>
            </div>
          </div>

          <div className={styles.list}>
            {models.map((model) => {
              const checked = selectedIds.includes(model.id);
              const contextWindow = formatContextWindow(model.contextWindow, language);
              return (
                <label
                  key={model.id}
                  className={`${styles.item} ${checked ? styles.itemChecked : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => onToggle(model.id, event.target.checked)}
                  />
                  <span className={styles.itemBody}>
                    <span className={styles.modelId}>{model.id}</span>
                    <span className={styles.meta}>
                      {contextWindow ?? t('settings.sync.contextWindowMissing')}
                      {model.vision ? ` · ${t('settings.sync.vision')}` : ''}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <div
            className={`${styles.summary} ${resultModelCount > maxModels ? styles.summaryWarning : ''}`}
          >
            {resultModelCount > maxModels
              ? t('settings.sync.overLimit', { count: resultModelCount, max: maxModels })
              : t('settings.sync.willKeep', { count: resultModelCount })}
          </div>
          {error && <div className={styles.error}>{error}</div>}

          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={onCancel}>
              {t('common.cancel')}
            </button>
            <button type="button" className={styles.primaryButton} onClick={onConfirm}>
              {t('settings.sync.confirm')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
