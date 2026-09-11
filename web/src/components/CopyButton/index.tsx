import { useCallback, useState } from 'react';
import { useI18n } from '../../i18n';
import { CheckIcon, CopyIcon } from '../icons';
import styles from './CopyButton.module.css';

interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  title?: string;
  /**
   * 只显示图标，不显示文字（用于消息页脚这类空间紧张、需要低调的位置）。
   * 文案改为通过 title / aria-label 提供，保证可访问性不因「去掉可见文字」而丢失。
   */
  iconOnly?: boolean;
}

export function CopyButton({ text, label, copiedLabel, title, iconOnly = false }: CopyButtonProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  // 默认文案跟随界面语言；显式传入的 label/copiedLabel/title 优先（行为不变）。
  const labelText = label ?? t('common.copy');
  const copiedText = copiedLabel ?? t('common.copied');
  const stateText = copied ? copiedText : labelText;
  // 图标模式下没有可见文字，改用「复制/已复制」作为提示与无障碍名称；
  // 显式传入 title 时优先（与 iconOnly 之前的语义保持一致）。
  const titleText = title ?? (iconOnly ? stateText : labelText);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [text]);

  return (
    <button
      type="button"
      className={`${styles.copyButton} ${copied ? styles.copied : ''} ${iconOnly ? styles.iconOnly : ''}`}
      onClick={handleCopy}
      title={titleText}
      aria-label={iconOnly ? stateText : undefined}
    >
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      {!iconOnly && <span>{stateText}</span>}
    </button>
  );
}
