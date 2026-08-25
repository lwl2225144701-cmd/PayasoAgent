import { StatusDot } from '../StatusDot';
import { BellIcon, SettingsIcon, SearchIcon } from '../icons';
import styles from './TopBar.module.css';

interface TopBarProps {
  online: boolean;
  lastEventAt: string | null;
}

export function TopBar({ online, lastEventAt }: TopBarProps) {
  return (
    <div className={styles.topbar}>
      <div className={styles.left}>
        <div className={styles.status}>
          <StatusDot online={online} />
          <span className={online ? styles.labelOnline : styles.labelOffline}>
            {online ? '在线' : '离线'}
          </span>
        </div>
        {lastEventAt && (
          <span className={styles.sep}>·</span>
        )}
        {lastEventAt && (
          <span className={styles.lastEvent}>最后事件 {new Date(lastEventAt).toLocaleTimeString('zh-CN')}</span>
        )}
      </div>
      <div className={styles.center}>
        <span className={styles.title}>AI 智能助手</span>
      </div>
      <div className={styles.right}>
        <button className={styles.iconBtn} title="搜索">
          <SearchIcon size={15} />
        </button>
        <button className={styles.iconBtn} title="设置">
          <SettingsIcon size={15} />
        </button>
        <button className={styles.iconBtn} title="通知">
          <BellIcon size={15} />
        </button>
      </div>
    </div>
  );
}
