import type { HostSession } from '../../types';
import { formatRelativeTime } from '../../format';
import styles from './SessionItem.module.css';

interface SessionItemProps {
  session: HostSession;
  active?: boolean;
  onClick?: () => void;
}

export function SessionItem({ session, active = false, onClick }: SessionItemProps) {
  return (
    <button
      type="button"
      className={`${styles.item} ${active ? styles.active : ''}`}
      onClick={onClick}
    >
      <span className={`${styles.title} truncate`}>{session.title || '未命名任务'}</span>
      <span className={styles.time}>{formatRelativeTime(session.updatedAt)}</span>
    </button>
  );
}
