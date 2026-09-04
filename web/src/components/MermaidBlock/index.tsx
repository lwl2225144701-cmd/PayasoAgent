import { useEffect, useId, useState } from 'react';
import { readThemeMode, resolveThemeMode } from '../../theme';
import styles from './MermaidBlock.module.css';

// 聊天内 Mermaid 渲染：```mermaid 代码块 → 矢量图（主题自适应，懒加载）。
// mermaid 体积大（~1MB），通过动态 import 拆成独立 chunk，只有真的出现
// mermaid 图时才下载；普通对话零开销。
// 失败必须自诊断可见：chunk 加载失败（页面版本过期）/ 语法错误 / 超时三类，
// 都落到可读的回退视图，绝不允许永远停在加载态。

type MermaidApi = (typeof import('mermaid'))['default'];

let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default);
  }
  return mermaidPromise;
}

function currentDark(): boolean {
  return resolveThemeMode(readThemeMode()) === 'dark';
}

const RENDER_TIMEOUT_MS = 15_000;

export function MermaidBlock({ chart }: { chart: string }) {
  const rawId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [themeTick, setThemeTick] = useState(0);

  // 主题切换（data-theme 属性变化）→ 用新主题重渲
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setThemeTick((t) => t + 1));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 渲染 promise 可能永不落定（旧页面请求已换代的懒加载 chunk、渲染内部卡死），
    // 超时兜底把一切悬挂转成可见错误。
    let settled = false;
    setSvg(null);
    setFailure(null);
    const timer = setTimeout(() => {
      if (cancelled || settled) return;
      settled = true;
      console.error('[MermaidBlock] 渲染超时:', chart.slice(0, 80));
      setFailure('渲染超时——页面版本可能已过期，请刷新页面后重试');
    }, RENDER_TIMEOUT_MS);
    const dark = currentDark();
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
          darkMode: dark,
        });
        // useId 含冒号，SVG id 只留字母数字
        const id = `mmd-${rawId.replace(/[^a-zA-Z0-9]/g, '')}-${themeTick}`;
        const { svg } = await mermaid.render(id, chart);
        if (cancelled || settled) return;
        settled = true;
        clearTimeout(timer);
        setSvg(svg);
      })
      .catch((err: unknown) => {
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
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chart, rawId, themeTick]);

  if (failure) {
    // 语法错误回退：源码照常可读，不吞内容
    return (
      <div className={styles.wrap}>
        <pre className={styles.error}>{chart}</pre>
        <p className={styles.note}>{failure}</p>
      </div>
    );
  }
  if (!svg) {
    return (
      <div className={styles.wrap}>
        <p className={styles.note}>图表渲染中…</p>
      </div>
    );
  }
  // mermaid 产出的 SVG 已按 securityLevel: strict 消毒
  return <div className={styles.wrap} dangerouslySetInnerHTML={{ __html: svg }} />;
}
