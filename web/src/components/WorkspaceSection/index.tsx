import { useMemo, useRef, useState } from 'react';
import type { HostSession, WorkspaceView } from '../../types';
import { ChevronDownIcon, FolderIcon, MoreIcon, PencilIcon, PlusIcon, TrashIcon } from '../icons';
import { IconButton } from '../IconButton';
import { Collapse } from '../Collapse';
import { SessionItem } from '../SessionItem';
import { Modal } from '../Modal';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import styles from './WorkspaceSection.module.css';

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
  onDeleteSession: (sessionId: string) => Promise<void>;
}

interface WorkspaceGroup {
  name: string;
  sessions: HostSession[];
}

interface MenuState {
  name: string;
  x: number;
  y: number;
}

const FALLBACK_WORKSPACE_NAME = '未选择工作区';

function groupSessionsByWorkspace(
  sessions: HostSession[],
  currentWorkspace: WorkspaceView | null,
): WorkspaceGroup[] {
  const map = new Map<string, HostSession[]>();
  for (const session of sessions) {
    const name = session.workspace?.name ?? FALLBACK_WORKSPACE_NAME;
    const list = map.get(name) ?? [];
    list.push(session);
    map.set(name, list);
  }

  for (const list of map.values()) {
    list.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
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
          title="更多操作"
          aria-label={`${name} 更多操作`}
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
          title="新建任务"
          aria-label={`在 ${name} 中新建任务`}
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
  name,
  x,
  y,
  onClose,
  onRename,
  onDelete,
}: {
  name: string;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEscapeKey(true, onClose);
  useClickOutside(ref, true, onClose);

  const left = Math.max(8, Math.min(x, window.innerWidth - 188));

  return (
    <div ref={ref} className={styles.menu} style={{ left, top: y }}>
      <button
        type="button"
        className={styles.menuItem}
        onClick={() => { onClose(); onRename(); }}
      >
        <PencilIcon size={14} />
        <span>重命名</span>
      </button>
      <button
        type="button"
        className={`${styles.menuItem} ${styles.menuDanger}`}
        onClick={() => { onClose(); onDelete(); }}
      >
        <TrashIcon size={14} />
        <span>删除工作区</span>
      </button>
    </div>
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
  onDeleteSession,
}: WorkspaceSectionProps) {
  const groups = useMemo(
    () => groupSessionsByWorkspace(sessions, workspace),
    [sessions, workspace],
  );

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isFallbackWorkspace = (name: string) => name === FALLBACK_WORKSPACE_NAME;

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
        <span className={styles.label}>工作区</span>
        <IconButton
          buttonSize="sm"
          variant="ghost"
          shape="rounded"
          title={workspace ? '更换文件夹' : '打开文件夹'}
          aria-label={workspace ? '更换文件夹' : '打开文件夹'}
          onClick={onOpenWorkspace}
          disabled={openingWorkspace}
        >
          <FolderIcon size={15} />
        </IconButton>
      </div>

      {groups.length === 0 ? (
        <div className={styles.empty}>暂无历史任务</div>
      ) : (
        <nav className={styles.tree} aria-label="工作区任务">
          {groups.map(group => {
            const isCurrentWorkspace = group.name === (workspace?.name ?? FALLBACK_WORKSPACE_NAME);
            const fallback = isFallbackWorkspace(group.name);
            return (
              <Collapse
                key={group.name}
                header={(
                  <WorkspaceFolderHeader
                    name={group.name}
                    onOpenMenu={fallback ? () => {} : (x, y) => setMenu({ name: group.name, x, y })}
                    onNewTask={fallback ? () => {} : () => onNewTaskInWorkspace(group.name)}
                  />
                )}
                defaultExpanded={isCurrentWorkspace}
                headerClassName={styles.headerButton}
                arrow={false}
                contentClassName={styles.folderContent}
              >
                {group.sessions.map(session => (
                  <SessionItem
                    key={session.sessionId}
                    session={session}
                    active={session.sessionId === currentSessionId}
                    onClick={() => onSelectSession(session.sessionId)}
                    onRename={onRenameSession}
                    onArchive={onArchiveSession}
                    onDelete={onDeleteSession}
                  />
                ))}
              </Collapse>
            );
          })}
        </nav>
      )}

      {menu && !isFallbackWorkspace(menu.name) && (
        <WorkspaceMenu
          name={menu.name}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={openRename}
          onDelete={openDelete}
        />
      )}

      {renaming && (
        <Modal onClose={() => setRenaming(null)} ariaLabel="重命名工作区">
          <div className={styles.dialog}>
            <div className={styles.dialogTitle}>重命名工作区</div>
            <input
              className={styles.dialogInput}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitRename();
              }}
              maxLength={120}
              autoFocus
            />
            <div className={styles.dialogActions}>
              <button type="button" className={styles.dialogBtn} onClick={() => setRenaming(null)}>取消</button>
              <button
                type="button"
                className={`${styles.dialogBtn} ${styles.primaryBtn}`}
                disabled={busy || !renameValue.trim() || renameValue.trim() === renaming}
                onClick={() => void submitRename()}
              >确定</button>
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal onClose={() => setDeleting(null)} ariaLabel="删除工作区">
          <div className={styles.dialog}>
            <div className={styles.dialogTitle}>删除工作区</div>
            <p className={styles.dialogText}>
              将删除“{deleting}”下的所有会话与运行记录，此操作不可恢复。
            </p>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.dialogBtn} onClick={() => setDeleting(null)}>取消</button>
              <button
                type="button"
                className={`${styles.dialogBtn} ${styles.dangerBtn}`}
                disabled={busy}
                onClick={() => void submitDelete()}
              >删除</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
