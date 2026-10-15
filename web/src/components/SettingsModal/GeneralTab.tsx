import type { ConversationFontSize, LanguageMode } from '../../preferences';
import type { ThemeMode } from '../../theme';
import type { PermissionMode } from '../../types';
import { GeneralSettings } from '../GeneralSettings';
import styles from './SettingsModal.module.css';

interface GeneralTabProps {
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  language: LanguageMode;
  onLanguageChange: (mode: LanguageMode) => void;
  fontSize: ConversationFontSize;
  onFontSizeChange: (size: ConversationFontSize) => void;
}

/** 设置弹窗的「通用」页：权限、语言、外观、字号（字段本体在 GeneralSettings）。 */
export function GeneralTab({
  themeMode,
  onThemeModeChange,
  permissionMode,
  onPermissionModeChange,
  language,
  onLanguageChange,
  fontSize,
  onFontSizeChange,
}: GeneralTabProps) {
  return (
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
}
