import { useMemo } from 'react';
import type { HostSession, WorkspaceView } from '../../types';
import { formatTime, dayLabel } from '../../format';
import {
  FolderIcon,
  PanelLeftIcon,
  PlusIcon,
  SettingsIcon,
} from '../icons';
import { IconButton } from '../IconButton';
import styles from './Sidebar.module.css';

interface SidebarProps {
  sessions: HostSession[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewTask: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  workspace: WorkspaceView | null;
  openingWorkspace: boolean;
  onOpenWorkspace: () => void;
}

interface SessionGroup {
  label: string;
  items: HostSession[];
}

export function Sidebar({
  sessions,
  currentSessionId,
  onSelectSession,
  onNewTask,
  collapsed,
  onToggleCollapsed,
  workspace,
  openingWorkspace,
  onOpenWorkspace,
}: SidebarProps) {
  const groups = useMemo<SessionGroup[]>(() => {
    const sorted = [...sessions].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const groups: SessionGroup[] = [];
    for (const session of sorted) {
      const label = dayLabel(session.updatedAt);
      const last = groups[groups.length - 1];
      if (last && last.label === label) {
        last.items.push(session);
      } else {
        groups.push({ label, items: [session] });
      }
    }
    return groups;
  }, [sessions]);

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
            <IconButton
              buttonSize="sm"
              variant="ghost"
              shape="rounded"
              title="收起侧栏"
              aria-label="收起侧栏"
              aria-pressed={false}
              onClick={onToggleCollapsed}
            >
              <PanelLeftIcon size={18} />
            </IconButton>
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
            {group.items.map(session => {
              const active = session.sessionId === currentSessionId;
              return (
                <button
                  key={session.sessionId}
                  className={`${styles.runItem} ${active ? styles.active : ''}`}
                  onClick={() => onSelectSession(session.sessionId)}
                >
                  <FolderIcon size={17} />
                  <span className={`${styles.runTitle} truncate`}>{session.title || '未命名任务'}</span>
                  <span className={styles.runTime}>{formatTime(session.updatedAt)}</span>
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
