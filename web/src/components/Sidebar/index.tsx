import { useI18n } from '../../i18n';
import type { HostSession, WorkspaceView } from '../../types';
import { IconButton } from '../IconButton';
import { PanelLeftIcon, PlusIcon, SettingsIcon } from '../icons';
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
  onRenameSession: (sessionId: string, title: string) => Promise<void>;
  onArchiveSession: (sessionId: string) => Promise<void>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  workspace: WorkspaceView | null;
  openingWorkspace: boolean;
  onOpenWorkspace: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  sessions,
  currentSessionId,
  onSelectSession,
  onNewTask,
  onNewTaskInWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onRenameSession,
  onArchiveSession,
  collapsed,
  onToggleCollapsed,
  workspace,
  openingWorkspace,
  onOpenWorkspace,
  onOpenSettings,
}: SidebarProps) {
  const { t } = useI18n();
  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      <div className={styles.logoRow}>
        {collapsed ? (
          <button
            className={styles.collapsedLogoBtn}
            type="button"
            title={t('shell.sidebar.expand')}
            aria-label={t('shell.sidebar.expand')}
            onClick={onToggleCollapsed}
          >
            <img
              className={styles.logoImage}
              src="/payaso-mark-light.png"
              alt=""
              draggable={false}
            />
          </button>
        ) : (
          <>
            <div className={styles.brand}>
              <img
                className={styles.logoImage}
                src="/payaso-mark-light.png"
                alt="Payaso"
                draggable={false}
              />
              <span className={styles.logoText}>Payaso</span>
            </div>
            <IconButton
              buttonSize="sm"
              variant="ghost"
              shape="rounded"
              title={t('shell.sidebar.collapse')}
              aria-label={t('shell.sidebar.collapse')}
              aria-pressed={false}
              onClick={onToggleCollapsed}
            >
              <PanelLeftIcon size={18} />
            </IconButton>
          </>
        )}
      </div>

      <div className={styles.newTaskWrap}>
        <button type="button" className={styles.newTaskBtn} onClick={onNewTask}>
          <PlusIcon size={15} />
          <span>{t('shell.action.newTask')}</span>
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
          onRenameSession={onRenameSession}
          onArchiveSession={onArchiveSession}
        />
      </div>

      <div className={styles.footer}>
        <button
          className={styles.settingsBtn}
          title={t('shell.sidebar.settings')}
          type="button"
          onClick={onOpenSettings}
        >
          <SettingsIcon size={18} />
          <span>{t('shell.sidebar.settings')}</span>
        </button>
      </div>
    </aside>
  );
}
