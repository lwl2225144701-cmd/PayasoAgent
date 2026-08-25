import styles from './StatusDot.module.css';

export function StatusDot({ online }: { online: boolean }) {
  return <span className={`${styles.dot} ${online ? styles.online : styles.offline}`} />;
}
