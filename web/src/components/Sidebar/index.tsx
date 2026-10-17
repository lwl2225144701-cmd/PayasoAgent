import { useI18n } from '../../i18n';
import type { HostSession, WorkspaceView } from '../../types';
import { PanelLeftIcon, PlusIcon, SettingsIcon } from '../icons';
import { UpdateStatusRow } from '../UpdateStatus';
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
      <div className={styles.headerArea} data-window-drag>
        {/* 参考 DSH 的窗口左上角：红绿灯那一行只放折叠按钮，品牌（🦌 Payaso）在
            红绿灯下面一行。红绿灯由 macOS 画、不占布局，壳把"chrome 行高"注入成
            CSS 变量（--sidebar-chrome-height），浏览器里为 0 → 品牌行直接贴顶。 */}
        <div className={styles.brandRow}>
          <img
            className={styles.logoImage}
            src="/payaso-mark-light.png"
            alt="Payaso"
            draggable={false}
          />
          <span className={styles.logoText}>Payaso</span>
        </div>
        {/* 展开态：折叠按钮挂在这里（红绿灯那一行右端）。收起后侧栏宽 0，
            展开按钮由顶栏（ShellBar 的 leading）提供 —— 见 App.tsx。 */}
        {!collapsed && (
          <button
            className={styles.collapseBtn}
            type="button"
            data-sidebar-toggle
            title={t('shell.sidebar.collapse')}
            aria-label={t('shell.sidebar.collapse')}
            onClick={onToggleCollapsed}
          >
            {/* 尺寸来历：DSH 量到的字形外框 14×14 CSS px。正方形外框 +
                strokeWidth 2/24 → 外框 = size×20/24 = 14 → size 17 */}
            <PanelLeftIcon size={17} />
          </button>
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
        <UpdateStatusRow />
      </div>
    </aside>
  );
}
