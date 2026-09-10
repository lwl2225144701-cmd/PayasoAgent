import type { KeyboardEvent, ReactNode, WheelEvent } from 'react';
import { useI18n } from '../../i18n';
import {
  type ConversationFontSize,
  type LanguageMode,
  MAX_CONVERSATION_FONT_SIZE,
  MIN_CONVERSATION_FONT_SIZE,
} from '../../preferences';
import type { ThemeMode } from '../../theme';
import type { PermissionMode } from '../../types';
import { AppearanceSettings } from '../AppearanceSettings';
import { ChevronDownIcon } from '../icons';
import { PermissionDropdown } from '../PermissionDropdown';
import styles from './GeneralSettings.module.css';

interface GeneralSettingsProps {
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  language: LanguageMode;
  onLanguageChange: (mode: LanguageMode) => void;
  fontSize: ConversationFontSize;
  onFontSizeChange: (size: ConversationFontSize) => void;
}

export function GeneralSettings({
  themeMode,
  onThemeModeChange,
  permissionMode,
  onPermissionModeChange,
  language,
  onLanguageChange,
  fontSize,
  onFontSizeChange,
}: GeneralSettingsProps) {
  const { t } = useI18n();
  return (
    <div className={styles.settings}>
      <SettingRow
        title={t('settings.general.permission')}
        description={t('settings.general.permissionDescription')}
      >
        <PermissionDropdown
          mode={permissionMode}
          onChange={onPermissionModeChange}
          ariaLabel={t('settings.general.permissionAria')}
          placement="down"
        />
      </SettingRow>

      <SettingRow title={t('settings.general.language')} className={styles.languageRow}>
        <div className={styles.selectWrap}>
          <select
            className={styles.select}
            value={language}
            onChange={(event) => onLanguageChange(event.target.value as LanguageMode)}
            aria-label={t('settings.general.languageAria')}
          >
            {/* i18n-exempt: 语言自称，英文界面下也显示「中文」 */}
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
          <ChevronDownIcon size={14} className={styles.selectChevron} />
        </div>
      </SettingRow>

      <AppearanceSettings mode={themeMode} onChange={onThemeModeChange} />

      <SettingRow
        title={t('settings.general.fontSize')}
        description={t('settings.general.fontSizeDescription')}
      >
        <fieldset
          className={styles.fontSizeControl}
          aria-label={t('settings.general.fontSizeAria')}
        >
          <FontSizeStepper value={fontSize} onChange={onFontSizeChange} />
          <span className={styles.fontSizeUnit}>px</span>
        </fieldset>
      </SettingRow>
    </div>
  );
}

function FontSizeStepper({
  value,
  onChange,
}: {
  value: ConversationFontSize;
  onChange: (size: ConversationFontSize) => void;
}) {
  const { t } = useI18n();
  const updateBy = (delta: number) => {
    const next = Math.min(
      MAX_CONVERSATION_FONT_SIZE,
      Math.max(MIN_CONVERSATION_FONT_SIZE, value + delta),
    );
    if (next !== value) onChange(next);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    updateBy(event.deltaY < 0 ? 1 : -1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      updateBy(1);
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      updateBy(-1);
    }
  };

  return (
    <div
      className={styles.fontSizeStepper}
      role="spinbutton"
      tabIndex={0}
      aria-label={t('settings.general.fontSizeAria')}
      aria-valuemin={MIN_CONVERSATION_FONT_SIZE}
      aria-valuemax={MAX_CONVERSATION_FONT_SIZE}
      aria-valuenow={value}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      title={t('settings.general.fontSizeTitle')}
    >
      <output className={styles.fontSizeValue}>{value}</output>
      <div className={styles.fontSizeArrows}>
        <button
          type="button"
          className={styles.fontSizeArrow}
          disabled={value >= MAX_CONVERSATION_FONT_SIZE}
          onClick={() => updateBy(1)}
          aria-label={t('settings.general.fontSizeIncrease')}
        >
          <ChevronDownIcon size={12} className={styles.fontSizeArrowUp} />
        </button>
        <button
          type="button"
          className={styles.fontSizeArrow}
          disabled={value <= MIN_CONVERSATION_FONT_SIZE}
          onClick={() => updateBy(-1)}
          aria-label={t('settings.general.fontSizeDecrease')}
        >
          <ChevronDownIcon size={12} />
        </button>
      </div>
    </div>
  );
}

function SettingRow({
  title,
  description,
  children,
  className = '',
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${styles.row} ${className}`}>
      <div className={styles.rowCopy}>
        <div className={styles.rowTitle}>{title}</div>
        {description && <div className={styles.rowDescription}>{description}</div>}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}
