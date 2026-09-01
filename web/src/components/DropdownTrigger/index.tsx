import type { ReactNode } from 'react';
import { ChevronDownIcon } from '../icons';
import styles from './DropdownTrigger.module.css';

interface DropdownTriggerProps {
  label: ReactNode;
  ariaLabel: string;
  open: boolean;
  onClick: () => void;
  title?: string;
  danger?: boolean;
}

export function DropdownTrigger({
  label,
  ariaLabel,
  open,
  onClick,
  title,
  danger = false,
}: DropdownTriggerProps) {
  return (
    <button
      type="button"
      className={`${styles.trigger} ${danger ? styles.triggerDanger : ''}`}
      title={title}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={onClick}
    >
      <span>{label}</span>
      <ChevronDownIcon size={14} className={styles.triggerChevron} />
    </button>
  );
}
