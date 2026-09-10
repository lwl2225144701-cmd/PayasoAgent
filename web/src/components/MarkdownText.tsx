import { isValidElement, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidBlock } from './MermaidBlock';
import styles from './markdown-body.module.css';

/**
 * 聊天内 Markdown 的唯一渲染入口：助手正文、思考可见段与用户消息共用。
 *
 * 职责边界：
 * - 这里只管「怎么解析 + 元素怎么映射」：remark-gfm（表格/删除线/任务列表）、
 *   链接新窗口打开、```mermaid 渲染成矢量图，并挂上共享的元素主题
 *   （markdown-body.module.css：段落/标题/列表/代码块/表格的间距与配色）。
 * - 排版容器（文档流、用户气泡、字号、行高、换行与对齐策略）由调用方自己的
 *   CSS 决定 —— 气泡和文档流该长得不一样，不该在这里分叉。
 * - 畸形 fence 修复（normalizeFences）是面向模型输出的输入预处理，属于调用方：
 *   用户手打的文本不该被那套"修复"改写。
 *
 * memo：react-markdown 每次渲染都会对整条文本全量 parse。Run 运行期 Timeline
 * 每秒 tick 一次，text 未变时必须跳过重解析（用户消息文本终身不变，收益更直接）。
 */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className={styles.markdownBody}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          // ```mermaid 代码块 → 聊天内渲染成矢量图（剥掉外层 <pre>）
          pre: ({ node, children, ...props }) => {
            const first = Array.isArray(children) ? children[0] : children;
            const className = isValidElement<{ className?: string }>(first)
              ? first.props.className
              : undefined;
            if (className && /language-mermaid\b/.test(className)) {
              return <>{children}</>;
            }
            return <pre {...props}>{children}</pre>;
          },
          code: ({ node, className, children, ...props }) => {
            if (className && /language-mermaid\b/.test(className)) {
              return <MermaidBlock chart={String(children).replace(/\n$/, '')} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
