import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { PiAiProviderInfo } from '../../types';
import { ChevronDownIcon } from '../icons';
import styles from './SettingsModal.module.css';

/** 内置（pi-ai）Provider 下拉选择器：点击外部 / Esc 关闭，选项带模型数量。 */
export function ProviderPicker({
  providers,
  value,
  loading,
  onChange,
}: {
  providers: PiAiProviderInfo[];
  value: string;
  loading: boolean;
  onChange: (providerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const selected = providers.find((provider) => provider.id === value);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className={styles.providerPicker} ref={pickerRef}>
      <button
        type="button"
        className={styles.providerPickerTrigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={loading}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          className={selected ? styles.providerPickerSelected : styles.providerPickerPlaceholder}
        >
          {selected?.name ??
            (loading ? t('settings.models.loadingProviders') : t('settings.models.chooseProvider'))}
        </span>
        <ChevronDownIcon size={15} />
      </button>
      {open && (
        <div
          className={styles.providerPickerMenu}
          role="listbox"
          aria-label={t('settings.models.builtinProvider')}
        >
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              role="option"
              aria-selected={provider.id === value}
              className={styles.providerPickerOption}
              onClick={() => {
                onChange(provider.id);
                setOpen(false);
              }}
            >
              <span className={styles.providerPickerName}>{provider.name}</span>
              <span className={styles.providerPickerMeta}>
                {provider.id} · {t('settings.models.modelCount', { count: provider.models.length })}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
