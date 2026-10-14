// ImageLightbox：文档级原图预览（对齐 DSH 的 ImageLightbox）。
//
// 铺满视口的遮罩 + 居中原图：只做「适配视口」——max-width min(100%, 1600px)、
// max-height calc(100vh - 80px)、object-fit: contain，**不放大、不裁切**。
// 关法三种：Esc、点遮罩、点右上角关闭钮；关闭后把焦点还给打开者。
// 无缩放、无下载按钮 —— 与 DSH 明说的边界一致（要原件可以右键/新标签页）。
//
// portal 到 portalRoot()：index.css 把 body 直接子元素 display:none，
// 挂在组件树里会被误伤（与 Timeline 的 Modal 同因）。
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useI18n } from '../../i18n';
import { portalRoot } from '../../portal-root';
import { CloseIcon } from '../icons';
import styles from './ImageLightbox.module.css';

export interface ImageLightboxProps {
  /** 原图地址（与缩略图同一个 loader URL，即归一化后的存储版本）。 */
  src: string;
  /** 文件名（无障碍名 / alt）。 */
  name: string;
  onClose: () => void;
}

export function ImageLightbox({ src, name, onClose }: ImageLightboxProps) {
  const { t } = useI18n();
  useEscapeKey(true, onClose);

  // 焦点还给打开者：挂载时记下当时的 activeElement，卸载时还原。
  // 灯箱是"看一眼就关"的临时层，不还焦点的话键盘用户会被扔回文档开头。
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => opener?.focus();
  }, []);

  return createPortal(
    <div className={styles.root} role="dialog" aria-modal="true" aria-label={name}>
      {/* 遮罩即关闭目标。用 button 而不是裸 div：它本来就是"可点的关闭区域"，
          button 天然带键盘可达性与 role，视觉上仍是铺满的一层（见 CSS reset）。 */}
      <button
        type="button"
        className={styles.mask}
        onClick={onClose}
        aria-label={t('common.close')}
        tabIndex={-1}
      />
      <img className={styles.image} src={src} alt={name} />
      <button
        type="button"
        className={styles.close}
        onClick={onClose}
        title={t('common.close')}
        aria-label={t('common.close')}
      >
        <CloseIcon size={16} />
      </button>
    </div>,
    portalRoot(),
  );
}
