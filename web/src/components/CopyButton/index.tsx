import { useCallback, useState } from 'react';
import { CheckIcon, CopyIcon } from '../icons';
import styles from './CopyButton.module.css';

interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  title?: string;
}

export function CopyButton({
  text,
  label = '复制',
  copiedLabel = '已复制',
  title = '复制',
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

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
      title={title}
    >
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      <span>{copied ? copiedLabel : label}</span>
    </button>
  );
}
