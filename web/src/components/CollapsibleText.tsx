import { type CSSProperties, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
export function CollapsibleText({ text, maxChars = 0, maxLinesSoft }: CollapsibleTextProps) {
  const [open, setOpen] = useState(false);
  const clamped = maxChars > 0 && !open && text.length > maxChars;
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
      <div className={styles.text} style={lineClampStyle}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, ...props }) => (
              <a {...props} target="_blank" rel="noreferrer">{children}</a>
            ),
          }}
        >
          {display}
        </ReactMarkdown>
      </div>
      {maxChars > 0 && text.length > maxChars && (
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
