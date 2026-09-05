import type { KeyboardEvent, ReactNode, WheelEvent } from 'react';
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
  return (
    <div className={styles.settings}>
      <SettingRow title="权限" description="选择新会话的默认权限模式">
        <PermissionDropdown
          mode={permissionMode}
          onChange={onPermissionModeChange}
          ariaLabel="默认权限模式"
          placement="down"
        />
      </SettingRow>

      <SettingRow title="语言" className={styles.languageRow}>
        <div className={styles.selectWrap}>
          <select
            className={styles.select}
            value={language}
            onChange={(event) => onLanguageChange(event.target.value as LanguageMode)}
            aria-label="界面语言"
          >
            <option value="zh-CN">中文</option>
            <option value="en-US" disabled>
              English（即将支持）
            </option>
          </select>
          <ChevronDownIcon size={14} className={styles.selectChevron} />
        </div>
      </SettingRow>

      <AppearanceSettings mode={themeMode} onChange={onThemeModeChange} />

      <SettingRow title="字号大小" description="仅影响会话内容的字号">
        <fieldset className={styles.fontSizeControl} aria-label="会话字号">
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
      aria-label="会话字号"
      aria-valuemin={MIN_CONVERSATION_FONT_SIZE}
      aria-valuemax={MAX_CONVERSATION_FONT_SIZE}
      aria-valuenow={value}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      title="可使用鼠标滚轮或上下箭头调整字号"
    >
      <output className={styles.fontSizeValue}>{value}</output>
      <div className={styles.fontSizeArrows}>
        <button
          type="button"
          className={styles.fontSizeArrow}
          disabled={value >= MAX_CONVERSATION_FONT_SIZE}
          onClick={() => updateBy(1)}
          aria-label="增大字号"
        >
          <ChevronDownIcon size={12} className={styles.fontSizeArrowUp} />
        </button>
        <button
          type="button"
          className={styles.fontSizeArrow}
          disabled={value <= MIN_CONVERSATION_FONT_SIZE}
          onClick={() => updateBy(-1)}
          aria-label="减小字号"
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
