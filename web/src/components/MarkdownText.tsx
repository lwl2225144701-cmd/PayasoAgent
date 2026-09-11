import { isValidElement, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidBlock } from './MermaidBlock';
import styles from './markdown-body.module.css';
import { normalizeFences, splitStreamingMarkdown } from './streaming-markdown';

/**
 * 裸渲染器：只做 Markdown 解析与元素映射，不套容器。
 *
 * 之所以把「元素主题容器」和「解析」拆开：流式分块渲染需要把多个块放进**同一个**
 * `.markdownBody` 里。若每个块各套一层容器，`> :first-child{margin-top:0}` 与
 * `> :last-child{margin-bottom:0}` 会对每个块都生效，段间距会被整片吃掉。
 * 共用一个容器还能让流式与终态的 DOM 结构完全一致——定型瞬间不会因结构变化而重排。
 */
export const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  return (
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
  );
});

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
      <MarkdownContent text={text} />
    </div>
  );
});

/** 单个已定型块：先做 fence 修复再渲染。memo 让未变化的块连修复都跳过。 */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return <MarkdownContent text={normalizeFences(text)} />;
});

/**
 * 尾部逐帧解析的长度上界。
 *
 * 分块对「有空行的文本」几乎消除了解析成本（实测真实语料降 96.8%），但有一类内容
 * 无法分块：GFM 表格、以及任何不含空行的超长块——它们在定型前始终是尾部，只能整段
 * 重解析。实测 10KB 表格 12.4ms/帧（改善仅 1.0x），在快模型/回放场景下会掉帧。
 *
 * 因此给尾部长度设硬上界：超限就退化为纯文本渲染，等它被空行定型后再按 Markdown
 * 渲染。正常回复的单块远小于此值（代码块另有 openFence 通道，不参与解析），
 * 只有病态的巨型单块才会命中降级。
 */
const TAIL_PARSE_LIMIT = 6000;

/**
 * 流式 Markdown：实时渲染 Markdown，同时把每帧成本限制在尾部。
 *
 * 累计文本被切成「已定型块 + 仍在写入的尾部」（见 streaming-markdown.ts）：
 * - 已定型块交给 memo 化的 MarkdownBlock —— 文本不变则整个解析被跳过；
 * - 每帧只重解析尾部，因此成本与累计长度无关，只与「当前正在写的那一段」有关；
 * - 尾部停在未闭合 fence 内时按纯源码渲染成代码块，避免把流到一半的 mermaid
 *   当成完整图表去渲染（那会必然报语法错并闪烁）；
 * - 尾部超过 TAIL_PARSE_LIMIT 时退化为纯文本，保证单帧成本有上界。
 *
 * 代价只有每帧一次 O(全文) 的字符扫描（无正则、无解析），比全量 parse 便宜两个数量级。
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  const { blocks, tail, openFence } = splitStreamingMarkdown(text);
  return (
    <div className={styles.markdownBody}>
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 块列表只追加、数量不回退，下标即稳定身份；用块文本作 key 会被重复段落撞成重复 key
        <MarkdownBlock key={index} text={block} />
      ))}
      {tail ? (
        tail.length > TAIL_PARSE_LIMIT ? (
          <div className={styles.plainTail}>{tail}</div>
        ) : (
          <MarkdownBlock text={tail} />
        )
      ) : null}
      {openFence ? (
        <pre>
          <code>{openFence}</code>
        </pre>
      ) : null}
    </div>
  );
});
