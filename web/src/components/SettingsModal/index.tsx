import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ConversationFontSize, LanguageMode } from '../../preferences';
import type { ThemeMode } from '../../theme';
import type { PermissionMode } from '../../types';
import { CloseIcon, DatabaseIcon, SettingsIcon, SlidersIcon, UserIcon } from '../icons';
import { Modal } from '../Modal';
import { ModelSyncDialog } from '../ModelSyncDialog';
import { GeneralTab } from './GeneralTab';
import { MAX_SYNC_MODELS } from './helpers';
import { ModelsTab } from './ModelsTab';
import styles from './SettingsModal.module.css';
import { useModelsSection } from './use-models-section';

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

/**
 * 设置弹窗外壳：左侧 tab 导航 + Modal 框架 + 两个页签（GeneralTab / ModelsTab）。
 * 模型页的全部状态与操作集中在 useModelsSection 里，经 props 下发给页签组件 ——
 * 它必须挂在本组件上，否则切 tab 会丢失进行到一半的表单。
 */
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
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const section = useModelsSection({ open, onSaved });
  const {
    deletingId,
    setDeletingId,
    confirmDelete,
    syncDialogOpen,
    syncCatalog,
    syncSelectedIds,
    syncError,
    syncResultModelCount,
    setSyncError,
    setSyncSelectedIds,
    setSyncDialogOpen,
    applySyncSelection,
  } = section;

  // 关闭时回到「通用」页（模型页状态由 useModelsSection / useModelSync 复位）
  useEffect(() => {
    if (!open) setActiveTab('general');
  }, [open]);

  const handleModalClose = () => {
    if (syncDialogOpen) {
      setSyncDialogOpen(false);
      return;
    }
    onClose();
  };

  return (
    <>
      <Modal onClose={handleModalClose} ariaLabel={t('settings.title')}>
        <div className={styles.container}>
          <div className={styles.header}>
            <h2 className={styles.title}>{t('settings.title')}</h2>
            <button
              type="button"
              className={styles.closeButton}
              onClick={handleModalClose}
              aria-label={t('common.close')}
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
                <span>{t('settings.tabs.general')}</span>
              </button>
              <button
                type="button"
                className={`${styles.navItem} ${activeTab === 'models' ? styles.navItemActive : ''}`}
                onClick={() => setActiveTab('models')}
              >
                <DatabaseIcon size={16} />
                <span>{t('settings.tabs.models')}</span>
              </button>
              <button
                type="button"
                className={`${styles.navItem} ${styles.navItemDisabled}`}
                disabled
              >
                <SlidersIcon size={16} />
                <span>{t('settings.tabs.plugins')}</span>
              </button>
              <button
                type="button"
                className={`${styles.navItem} ${styles.navItemDisabled}`}
                disabled
              >
                <UserIcon size={16} />
                <span>{t('settings.tabs.agentPresets')}</span>
              </button>
            </nav>
            <div className={styles.content}>
              {activeTab === 'general' ? (
                <GeneralTab
                  themeMode={themeMode}
                  onThemeModeChange={onThemeModeChange}
                  permissionMode={permissionMode}
                  onPermissionModeChange={onPermissionModeChange}
                  language={language}
                  onLanguageChange={onLanguageChange}
                  fontSize={fontSize}
                  onFontSizeChange={onFontSizeChange}
                />
              ) : (
                <ModelsTab section={section} language={language} />
              )}
            </div>
          </div>
        </div>

        {deletingId && (
          <button
            type="button"
            className={styles.confirmBackdrop}
            aria-label={t('settings.models.cancelDelete')}
            onClick={() => setDeletingId(null)}
          >
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: 确认容器仅用于阻止遮罩冒泡，键盘操作由内部"取消"按钮提供 */}
            <div
              className={styles.confirm}
              role="alertdialog"
              aria-modal="true"
              aria-label={t('settings.models.deleteConfirmAria')}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className={styles.confirmTitle}>{t('settings.models.deleteProvider')}</h3>
              <p className={styles.confirmText}>{t('settings.models.deleteConfirm')}</p>
              <div className={styles.confirmActions}>
                <button
                  type="button"
                  className={`${styles.primaryButton} ${styles.dangerButton}`}
                  onClick={confirmDelete}
                >
                  {t('common.delete')}
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => setDeletingId(null)}
                >
                  {t('common.cancel')}
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
        maxModels={MAX_SYNC_MODELS}
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
