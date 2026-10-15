// 排队消息的附件预览：图片出 24px 缩略图，其余出小文件卡（图标 + 名字 + 大小）。
//
// 对齐 DSH 的 QueueDock：附件显示在文字**之前**，整块最多占行宽 55%。
// 队列里存的是原始 File，缩略图需要 object URL —— 在这里创建与回收，
// 不让调用方去管这层生命周期（换文件/卸载都会 revoke）。
import { useEffect, useMemo } from 'react';
import { attachmentKind, attachmentSizeLabel } from '../../../../src/attachment-policy';
import { useI18n } from '../../i18n';
import { FileIcon } from '../icons';
import styles from './InputBar.module.css';

export function QueueAttachments({ files }: { files: File[] }) {
  const { t } = useI18n();
  // 只为图片建 object URL；非图片走文件名卡，不需要 URL
  const urls = useMemo(
    () =>
      files.map((file) =>
        attachmentKind(file.name, file.type) === 'image' ? URL.createObjectURL(file) : null,
      ),
    [files],
  );
  useEffect(
    () => () => {
      for (const url of urls) if (url) URL.revokeObjectURL(url);
    },
    [urls],
  );

  if (files.length === 0) return null;
  return (
    <span className={styles.queueAttachments}>
      {files.map((file, index) => {
        const url = urls[index];
        const key = `${file.name}:${index}`;
        return url ? (
          <img
            key={key}
            className={styles.queueThumb}
            src={url}
            alt={t('composer.queue.imageAttachment')}
            title={file.name}
          />
        ) : (
          <span key={key} className={styles.queueFile} title={file.name}>
            <span className={styles.queueFileIcon} aria-hidden="true">
              <FileIcon size={13} />
            </span>
            <span className={styles.queueFileName}>{file.name}</span>
            <span className={styles.queueFileSize}>{attachmentSizeLabel(file.size)}</span>
          </span>
        );
      })}
    </span>
  );
}
