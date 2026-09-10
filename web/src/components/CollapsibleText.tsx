import { type CSSProperties, memo, useState } from 'react';
import styles from './CollapsibleText.module.css';
import { MarkdownText } from './MarkdownText';

// 模型输出的 fenced code 常见三种畸形：
//   1. fence 标记拼在上一行行尾（如「### 标题 ```mermaid」）→ 解析不出代码块，源码漏成正文
//   2. fence 行尾带杂文（```mermaid 后面还跟了字）
//   3. 开合数量不成对 → 后续内容整体被吞进代码块
// 渲染前统一修复，让 GFM 解析器拿到规整输入。
export function normalizeFences(md: string): string {
  // 1. 行中出现的 ``` 标记推到独立行
  let out = md.replace(/([^\n`])(```+)/g, (_m, prev: string, fence: string) => `${prev}\n${fence}`);
  // 2. fence 行只保留语言标签（```lang 后面的杂文丢弃）
  out = out.replace(
    /^(```+)([\w+-]*)[ \t]+.*$/gm,
    (_m, fence: string, lang: string) => `${fence}${lang}`,
  );
  // 3. 奇数个 fence → 补一个闭合，解除"吞内容"级联
  const openings = (out.match(/^[ \t]*```/gm) ?? []).length;
  if (openings % 2 === 1) out += '\n```';
  return out;
}

interface CollapsibleTextProps {
  text: string;
  /** Render cheap plain text while an answer is still arriving over SSE. */
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
          // 流式中渲染轻量纯文本（pre-wrap 保留换行），不做 Markdown 解析。
          // 根因：react-markdown 每次渲染都对整条累计消息全量 runSync(parse)，
          // 每帧 text 都在变化，解析成本随长度线性上涨 → 16KB 时单帧已超预算。
          // 终态后由 settled 分支一次性解析（Mermaid/fence 也在那时处理）。
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{display}</div>
        ) : (
          <MarkdownText text={normalizeFences(display)} />
        )}
      </div>
      {maxChars > 0 && text.length > maxChars && (
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? '收起' : '显示更多'}
        </button>
      )}
    </div>
  );
});
