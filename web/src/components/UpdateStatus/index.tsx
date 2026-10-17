// 侧边栏「设置」旁边的更新条目：发现新版本 / 下载中才出现。
//
// 数据来自桌面壳（preload 桥 → ipc）：
//   - available   → 「新版本 v0.4.12」+ 点击开始下载
//   - downloading → 「正在下载 45%」+ 底部细进度条（真机要求：按百分比显示）
// 浏览器里没有壳的桥 → 状态永远 idle → 这个组件不渲染任何东西。

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
  // 百分比只放在右侧一处（左侧再写一遍就成了 "正在下载 96% ... 96%" 的重复）
  const label = downloading
    ? t('shell.update.downloading', { version: status.version })
    : t('shell.update.available', { version: status.version });

  return (
    <button
      className={styles.row}
      type="button"
      disabled={downloading}
      title={downloading ? t('shell.update.downloadingHint') : t('shell.update.availableHint')}
      aria-label={label}
      onClick={downloading ? undefined : startUpdateDownload}
    >
      <span className={styles.head}>
        <DownloadIcon size={16} />
        <span className={styles.label}>{label}</span>
        {downloading && <span className={styles.percent}>{status.percent}%</span>}
      </span>
      {downloading && (
        <span className={styles.bar}>
          <span className={styles.fill} style={{ width: `${status.percent}%` }} />
        </span>
      )}
    </button>
  );
}
