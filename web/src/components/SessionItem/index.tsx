import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatRelativeTime } from '../../format';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useI18n } from '../../i18n';
import type { HostSession } from '../../types';
import { ArchiveIcon, MoreIcon, PencilIcon } from '../icons';
import styles from './SessionItem.module.css';

interface SessionItemProps {
  session: HostSession;
  active?: boolean;
  onClick?: () => void;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onArchive: (sessionId: string) => Promise<void>;
}

interface MenuState {
  x: number;
  y: number;
}

export function SessionItem({
  session,
  active = false,
  onClick,
  onRename,
  onArchive,
}: SessionItemProps) {
  const { t, language } = useI18n();
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
      // 错误由父级 toast 处理
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
      // 错误由父级 toast 处理
    } finally {
      setBusy(false);
    }
  };

  const itemClassName = `${styles.item} ${active ? styles.active : ''}`;

  return (
    <div className={itemClassName}>
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
          // biome-ignore lint/a11y/noAutofocus: 重命名输入框自动聚焦为有意 UX
          autoFocus
          disabled={busy}
        />
      ) : (
        <button
          type="button"
          className={styles.body}
          onClick={onClick}
          aria-label={session.title || t('shell.session.untitled')}
        >
          <span className={`${styles.title} truncate`}>
            {session.title || t('shell.session.untitled')}
          </span>
          <span className={styles.time}>{formatRelativeTime(session.updatedAt, language)}</span>
        </button>
      )}

      <button
        type="button"
        className={styles.moreBtn}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
        aria-label={t('shell.action.moreFor', { name: session.title })}
      >
        <MoreIcon size={14} />
      </button>

      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.menu}
            style={{
              left: `${Math.max(8, Math.min(menu.x + 22 - 160, window.innerWidth - 168))}px`,
              top: `${menu.y}px`,
            }}
          >
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => {
                setMenu(null);
                setRenaming(true);
              }}
            >
              <PencilIcon size={14} />
              <span>{t('shell.action.rename')}</span>
            </button>
            <button type="button" className={styles.menuItem} onClick={confirmArchive}>
              <ArchiveIcon size={14} />
              <span>{t('shell.action.archive')}</span>
            </button>
          </div>,
          document.getElementById('payaso-portal-root') ?? document.body,
        )}
    </div>
  );
}
