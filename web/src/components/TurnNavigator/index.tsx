import { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { HostRun } from '../../types';
import styles from './TurnNavigator.module.css';

// 回合导航条（对标 ui-chat TurnNavigator）：
// 右缘悬浮竖条，每条 mark = 一个已加载 Turn（本项目 = 一个 Run），
// 点击/悬停可导航与预览，当前阅读回合的 mark 加长加亮。

export interface TurnNavigatorProps {
  runs: HostRun[];
  activeRunId: string | null;
  onNavigate: (runId: string) => void;
}

// 单条 mark 的最大高度与间距（对照参考实现：mark 间距 10px，内部上下 padding 各 6px）
const MARK_GAP = 10;
const MARK_PADDING = 6;
const MAX_RAIL_HEIGHT = 420;

function TurnNavigatorInner({ runs, activeRunId, onNavigate }: TurnNavigatorProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const activeIndex = runs.findIndex(r => r.runId === activeRunId);

  const handleRailClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    const index = Math.max(0, Math.min(runs.length - 1, Math.round(ratio * (runs.length - 1))));
    const run = runs[index];
    if (run) onNavigate(run.runId);
  }, [runs, onNavigate]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const index = activeIndex >= 0 ? activeIndex : runs.length - 1;
      const delta = event.key === 'ArrowUp' ? -1 : 1;
      const next = Math.max(0, Math.min(runs.length - 1, index + delta));
      const run = runs[next];
      if (run) onNavigate(run.runId);
    }
  }, [runs, activeIndex, onNavigate]);

  // 自然高度 = (count-1) × 间距 + 上下 padding，与上限取 min
  const railHeight = useMemo(() => {
    const natural = (runs.length - 1) * MARK_GAP + MARK_PADDING * 2;
    return Math.min(natural, MAX_RAIL_HEIGHT);
  }, [runs.length]);

  if (runs.length <= 1) return null;

  return (
    <div className={styles.slot}>
      <div
        ref={railRef}
        className={styles.rail}
        style={{ height: railHeight }}
        role="listbox"
        aria-label="回合导航"
        onClick={handleRailClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >
        {runs.map((run, index) => {
          const isActive = run.runId === activeRunId;
          const isHover = hoverIndex === index;
          return (
            <button
              key={run.runId}
              type="button"
              className={`${styles.mark} ${isActive ? styles.markActive : ''} ${isHover ? styles.markPreview : ''}`}
              role="option"
              aria-selected={isActive}
              aria-label={`回合 ${index + 1}：${run.task.slice(0, 30)}`}
              title={`${run.task}${run.result ? `\n${run.result.slice(0, 80)}` : ''}`}
              onMouseEnter={() => setHoverIndex(index)}
              onMouseLeave={() => setHoverIndex(prev => (prev === index ? null : prev))}
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(run.runId);
              }}
            >
              {isHover && (
                <span className={styles.preview}>
                  <span className={styles.previewPrompt}>{run.task}</span>
                  {run.result && <span className={styles.previewSummary}>{run.result.slice(0, 160)}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const TurnNavigator = memo(TurnNavigatorInner);
