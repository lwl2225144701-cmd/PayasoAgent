import { type CSSProperties, memo, useState } from 'react';
import { useI18n } from '../i18n';
import styles from './CollapsibleText.module.css';
import { MarkdownText, StreamingMarkdown } from './MarkdownText';
import { normalizeFences } from './streaming-markdown';

interface CollapsibleTextProps {
  text: string;
  /** 文本仍在流式写入：走分块增量渲染（实时 Markdown，成本限制在尾部）。 */
  streaming?: boolean;
  /** Max visible characters before collapse threshold kicks in. */
  maxChars?: number;
  /** Max visible lines (CSS clamp fallback). */
  maxLinesSoft?: number;
}

/**
 * Renders long text with a "显示更多" (show more) footer when it exceeds `maxChars`.
 * Preserves whitespace and line breaks.
 */
export const CollapsibleText = memo(function CollapsibleText({
  text,
  streaming = false,
  maxChars = 0,
  maxLinesSoft,
}: CollapsibleTextProps) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
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
        {streaming ? (
          // 流式中实时渲染 Markdown：按「已定型块 + 尾部」分块，块级 memo 掉解析，
          // 每帧只重解析仍在写入的尾部 —— 成本与累计长度无关（详见 StreamingMarkdown）。
          // 这里不做 fence 修复：修复由 MarkdownBlock 逐块施加（尾部的未闭合 fence
          // 必须保持原样，否则会被当成完整图表渲染）。
          <StreamingMarkdown text={display} />
        ) : (
          <MarkdownText text={normalizeFences(display)} modelOutput />
        )}
      </div>
      {maxChars > 0 && text.length > maxChars && (
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? t('common.collapse') : t('widgets.collapsibleText.showMore')}
        </button>
      )}
    </div>
  );
});
