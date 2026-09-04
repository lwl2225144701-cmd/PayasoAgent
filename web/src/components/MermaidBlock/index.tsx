import { useEffect, useId, useState } from 'react';
import { readThemeMode, resolveThemeMode } from '../../theme';
import styles from './MermaidBlock.module.css';

// 聊天内 Mermaid 渲染：```mermaid 代码块 → 矢量图（主题自适应，懒加载）。
// mermaid 体积大（~1MB），通过动态 import 拆成独立 chunk，只有真的出现
// mermaid 图时才下载；普通对话零开销。

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

export function MermaidBlock({ chart }: { chart: string }) {
  const rawId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
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
    setSvg(null);
    setFailed(false);
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
        if (!cancelled) setSvg(svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [chart, rawId, themeTick]);

  if (failed) {
    // 语法错误回退：源码照常可读，不吞内容
    return (
      <div className={styles.wrap}>
        <pre className={styles.error}>{chart}</pre>
        <p className={styles.note}>mermaid 语法有误，已回退为源码显示</p>
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
