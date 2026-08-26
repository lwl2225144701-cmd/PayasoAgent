import { useRef, type ReactNode } from 'react';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useClickOutside } from '../../hooks/useClickOutside';
import styles from './Modal.module.css';

interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  role?: string;
  ariaLabel?: string;
}

export function Modal({ children, onClose, role = 'dialog', ariaLabel }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEscapeKey(true, onClose);
  useClickOutside(ref, true, onClose);

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        ref={ref}
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role={role}
        aria-label={ariaLabel}
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}
