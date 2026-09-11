import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useI18n } from '../../i18n';
import type { HostSession, WorkspaceView } from '../../types';
import { Collapse } from '../Collapse';
import { IconButton } from '../IconButton';
import { ChevronDownIcon, FolderIcon, MoreIcon, PencilIcon, PlusIcon, TrashIcon } from '../icons';
import { Modal } from '../Modal';
import { SessionItem } from '../SessionItem';
import styles from './WorkspaceSection.module.css';
import { isWorkspaceGroupExpanded, type WorkspaceGroup } from './workspace-expansion';

interface WorkspaceSectionProps {
  sessions: HostSession[];
  currentSessionId: string | null;
  workspace: WorkspaceView | null;
  openingWorkspace: boolean;
  onOpenWorkspace: () => void;
  onSelectSession: (sessionId: string) => void;
  onNewTaskInWorkspace: (workspaceName: string) => void;
  onRenameWorkspace: (fromName: string, toName: string) => Promise<void>;
  onDeleteWorkspace: (name: string) => Promise<void>;
  onRenameSession: (sessionId: string, title: string) => Promise<void>;
  onArchiveSession: (sessionId: string) => Promise<void>;
}

interface MenuState {
  name: string;
  x: number;
  y: number;
}

// 无工作区会话的分组哨兵名：它只参与分组与比较，不是展示文案；
// 渲染时由 groupLabel 翻成当前语言的「未选择工作区」。
const NO_WORKSPACE_GROUP = '\u0000no-workspace';

function groupSessionsByWorkspace(
  sessions: HostSession[],
  currentWorkspace: WorkspaceView | null,
): WorkspaceGroup[] {
  const map = new Map<string, HostSession[]>();
  for (const session of sessions) {
    const name = session.workspace?.name ?? NO_WORKSPACE_GROUP;
    const list = map.get(name) ?? [];
    list.push(session);
    map.set(name, list);
  }

  for (const list of map.values()) {
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  return Array.from(map.entries())
    .map(([name, sessions]) => ({ name, sessions }))
    .sort((a, b) => {
      const currentName = currentWorkspace?.name;
      if (a.name === currentName && b.name !== currentName) return -1;
      if (b.name === currentName && a.name !== currentName) return 1;
      return a.name.localeCompare(b.name);
    });
}

function WorkspaceFolderHeader({
  name,
  onOpenMenu,
  onNewTask,
}: {
  name: string;
  onOpenMenu: (x: number, y: number) => void;
  onNewTask: () => void;
}) {
  const { t } = useI18n();
  return (
    <span className={styles.folderHeader}>
      <span className={styles.folderIconSlot}>
        <FolderIcon size={15} className={styles.folderIcon} />
        <ChevronDownIcon size={13} className={styles.folderArrow} />
      </span>
      <span className={`${styles.folderName} truncate`}>{name}</span>
      <span className={styles.folderActions}>
        <button
          type="button"
          className={styles.actionBtn}
          title={t('shell.action.more')}
          aria-label={t('shell.action.moreFor', { name })}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            onOpenMenu(rect.left, rect.bottom + 4);
          }}
        >
          <MoreIcon size={15} />
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          title={t('shell.action.newTask')}
          aria-label={t('shell.workspace.newTaskIn', { name })}
          onClick={(e) => {
            e.stopPropagation();
            onNewTask();
          }}
        >
          <PlusIcon size={15} />
        </button>
      </span>
    </span>
  );
}

function WorkspaceMenu({
  x,
  y,
  onClose,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEscapeKey(true, onClose);
  useClickOutside(ref, true, onClose);

  const left = Math.max(8, Math.min(x + 22 - 160, window.innerWidth - 168));

  return createPortal(
    <div ref={ref} className={styles.menu} style={{ left, top: y }}>
      <button
        type="button"
        className={styles.menuItem}
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        <PencilIcon size={14} />
        <span>{t('shell.action.rename')}</span>
      </button>
      <button
        type="button"
        className={`${styles.menuItem} ${styles.menuDanger}`}
        onClick={() => {
          onClose();
          onDelete();
        }}
      >
        <TrashIcon size={14} />
        <span>{t('shell.workspace.delete')}</span>
      </button>
    </div>,
    document.getElementById('payaso-portal-root') ?? document.body,
  );
}

export function WorkspaceSection({
  sessions,
  currentSessionId,
  workspace,
  openingWorkspace,
  onOpenWorkspace,
  onSelectSession,
  onNewTaskInWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onRenameSession,
  onArchiveSession,
}: WorkspaceSectionProps) {
  const { t } = useI18n();
  const groups = useMemo(
    () => groupSessionsByWorkspace(sessions, workspace),
    [sessions, workspace],
  );

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- 分组展开：派生自动判定 + 用户显式覆盖（判定规则见 workspace-expansion.ts）----
  //
  // 不用 Collapse 的 defaultExpanded：它只在**挂载那一刻**生效，而「当前会话属于哪个
  // 工作区」在刷新场景是等会话清单回来才知道的 —— 结果是当前会话所在分组一直收着，
  // 用户看不到自己在哪。改成受控后，判定随数据变化自动重算。
  const [groupOverrides, setGroupOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const currentWorkspaceName = workspace?.name ?? NO_WORKSPACE_GROUP;

  const isGroupExpanded = (group: WorkspaceGroup): boolean =>
    isWorkspaceGroupExpanded(group, {
      currentSessionId,
      currentWorkspaceName,
      overrides: groupOverrides,
    });

  const handleToggleGroup = useCallback((name: string, next: boolean) => {
    setGroupOverrides((prev) => new Map(prev).set(name, next));
  }, []);

  const isFallbackWorkspace = (name: string) => name === NO_WORKSPACE_GROUP;
  // 分组名可能是内部哨兵，展示前统一翻成当前语言
  const groupLabel = (name: string) =>
    isFallbackWorkspace(name) ? t('shell.workspace.none') : name;

  const openRename = () => {
    if (!menu) return;
    setRenaming(menu.name);
    setRenameValue(menu.name);
  };

  const openDelete = () => {
    if (!menu) return;
    setDeleting(menu.name);
  };

  const submitRename = async () => {
    if (!renaming || busy) return;
    const toName = renameValue.trim();
    if (!toName || toName === renaming) return;
    setBusy(true);
    try {
      await onRenameWorkspace(renaming, toName);
      setRenaming(null);
    } catch {
      // 错误提示由 App 层负责
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await onDeleteWorkspace(deleting);
      setDeleting(null);
    } catch {
      // 错误提示由 App 层负责
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <span className={styles.label}>{t('shell.workspace.label')}</span>
        <IconButton
          buttonSize="sm"
          variant="ghost"
          shape="rounded"
          title={workspace ? t('shell.workspace.change') : t('shell.workspace.open')}
          aria-label={workspace ? t('shell.workspace.change') : t('shell.workspace.open')}
          onClick={onOpenWorkspace}
          disabled={openingWorkspace}
        >
          <FolderIcon size={15} />
        </IconButton>
      </div>

      {groups.length === 0 ? (
        <div className={styles.empty}>{t('shell.workspace.empty')}</div>
      ) : (
        <nav className={styles.tree} aria-label={t('shell.workspace.tree')}>
          {groups.map((group) => {
            const fallback = isFallbackWorkspace(group.name);
            return (
              <Collapse
                key={group.name}
                header={
                  <WorkspaceFolderHeader
                    name={groupLabel(group.name)}
                    onOpenMenu={fallback ? () => {} : (x, y) => setMenu({ name: group.name, x, y })}
                    onNewTask={fallback ? () => {} : () => onNewTaskInWorkspace(group.name)}
                  />
                }
                expanded={isGroupExpanded(group)}
                onToggle={(next) => handleToggleGroup(group.name, next)}
                headerClassName={styles.headerButton}
                arrow={false}
                contentClassName={styles.folderContent}
              >
                {group.sessions.map((session) => (
                  <SessionItem
                    key={session.sessionId}
                    session={session}
                    active={session.sessionId === currentSessionId}
                    onClick={() => onSelectSession(session.sessionId)}
                    onRename={onRenameSession}
                    onArchive={onArchiveSession}
                  />
                ))}
              </Collapse>
            );
          })}
        </nav>
      )}

      {menu && !isFallbackWorkspace(menu.name) && (
        <WorkspaceMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={openRename}
          onDelete={openDelete}
        />
      )}

      {renaming && (
        <Modal onClose={() => setRenaming(null)} ariaLabel={t('shell.workspace.rename')}>
          <div className={styles.dialog}>
            <div className={styles.dialogTitle}>{t('shell.workspace.rename')}</div>
            <input
              className={styles.dialogInput}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitRename();
              }}
              maxLength={120}
              // biome-ignore lint/a11y/noAutofocus: 重命名输入框自动聚焦为有意 UX
              autoFocus
            />
            <div className={styles.dialogActions}>
              <button type="button" className={styles.dialogBtn} onClick={() => setRenaming(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={`${styles.dialogBtn} ${styles.primaryBtn}`}
                disabled={busy || !renameValue.trim() || renameValue.trim() === renaming}
                onClick={() => void submitRename()}
              >
                {t('common.ok')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal onClose={() => setDeleting(null)} ariaLabel={t('shell.workspace.delete')}>
          <div className={styles.dialog}>
            <div className={styles.dialogTitle}>{t('shell.workspace.delete')}</div>
            <p className={styles.dialogText}>
              {t('shell.workspace.deleteConfirm', { name: deleting })}
            </p>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.dialogBtn} onClick={() => setDeleting(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={`${styles.dialogBtn} ${styles.dangerBtn}`}
                disabled={busy}
                onClick={() => void submitDelete()}
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
