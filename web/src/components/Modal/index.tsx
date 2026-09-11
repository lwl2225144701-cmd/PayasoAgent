import { type ReactNode, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useI18n } from '../../i18n';
import { portalRoot } from '../../portal-root';
import styles from './Modal.module.css';

interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  ariaLabel?: string;
  width?: string;
  height?: string;
}

export function Modal({ children, onClose, ariaLabel, width, height }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  useEscapeKey(true, onClose);
  useClickOutside(ref, true, onClose);

  // 必须 portal：模态会被渲染在任意容器里（例如 FileModal 在 Timeline 内部），
  // 而 App 的 `.main > *` 规则给每个直接子元素都加了 `position: relative; z-index: 1`
  // —— 每个都成了层叠上下文。模态的 z-index 被关在那个上下文里，永远赢不过文档序
  // 更靠后的兄弟节点（输入栏），于是被压在下面。portal 让它跳出所有祖先层叠上下文。
  //
  // ⚠️ 目标必须是 portalRoot() 而**不是** document.body —— 见 portal-root.ts 的说明。
  return createPortal(
    <button
      type="button"
      className={styles.backdrop}
      aria-label={t('widgets.modal.closeDialog')}
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 对话框容器仅用于阻止遮罩冒泡，键盘关闭由 useEscapeKey 全局提供 */}
      <div
        ref={ref}
        className={styles.modal}
        style={width || height ? { width, height } : undefined}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={ariaLabel}
        aria-modal="true"
      >
        {children}
      </div>
    </button>,
    portalRoot(),
  );
}
