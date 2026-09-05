import type { ReactNode } from 'react';
import type { ThemeMode } from '../../theme';
import { MonitorIcon, MoonIcon, SunIcon } from '../icons';
import styles from './AppearanceSettings.module.css';

interface AppearanceSettingsProps {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}

interface ThemeOption {
  mode: ThemeMode;
  label: string;
  icon: ReactNode;
}

const THEME_OPTIONS: ThemeOption[] = [
  { mode: 'light', label: '浅色', icon: <SunIcon size={20} /> },
  { mode: 'dark', label: '深色', icon: <MoonIcon size={20} /> },
  { mode: 'system', label: '跟随系统', icon: <MonitorIcon size={20} /> },
];

export function AppearanceSettings({ mode, onChange }: AppearanceSettingsProps) {
  return (
    <section className={styles.section} aria-labelledby="appearance-settings-title">
      <div className={styles.header}>
        <h3 id="appearance-settings-title" className={styles.title}>
          外观
        </h3>
      </div>
      <div className={styles.options} role="radiogroup" aria-label="主题模式">
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
              <span className={styles.label}>{option.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
