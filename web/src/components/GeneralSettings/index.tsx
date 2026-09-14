import { useEffect, useState, type KeyboardEvent, type ReactNode, type WheelEvent } from 'react';
import { fetchShellIsolation } from '../../api';
import { useI18n } from '../../i18n';
import {
  type ConversationFontSize,
  type LanguageMode,
  MAX_CONVERSATION_FONT_SIZE,
  MIN_CONVERSATION_FONT_SIZE,
} from '../../preferences';
import type { ThemeMode } from '../../theme';
import type { PermissionMode, ShellIsolationCapabilities } from '../../types';
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

      <ShellIsolationRow />

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

/**
 * Shell 隔离能力行：展示当前平台的执行器与隔离完整度（诚实分级）。
 * partial（Windows ACL）必须可见——写入部分隔离、读与网络不受限、
 * workspace-write 会在工作区留下持续性授权 ACE。
 */
function ShellIsolationRow() {
  const { t } = useI18n();
  const [info, setInfo] = useState<ShellIsolationCapabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchShellIsolation()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch(() => {
        /* Host 未返回能力报告时保持占位（不可用信息不猜测） */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const executorLabel = (executor: ShellIsolationCapabilities['executor']): string =>
    executor === 'macos-seatbelt'
      ? t('settings.shellIsolation.executor.macosSeatbelt')
      : executor === 'windows-acl'
        ? t('settings.shellIsolation.executor.windowsAcl')
        : t('settings.shellIsolation.executor.uncontainedGated');

  const description =
    info === null
      ? t('settings.shellIsolation.loading')
      : info.enforcement === 'full'
        ? t('settings.shellIsolation.fullNote')
        : info.enforcement === 'partial'
          ? t('settings.shellIsolation.partialCaveat')
          : t('settings.shellIsolation.noneNote');

  return (
    <SettingRow
      title={t('settings.shellIsolation.title')}
      description={
        <>
          <div>{description}</div>
          {info?.enforcement === 'partial' && (
            <div>{t('settings.shellIsolation.standingAceNote')}</div>
          )}
          {info?.networkIsolation === 'none' && info?.enforcement !== 'none' && (
            <div>{t('settings.shellIsolation.networkNote')}</div>
          )}
        </>
      }
    >
      <span className={styles.shellIsolationValue}>
        {info === null ? '—' : executorLabel(info.executor)}
      </span>
    </SettingRow>
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
  description?: ReactNode;
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
