import { useMemo } from 'react';
import type { HostRun } from '../../types';
import { formatTime, dayLabel } from '../../format';
import { PlusIcon } from '../icons';
import styles from './Sidebar.module.css';

interface SidebarProps {
  runs: HostRun[];
  currentRunId: string | null;
  onSelectRun: (runId: string) => void;
  onNewTask: () => void;
}

interface RunGroup {
  label: string;
  items: HostRun[];
}

export function Sidebar({ runs, currentRunId, onSelectRun, onNewTask }: SidebarProps) {
  const groups = useMemo<RunGroup[]>(() => {
    const sorted = [...runs].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const groups: RunGroup[] = [];
    for (const run of sorted) {
      const label = dayLabel(run.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.label === label) {
        last.items.push(run);
      } else {
        groups.push({ label, items: [run] });
      }
    }
    return groups;
  }, [runs]);

  return (
    <aside className={styles.sidebar}>
      <div className={styles.logoRow}>
        <span className={styles.logoMark}>P</span>
        <span className={styles.logoText}>Payaso</span>
      </div>

      <div className={styles.newTaskWrap}>
        <button className={styles.newTaskBtn} onClick={onNewTask}>
          <PlusIcon size={15} />
          <span>新建任务</span>
        </button>
      </div>

      <nav className={styles.runList}>
        {groups.length === 0 && (
          <div className={styles.empty}>暂无历史任务</div>
        )}
        {groups.map(group => (
          <div key={group.label}>
            <div className={styles.groupLabel}>{group.label}</div>
            {group.items.map(run => {
              const active = run.runId === currentRunId;
              return (
                <button
                  key={run.runId}
                  className={`${styles.runItem} ${active ? styles.active : ''}`}
                  onClick={() => onSelectRun(run.runId)}
                >
                  <span className={`${styles.runTitle} truncate`}>{run.task || '未命名任务'}</span>
                  <span className={styles.runTime}>{formatTime(run.createdAt)}</span>
                  {active && <span className={styles.activeDot} />}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className={styles.footer}>
        <button className={styles.userBtn} title="账户">
          <span className={styles.avatar}>P</span>
        </button>
      </div>
    </aside>
  );
}
