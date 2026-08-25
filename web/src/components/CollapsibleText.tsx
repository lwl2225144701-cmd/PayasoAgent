import { Fragment, type CSSProperties, type ReactNode, useState } from 'react';
import styles from './CollapsibleText.module.css';

interface CollapsibleTextProps {
  text: string;
  /** Max visible characters before collapse threshold kicks in. */
  maxChars?: number;
  /** Max visible lines (CSS clamp fallback). */
  maxLinesSoft?: number;
}

/**
 * Renders long text with a "显示更多" (show more) footer when it exceeds `maxChars`.
 * Preserves whitespace and line breaks.
 */
export function CollapsibleText({ text, maxChars = 800, maxLinesSoft }: CollapsibleTextProps) {
  const [open, setOpen] = useState(false);
  const clamped = !open && text.length > maxChars;
  const display = clamped ? `${text.slice(0, maxChars)}…` : text;
  const lineClampStyle: CSSProperties | undefined =
    !open && maxLinesSoft
      ? {
          display: '-webkit-box',
          WebkitLineClamp: maxLinesSoft,
          WebkitBoxOrient: 'vertical' as const,
          overflow: 'hidden',
        }
      : undefined;

  return (
    <div className={styles.root}>
      <div className={styles.text} style={lineClampStyle}>{renderInlineMarkdown(display)}</div>
      {text.length > maxChars && (
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
        >
          {open ? '收起' : '显示更多'}
        </button>
      )}
    </div>
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code className={styles.inlineCode} key={index}>{part.slice(1, -1)}</code>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}
