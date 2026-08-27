import type { HostSession, WorkspaceView } from '../../types';
import {
  PanelLeftIcon,
  PlusIcon,
  SettingsIcon,
} from '../icons';
import { IconButton } from '../IconButton';
import { WorkspaceSection } from '../WorkspaceSection';
import styles from './Sidebar.module.css';

interface SidebarProps {
  sessions: HostSession[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewTask: () => void;
  onNewTaskInWorkspace: (workspaceName: string) => void;
  onRenameWorkspace: (fromName: string, toName: string) => Promise<void>;
  onDeleteWorkspace: (name: string) => Promise<void>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  workspace: WorkspaceView | null;
  openingWorkspace: boolean;
  onOpenWorkspace: () => void;
}

export function Sidebar({
  sessions,
  currentSessionId,
  onSelectSession,
  onNewTask,
  onNewTaskInWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  collapsed,
  onToggleCollapsed,
  workspace,
  openingWorkspace,
  onOpenWorkspace,
}: SidebarProps) {
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

      <div className={styles.workspaceArea}>
        <WorkspaceSection
          sessions={sessions}
          currentSessionId={currentSessionId}
          workspace={workspace}
          openingWorkspace={openingWorkspace}
          onOpenWorkspace={onOpenWorkspace}
          onSelectSession={onSelectSession}
          onNewTaskInWorkspace={onNewTaskInWorkspace}
          onRenameWorkspace={onRenameWorkspace}
          onDeleteWorkspace={onDeleteWorkspace}
        />
      </div>

      <div className={styles.footer}>
        <button className={styles.settingsBtn} title="设置" type="button">
          <SettingsIcon size={18} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}
