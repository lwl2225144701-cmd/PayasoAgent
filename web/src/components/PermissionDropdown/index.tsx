import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n';
import { portalRoot } from '../../portal-root';
import type { PermissionMode } from '../../types';
import { DropdownTrigger } from '../DropdownTrigger';
import { CheckIcon, CloseIcon } from '../icons';
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
  const [confirming, setConfirming] = useState(false);
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

  const cancelFullAccess = useCallback(() => setConfirming(false), []);
  const confirmFullAccess = useCallback(() => {
    onChange('full-access');
    setConfirming(false);
  }, [onChange]);

  const select = (next: PermissionMode) => {
    if (next === 'full-access' && mode !== 'full-access') {
      setOpen(false);
      setConfirming(true);
      return;
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
      {confirming && (
        <FullAccessConfirm onConfirm={confirmFullAccess} onCancel={cancelFullAccess} />
      )}
    </div>
  );
}

function FullAccessConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmButtonRef.current?.focus();
  }, []);

  // 原生监听停在遮罩上：设置弹窗的“点外部关闭”挂在 document 冒泡阶段，
  // React 的 stopPropagation 拦不住同一节点上的原生监听。
  useEffect(() => {
    const node = backdropRef.current;
    if (!node) return;
    const stop = (event: Event) => event.stopPropagation();
    node.addEventListener('pointerdown', stop);
    node.addEventListener('mousedown', stop);
    return () => {
      node.removeEventListener('pointerdown', stop);
      node.removeEventListener('mousedown', stop);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = [
        ...root.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  return createPortal(
    <div ref={backdropRef} className={styles.confirmBackdrop}>
      <button
        type="button"
        className={styles.confirmScrim}
        aria-label={t('widgets.modal.closeDialog')}
        tabIndex={-1}
        onClick={onCancel}
      />
      <div
        ref={dialogRef}
        className={styles.confirm}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={styles.confirmHeader}>
          <h2 id={titleId} className={styles.confirmTitle}>
            {t('settings.permission.fullAccessConfirmTitle')}
          </h2>
          <button
            type="button"
            className={styles.confirmClose}
            onClick={onCancel}
            aria-label={t('common.close')}
          >
            <CloseIcon size={16} />
          </button>
        </div>
        <p className={styles.confirmBody}>{t('settings.permission.fullAccessConfirm')}</p>
        <p className={styles.confirmAsk}>{t('settings.permission.fullAccessConfirmAsk')}</p>
        <div className={styles.confirmActions}>
          <button
            ref={confirmButtonRef}
            type="button"
            className={styles.confirmPrimary}
            onClick={onConfirm}
          >
            {t('common.ok')}
          </button>
          <button type="button" className={styles.confirmSecondary} onClick={onCancel}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>,
    portalRoot(),
  );
}
