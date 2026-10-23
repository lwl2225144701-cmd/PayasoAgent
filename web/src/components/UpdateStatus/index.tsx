// 侧边栏底部「设置」同一行右侧的更新条目：检查、下载、已下载和安装进度。
//
// 数据来自桌面壳（preload 桥 → ipc）：
//   - idle       → 「v0.4.19」当前版本（更新重启后应变成新号）
//   - available   → 「⬇ 新版本」+ 点击开始下载（tooltip 带版本号）
//   - downloading → 「⬇ 45%」（真机要求：按百分比显示）
// 浏览器里没有壳的桥 → 读不到版本、状态永远 idle → 不渲染。
// 为什么塞进设置那一行：单独占一行会跟「设置」抢视觉重量、且左右留白对不齐
// （v0.4.12 真机反馈：「放在这里行不」）。

import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import {
  IDLE_UPDATE_STATUS,
  readAppVersion,
  startUpdateDownload,
  subscribeUpdateStatus,
  type UpdateStatus,
} from '../../update-status';
import { DownloadIcon } from '../icons';
import styles from './UpdateStatus.module.css';

export function UpdateStatusRow() {
  const { t } = useI18n();
  const [status, setStatus] = useState<UpdateStatus>(IDLE_UPDATE_STATUS);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => subscribeUpdateStatus(setStatus), []);
  useEffect(() => {
    let cancelled = false;
    void readAppVersion().then((version) => {
      if (!cancelled) setAppVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status.phase === 'idle') {
    if (!appVersion) return null;
    const currentHint = t('shell.update.currentVersionHint', { version: appVersion });
    return (
      <span className={`${styles.row} ${styles.version}`} title={currentHint} role="status">
        <span className={styles.label}>v{appVersion}</span>
      </span>
    );
  }

  const busy = ['checking', 'downloading', 'installing'].includes(status.phase);
  const hint =
    status.phase === 'downloading'
      ? t('shell.update.downloadingHint', { version: status.version })
      : status.phase === 'ready'
        ? t(status.manual ? 'shell.update.manualHint' : 'shell.update.readyHint', {
            version: status.version,
          })
        : status.phase === 'checking'
          ? t('shell.update.checking')
          : status.phase === 'installing'
            ? t('shell.update.installing')
            : t('shell.update.availableHint', { version: status.version });
  const label =
    status.phase === 'downloading'
      ? `${status.percent}%`
      : status.phase === 'ready'
        ? t(status.manual ? 'shell.update.openPackage' : 'shell.update.install')
        : status.phase === 'checking'
          ? t('shell.update.checking')
          : status.phase === 'installing'
            ? t('shell.update.installing')
            : t('shell.update.available');

  return (
    <button
      className={`${styles.row} ${busy ? styles.downloading : ''}`}
      type="button"
      disabled={busy}
      title={hint}
      aria-label={hint}
      onClick={busy ? undefined : startUpdateDownload}
      aria-live="polite"
    >
      <DownloadIcon size={15} />
      <span className={styles.label}>{label}</span>
    </button>
  );
}
