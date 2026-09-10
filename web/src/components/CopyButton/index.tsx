import { useCallback, useState } from 'react';
import { useI18n } from '../../i18n';
import { CheckIcon, CopyIcon } from '../icons';
import styles from './CopyButton.module.css';

interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  title?: string;
}

export function CopyButton({ text, label, copiedLabel, title }: CopyButtonProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  // 默认文案跟随界面语言；显式传入的 label/copiedLabel/title 优先（行为不变）。
  const labelText = label ?? t('common.copy');
  const copiedText = copiedLabel ?? t('common.copied');
  const titleText = title ?? t('common.copy');

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
      className={`${styles.copyButton} ${copied ? styles.copied : ''}`}
      onClick={handleCopy}
      title={titleText}
    >
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      <span>{copied ? copiedText : labelText}</span>
    </button>
  );
}
