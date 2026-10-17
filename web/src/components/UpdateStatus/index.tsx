// 侧边栏底部「设置」同一行右侧的更新条目：发现新版本 / 下载中才出现。
//
// 数据来自桌面壳（preload 桥 → ipc）：
//   - available   → 「⬇ 新版本」+ 点击开始下载（tooltip 带版本号）
//   - downloading → 「⬇ 45%」（真机要求：按百分比显示）
// 浏览器里没有壳的桥 → 状态永远 idle → 这个组件不渲染任何东西。
// 为什么塞进设置那一行：单独占一行会跟「设置」抢视觉重量、且左右留白对不齐
// （v0.4.12 真机反馈：「放在这里行不」）。

import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import {
  IDLE_UPDATE_STATUS,
  startUpdateDownload,
  subscribeUpdateStatus,
  type UpdateStatus,
} from '../../update-status';
import { DownloadIcon } from '../icons';
import styles from './UpdateStatus.module.css';

export function UpdateStatusRow() {
  const { t } = useI18n();
  const [status, setStatus] = useState<UpdateStatus>(IDLE_UPDATE_STATUS);

  useEffect(() => subscribeUpdateStatus(setStatus), []);

  if (status.phase === 'idle') return null;
  const downloading = status.phase === 'downloading';
  const hint = downloading
    ? t('shell.update.downloadingHint', { version: status.version })
    : t('shell.update.availableHint', { version: status.version });
  const label = downloading ? `${status.percent}%` : t('shell.update.available');

  return (
    <button
      className={`${styles.row} ${downloading ? styles.downloading : ''}`}
      type="button"
      disabled={downloading}
      title={hint}
      aria-label={hint}
      onClick={downloading ? undefined : startUpdateDownload}
    >
      <DownloadIcon size={15} />
      <span className={styles.label}>{label}</span>
    </button>
  );
}
