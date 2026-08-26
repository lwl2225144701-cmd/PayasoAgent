import { useMemo } from 'react';
import type { HostRun, WorkspaceView } from '../../types';
import { formatTime, dayLabel } from '../../format';
import {
  FolderIcon,
  PanelLeftIcon,
  PlusIcon,
  SettingsIcon,
} from '../icons';
import styles from './Sidebar.module.css';

interface SidebarProps {
  runs: HostRun[];
  currentRunId: string | null;
  onSelectRun: (runId: string) => void;
  onNewTask: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  workspace: WorkspaceView | null;
  openingWorkspace: boolean;
  onOpenWorkspace: () => void;
}

interface RunGroup {
  label: string;
  items: HostRun[];
}

export function Sidebar({
  runs,
  currentRunId,
  onSelectRun,
  onNewTask,
  collapsed,
  onToggleCollapsed,
  workspace,
  openingWorkspace,
  onOpenWorkspace,
}: SidebarProps) {
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
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      <div className={styles.logoRow}>
        {collapsed ? (
          <button
            className={styles.collapsedLogoBtn}
            type="button"
            title="展开侧栏"
            aria-label="展开侧栏"
            onClick={onToggleCollapsed}
          >
            <img className={styles.logoImage} src="/payaso-mark-light.png" alt="" draggable={false} />
          </button>
        ) : (
          <>
            <div className={styles.brand}>
              <img className={styles.logoImage} src="/payaso-mark-light.png" alt="Payaso" draggable={false} />
              <span className={styles.logoText}>Payaso</span>
            </div>
            <button
              className={styles.collapseBtn}
              type="button"
              title="收起侧栏"
              aria-label="收起侧栏"
              aria-pressed={false}
              onClick={onToggleCollapsed}
            >
              <PanelLeftIcon size={18} />
            </button>
          </>
        )}
      </div>

      <div className={styles.newTaskWrap}>
        <button className={styles.newTaskBtn} onClick={onNewTask}>
          <PlusIcon size={15} />
          <span>新建任务</span>
        </button>
      </div>

      <div className={styles.workspaceSection}>
        <span className={styles.workspaceLabel}>工作区</span>
        <button
          className={styles.workspaceBtn}
          type="button"
          onClick={onOpenWorkspace}
          disabled={openingWorkspace}
          title={workspace ? '更换文件夹' : '打开文件夹'}
        >
          <FolderIcon size={16} />
          <span className="truncate">
            {workspace ? workspace.name : openingWorkspace ? '正在打开…' : '打开文件夹'}
          </span>
        </button>
        {workspace && (
          <button
            className={styles.changeWorkspaceBtn}
            type="button"
            onClick={onOpenWorkspace}
            disabled={openingWorkspace}
          >
            {openingWorkspace ? '正在打开…' : '更换文件夹'}
          </button>
        )}
      </div>

      <nav className={styles.runList} aria-label="工作区任务">
        {groups.length === 0 && (
          <div className={styles.empty}>暂无历史任务</div>
        )}
        {groups.map(group => (
          <div key={group.label}>
            {group.items.map(run => {
              const active = run.runId === currentRunId;
              return (
                <button
                  key={run.runId}
                  className={`${styles.runItem} ${active ? styles.active : ''}`}
                  onClick={() => onSelectRun(run.runId)}
                >
                  <FolderIcon size={17} />
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
        <button className={styles.settingsBtn} title="设置" type="button">
          <SettingsIcon size={18} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}
