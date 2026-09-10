import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/messages';
import type { ThemeMode } from '../../theme';
import { MonitorIcon, MoonIcon, SunIcon } from '../icons';
import styles from './AppearanceSettings.module.css';

interface AppearanceSettingsProps {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}

interface ThemeOption {
  mode: ThemeMode;
  labelKey: MessageKey;
  icon: ReactNode;
}

const THEME_OPTIONS: ThemeOption[] = [
  { mode: 'light', labelKey: 'settings.appearance.light', icon: <SunIcon size={20} /> },
  { mode: 'dark', labelKey: 'settings.appearance.dark', icon: <MoonIcon size={20} /> },
  { mode: 'system', labelKey: 'settings.appearance.system', icon: <MonitorIcon size={20} /> },
];

export function AppearanceSettings({ mode, onChange }: AppearanceSettingsProps) {
  const { t } = useI18n();
  return (
    <section className={styles.section} aria-labelledby="appearance-settings-title">
      <div className={styles.header}>
        <h3 id="appearance-settings-title" className={styles.title}>
          {t('settings.appearance.title')}
        </h3>
      </div>
      <div
        className={styles.options}
        role="radiogroup"
        aria-label={t('settings.appearance.themeModeAria')}
      >
        {THEME_OPTIONS.map((option) => {
          const selected = option.mode === mode;
          return (
            <button
              key={option.mode}
              type="button"
              className={`${styles.option} ${selected ? styles.optionSelected : ''}`}
              aria-checked={selected}
              // biome-ignore lint/a11y/useSemanticElements: 自绘主题单选组（radiogroup），button+role=radio 为 WAI-ARIA 合法实现
              role="radio"
              onClick={() => onChange(option.mode)}
            >
              <span className={styles.icon}>{option.icon}</span>
              <span className={styles.label}>{t(option.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
