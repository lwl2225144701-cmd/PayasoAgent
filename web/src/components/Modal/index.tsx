import { type ReactNode, useRef } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import styles from './Modal.module.css';

interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  ariaLabel?: string;
}

export function Modal({ children, onClose, ariaLabel }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEscapeKey(true, onClose);
  useClickOutside(ref, true, onClose);

  return (
    <button type="button" className={styles.backdrop} aria-label="关闭对话框" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 对话框容器仅用于阻止遮罩冒泡，键盘关闭由 useEscapeKey 全局提供 */}
      <div
        ref={ref}
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={ariaLabel}
        aria-modal="true"
      >
        {children}
      </div>
    </button>
  );
}
