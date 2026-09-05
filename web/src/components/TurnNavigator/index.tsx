import type { CSSProperties, MouseEvent, PointerEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { HostRun } from '../../types';
import styles from './TurnNavigator.module.css';

// 回合导航条（对标 ui-chat TurnNavigator）：
// 右缘悬浮竖条，每条 mark = 一个已加载 Turn（本项目 = 一个 Run），
// 点击/悬停可导航与预览，当前阅读回合的 mark 加长加亮。
// 槽保持 0 高并挂在会话滚动容器内部；rail 自身固定在应用可视区域右缘。

export interface TurnNavigatorProps {
  runs: HostRun[];
  activeRunId: string | null;
  onNavigate: (runId: string) => void;
}

/** 相邻 mark 的静止间距，run 多时按比例压缩进 rail。 */
const MARK_SPACING_PX = 10;
/** rail 首尾各留的内边距。 */
const RAIL_INSET_PX = 6;

type MarkPositionStyle = CSSProperties & {
  '--turn-natural-position': string;
  '--turn-position': string;
};

type RailSizeStyle = CSSProperties & {
  '--turn-natural-height': string;
};

// 自然位置（px）与比例位置（%）取 min：不压缩时两者相等，压缩时按比例铺满
function markPosition(index: number, count: number): MarkPositionStyle {
  const ratio = count <= 1 ? 0 : index / (count - 1);
  return {
    '--turn-natural-position': `${index * MARK_SPACING_PX}px`,
    '--turn-position': `${ratio * 100}%`,
  };
}

function railSize(count: number): RailSizeStyle {
  return {
    '--turn-natural-height': `${(count - 1) * MARK_SPACING_PX + 2 * RAIL_INSET_PX}px`,
  };
}

// 指针 y → 最近 mark（扣除首尾 inset，与视觉位置一致）
function runAtPointer(runs: HostRun[], rail: HTMLElement, clientY: number): HostRun | undefined {
  const rect = rail.getBoundingClientRect();
  const usable = Math.max(1, rect.height - 2 * RAIL_INSET_PX);
  const ratio = Math.max(0, Math.min(1, (clientY - rect.top - RAIL_INSET_PX) / usable));
  return runs[Math.round(ratio * (runs.length - 1))];
}

function TurnNavigatorInner({ runs, activeRunId, onNavigate }: TurnNavigatorProps) {
  const [previewIndex, setPreviewIndex] = useState<number>(-1);
  const [visibleRunId, setVisibleRunId] = useState<string | null>(activeRunId);
  const slotRef = useRef<HTMLDivElement>(null);

  // activeRunId is the selected run (for example after clicking a mark), while
  // visibleRunId follows the run currently under the reader's scroll anchor.
  // Keeping these separate prevents ordinary scrolling from changing which run
  // the composer controls belong to.
  useEffect(() => {
    setVisibleRunId(activeRunId);
  }, [activeRunId]);

  useEffect(() => {
    if (runs.length <= 1) return;
    const slot = slotRef.current;
    if (!slot) return;

    // The embedded timelines are scrolled by App's sessionTimeline parent.
    // Find that element without depending on a CSS-module class name.
    let root: HTMLElement | null = slot.parentElement;
    while (root && root !== document.body) {
      const style = window.getComputedStyle(root);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        break;
      }
      root = root.parentElement;
    }
    if (!root) return;

    const elements = runs
      .map((run) => ({ run, element: document.getElementById(`run-${run.runId}`) }))
      .filter(
        (item): item is { run: HostRun; element: HTMLElement } =>
          item.element instanceof HTMLElement,
      );
    if (elements.length === 0) return;

    let frame = 0;
    const updateVisibleRun = () => {
      frame = 0;
      const rootRect = root.getBoundingClientRect();
      // The anchor is below the header of a message, which makes the active
      // mark change only after the reader has meaningfully entered a run.
      const anchorY = rootRect.top + Math.min(140, rootRect.height * 0.3);
      let next = elements[0].run.runId;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const item of elements) {
        const rect = item.element.getBoundingClientRect();
        const containsAnchor = rect.top <= anchorY && rect.bottom >= anchorY;
        const distance = containsAnchor ? 0 : Math.abs(rect.top - anchorY);
        if (distance < bestDistance) {
          bestDistance = distance;
          next = item.run.runId;
        }
      }

      setVisibleRunId((previous) => (previous === next ? previous : next));
    };

    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateVisibleRun);
    };

    updateVisibleRun();
    root.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [runs]);

  const navigateAtPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const run = runAtPointer(runs, event.currentTarget, event.clientY);
      if (run) onNavigate(run.runId);
    },
    [runs, onNavigate],
  );

  const previewAtPointer = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const run = runAtPointer(runs, event.currentTarget, event.clientY);
      setPreviewIndex(run ? runs.indexOf(run) : -1);
    },
    [runs],
  );

  if (runs.length <= 1) return null;

  const preview = previewIndex >= 0 ? runs[previewIndex] : undefined;

  return (
    <div ref={slotRef} className={styles.slot}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 轨道点击是鼠标快捷方式，键盘导航由内部按钮（Tab + Enter）提供 */}
      <nav
        className={styles.rail}
        style={railSize(runs.length)}
        aria-label="回合导航"
        onClick={navigateAtPointer}
        onPointerMove={previewAtPointer}
        onPointerLeave={() => setPreviewIndex(-1)}
      >
        <div className={styles.marks}>
          {runs.map((run, index) => {
            const isActive = run.runId === (visibleRunId ?? activeRunId);
            const isPreview = index === previewIndex;
            return (
              <div
                key={run.runId}
                className={styles.markPosition}
                style={markPosition(index, runs.length)}
              >
                <button
                  type="button"
                  aria-current={isActive ? 'true' : undefined}
                  aria-label={`回合 ${index + 1}：${run.task.slice(0, 30)}`}
                  className={`${styles.mark} ${isActive ? styles.markActive : ''} ${isPreview ? styles.markPreview : ''}`}
                  onFocus={() => setPreviewIndex(index)}
                  onBlur={() => setPreviewIndex((prev) => (prev === index ? -1 : prev))}
                  onClick={(event) => {
                    event.stopPropagation();
                    onNavigate(run.runId);
                  }}
                />
              </div>
            );
          })}
        </div>
        {preview && (
          <div className={styles.preview} style={markPosition(previewIndex, runs.length)}>
            <span className={styles.previewPrompt}>{preview.task}</span>
            {preview.result && (
              <span className={styles.previewSummary}>{preview.result.slice(0, 160)}</span>
            )}
          </div>
        )}
      </nav>
    </div>
  );
}

export const TurnNavigator = memo(TurnNavigatorInner);
