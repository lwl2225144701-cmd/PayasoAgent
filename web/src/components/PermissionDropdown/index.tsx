import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { PermissionMode } from '../../types';
import { DropdownTrigger } from '../DropdownTrigger';
import { CheckIcon } from '../icons';
import styles from './PermissionDropdown.module.css';

const PERMISSION_OPTIONS: Array<{ mode: PermissionMode; label: string }> = [
  { mode: 'read-only', label: 'Read Only' },
  { mode: 'workspace-write', label: 'Workspace Write' },
  { mode: 'full-access', label: 'Full access' },
];

interface PermissionDropdownProps {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  ariaLabel?: string;
  placement?: 'up' | 'down';
}

export function PermissionDropdown({
  mode,
  onChange,
  ariaLabel,
  placement = 'up',
}: PermissionDropdownProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const current =
    PERMISSION_OPTIONS.find((option) => option.mode === mode) ?? PERMISSION_OPTIONS[1];

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const select = (next: PermissionMode) => {
    if (next === 'full-access' && mode !== 'full-access') {
      const confirmed = window.confirm(t('settings.permission.fullAccessConfirm'));
      if (!confirmed) return;
    }
    onChange(next);
    setOpen(false);
  };

  return (
    <div className={styles.root} ref={containerRef} data-open={open || undefined}>
      <DropdownTrigger
        label={current.label}
        ariaLabel={t('settings.permission.ariaFor', { label: current.label })}
        title={t('settings.permission.currentTitle', { label: current.label })}
        danger={mode === 'full-access'}
        open={open}
        onClick={() => setOpen((value) => !value)}
      />

      {open && (
        <div
          className={`${styles.menu} ${placement === 'down' ? styles.menuDown : ''}`}
          role="listbox"
          aria-label={ariaLabel ?? t('settings.permission.filesystemAria')}
        >
          {PERMISSION_OPTIONS.map((option) => {
            const selected = mode === option.mode;
            return (
              <button
                key={option.mode}
                type="button"
                className={`${styles.item} ${selected ? styles.itemSelected : ''} ${option.mode === 'full-access' ? styles.itemDanger : ''}`}
                role="option"
                aria-selected={selected}
                onClick={() => select(option.mode)}
              >
                <span>{option.label}</span>
                {selected && <CheckIcon size={19} className={styles.itemCheck} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
