import { useEffect, useId, useRef, useState } from 'react';
import { readThemeMode, resolveThemeMode } from '../../theme';
import styles from './MermaidBlock.module.css';

// 聊天内 Mermaid 渲染：```mermaid 代码块 → 矢量图（主题自适应，懒加载）。
// mermaid 体积大（~1MB），通过动态 import 拆成独立 chunk，只有真的出现
// mermaid 图时才下载；普通对话零开销。
// 失败必须自诊断可见：chunk 加载失败（页面版本过期）/ 语法错误 / 超时三类，
// 都落到可读的回退视图，绝不允许永远停在加载态。

type MermaidApi = typeof import('mermaid')['default'];

let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((m) => m.default)
      .catch((err) => {
        // 失败不缓存：刷新/热更后允许重试
        mermaidPromise = null;
        throw err;
      });
  }
  return mermaidPromise;
}

function currentDark(): boolean {
  return resolveThemeMode(readThemeMode()) === 'dark';
}

const RENDER_TIMEOUT_MS = 15_000;

const MERMAID_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

function mermaidThemeVariables(dark: boolean, fontSize: number) {
  return dark
    ? {
        background: '#10141b',
        primaryColor: '#1f2d43',
        primaryTextColor: '#f3f6fb',
        primaryBorderColor: '#5f8fff',
        secondaryColor: '#1b3440',
        secondaryTextColor: '#f3f6fb',
        secondaryBorderColor: '#4fd1a5',
        tertiaryColor: '#252b3a',
        tertiaryTextColor: '#f3f6fb',
        tertiaryBorderColor: '#8ca4c7',
        lineColor: '#a8b9d2',
        textColor: '#f3f6fb',
        titleColor: '#f3f6fb',
        clusterBkg: '#182333',
        clusterBorder: '#405474',
        edgeLabelBackground: '#121b2b',
        fontFamily: MERMAID_FONT_FAMILY,
        fontSize: `${fontSize}px`,
      }
    : {
        background: '#f4f6fa',
        primaryColor: '#ffffff',
        primaryTextColor: '#1c2535',
        primaryBorderColor: '#426bd8',
        secondaryColor: '#edf8f4',
        secondaryTextColor: '#1c2535',
        secondaryBorderColor: '#168a68',
        tertiaryColor: '#eef1f6',
        tertiaryTextColor: '#1c2535',
        tertiaryBorderColor: '#64748b',
        lineColor: '#526174',
        textColor: '#1c2535',
        titleColor: '#1c2535',
        clusterBkg: '#e8eef8',
        clusterBorder: '#92a8ca',
        edgeLabelBackground: '#ffffff',
        fontFamily: MERMAID_FONT_FAMILY,
        fontSize: `${fontSize}px`,
      };
}

/**
 * Make common LLM-generated flowchart labels valid Mermaid syntax.
 *
 * Models often emit `\\n` for a line break inside an unquoted node label,
 * e.g. `UI[React Web UI\\n(web/)]`. Mermaid expects HTML breaks and treats
 * parentheses as shape syntax unless the label is quoted.
 */
export function normalizeMermaidChart(chart: string, stackWideChart = false): string {
  const normalizedBreaks = chart
    .replace(/\r\n?/g, '\n')
    .replace(/(?:\\r)?\\n/g, '<br/>')
    .replace(/\\t/g, ' ');
  const responsiveChart = stackWideChart
    ? normalizedBreaks.replace(/^(\s*(?:flowchart|graph)\s+)(?:LR|RL)\b/m, '$1TD')
    : normalizedBreaks;

  return responsiveChart
    .split('\n')
    .map((line) =>
      line.replace(
        /(^|[^\w-])([A-Za-z_][\w-]*)\[([^\]\r\n]*)\]/g,
        (_match, prefix: string, nodeId: string, label: string) => {
          const trimmed = label.trim();
          if (!trimmed || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
            return `${prefix}${nodeId}[${label}]`;
          }
          // Mermaid supports entity codes inside quoted labels, which keeps
          // model-generated quotes from prematurely closing the node label.
          const safeLabel = trimmed.replace(/"/g, '#quot;');
          return `${prefix}${nodeId}["${safeLabel}"]`;
        },
      ),
    )
    .join('\n');
}

// ---- 全局渲染互斥队列 ----
// mermaid v11 的 render 会往 document.body 塞临时元素，并发调用会互相拆台
// （典型症状 "svg element not in render tree"）。所有渲染串行化，永不同时跑。
let renderChain: Promise<void> = Promise.resolve();

function enqueueRender(task: () => Promise<void>): Promise<void> {
  const run = renderChain.then(task, task);
  renderChain = run.catch(() => undefined);
  return run;
}

export function MermaidBlock({ chart }: { chart: string }) {
  const rawId = useId();
  const chartRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const [fontSize, setFontSize] = useState(18);
  const [stackWideChart, setStackWideChart] = useState(false);

  // 主题切换（data-theme 属性变化）→ 入队重渲（串行，不打断在跑的渲染）
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setThemeTick((t) => t + 1));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = chartRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const updateFontSize = () => {
      // Mermaid lays out the graph using this value. Keep it in a readable
      // range while the SVG below scales to the available conversation width.
      const width = node.clientWidth;
      const next = Math.max(13, Math.min(18, width / 54));
      setFontSize((current) =>
        Math.abs(current - next) < 0.1 ? current : Number(next.toFixed(1)),
      );
      // A wide left-to-right flowchart would otherwise make its text
      // unreadably small when it is fitted into a conversation column.
      const shouldStack = width > 0 && width < 960;
      setStackWideChart(shouldStack);
    };
    updateFontSize();
    const observer = new ResizeObserver(updateFontSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    setSvg(null);
    setFailure(null);
    // 队列等待 + 渲染加起来超过 15s 视为超时（promise 永不落定也兜得住）
    const timer = setTimeout(() => {
      if (cancelled || settled) return;
      settled = true;
      console.error('[MermaidBlock] 渲染超时:', chart.slice(0, 80));
      setFailure('渲染超时——页面版本可能已过期，请刷新页面后重试');
    }, RENDER_TIMEOUT_MS);
    const dark = currentDark();
    enqueueRender(async () => {
      if (cancelled || settled) return;
      try {
        const mermaid = await loadMermaid();
        if (cancelled || settled) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          darkMode: dark,
          themeVariables: mermaidThemeVariables(dark, fontSize),
        });
        // useId 含冒号，SVG id 只留字母数字
        const id = `mmd-${rawId.replace(/[^a-zA-Z0-9]/g, '')}-${themeTick}`;
        const { svg } = await mermaid.render(id, normalizeMermaidChart(chart, stackWideChart));
        if (cancelled || settled) return;
        settled = true;
        clearTimeout(timer);
        setSvg(svg);
      } catch (err: unknown) {
        if (cancelled || settled) return;
        settled = true;
        clearTimeout(timer);
        console.error('[MermaidBlock] 渲染失败:', err);
        const message = err instanceof Error ? err.message : String(err);
        // 动态 chunk 加载失败 = 打开中的页面落后于最近一次构建（hash 已换代）
        if (/dynamically imported module|MIME type|error loading|Failed to fetch/i.test(message)) {
          setFailure('图表组件加载失败——页面版本已过期，请刷新页面后重试');
        } else {
          setFailure(`mermaid 语法有误：${message.slice(0, 200)}`);
        }
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chart, fontSize, rawId, stackWideChart, themeTick]);

  if (failure) {
    // 错误回退：源码照常可读，不吞内容
    return (
      <div ref={chartRef} className={styles.wrap}>
        <pre className={styles.error}>{chart}</pre>
        <p className={styles.note}>{failure}</p>
      </div>
    );
  }
  if (!svg) {
    return (
      <div ref={chartRef} className={styles.wrap}>
        <p className={styles.note}>图表渲染中…</p>
      </div>
    );
  }
  return (
    <div ref={chartRef} className={styles.wrap}>
      {/* mermaid 产出的 SVG 已按 securityLevel: strict 消毒 */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict 模式消毒后的可信 SVG（项目零第三方依赖，不引入 DOMPurify） */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
