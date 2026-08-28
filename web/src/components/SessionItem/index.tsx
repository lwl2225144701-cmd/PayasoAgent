import { useRef, useState } from 'react';
import type { HostSession } from '../../types';
import { formatRelativeTime } from '../../format';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { MoreIcon, PencilIcon, ArchiveIcon, TrashIcon } from '../icons';
import { IconButton } from '../IconButton';
import { Modal } from '../Modal';
import styles from './SessionItem.module.css';

interface SessionItemProps {
  session: HostSession;
  active?: boolean;
  onClick?: () => void;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onArchive: (sessionId: string) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
}

interface MenuState {
  x: number;
  y: number;
}

export function SessionItem({ session, active = false, onClick, onRename, onArchive, onDelete }: SessionItemProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title);
  const [busy, setBusy] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  useEscapeKey(true, () => setMenu(null));
  useClickOutside(menuRef, true, () => setMenu(null));

  const submitRename = async () => {
    if (busy) return;
    const to = renameValue.trim();
    if (!to || to === session.title) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    try {
      await onRename(session.sessionId, to);
      setRenaming(false);
    } catch {
      // 错误提示由 App 层负责
    } finally {
      setBusy(false);
    }
  };

  const confirmArchive = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onArchive(session.sessionId);
      setMenu(null);
    } catch {
      // ignored
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete(session.sessionId);
      setMenu(null);
    } catch {
      // ignored
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`${styles.item} ${active ? styles.active : ''}`}
        onClick={onClick}
      >
        {renaming ? (
          <input
            className={styles.inlineInput}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitRename();
              if (e.key === 'Escape') {
                setRenameValue(session.title);
                setRenaming(false);
              }
            }}
            autoFocus
            disabled={busy}
          />
        ) : (
          <>
            <span className={`${styles.title} truncate`}>{session.title || '未命名任务'}</span>
            <span className={styles.time}>{formatRelativeTime(session.updatedAt)}</span>
            <IconButton
              buttonSize="sm"
              variant="ghost"
              shape="rounded"
              title="更多操作"
              aria-label={`${session.title} 更多操作`}
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.left, y: rect.bottom + 4 });
              }}
            >
              <MoreIcon size={14} />
            </IconButton>
          </>
        )}
      </button>

      {menu && (
        <div ref={menuRef} className={styles.menu} style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 188)), top: menu.y }}>
          <button type="button" className={styles.menuItem} onClick={() => { setMenu(null); setRenaming(true); }}>
            <PencilIcon size={14} />
            <span>重命名</span>
          </button>
          <button type="button" className={styles.menuItem} onClick={confirmArchive}>
            <ArchiveIcon size={14} />
            <span>归档</span>
          </button>
          <button type="button" className={`${styles.menuItem} ${styles.menuDanger}`} onClick={confirmDelete}>
            <TrashIcon size={14} />
            <span>删除</span>
          </button>
        </div>
      )}
    </>
  );
}
