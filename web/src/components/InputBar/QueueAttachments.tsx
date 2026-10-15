// 排队消息的附件预览：图片出 24px 缩略图，其余出小文件卡（图标 + 名字 + 大小）。
//
// 对齐 DSH 的 QueueDock：附件显示在文字**之前**，整块最多占行宽 55%。
// 队列里存的是原始 File，缩略图需要 object URL —— 在这里创建与回收，
// 不让调用方去管这层生命周期（换文件/卸载都会 revoke）。
import { useEffect, useState } from 'react';
import { attachmentKind, attachmentSizeLabel } from '../../../../src/attachment-policy';
import { useI18n } from '../../i18n';
import { FileIcon } from '../icons';
import styles from './InputBar.module.css';

export function QueueAttachments({ files }: { files: File[] }) {
  const { t } = useI18n();
  // 只为图片建 object URL；非图片走文件名卡，不需要 URL。
  //
  // **URL 必须在 effect 内部创建**（不能 useMemo 后再在 effect 里清理）：
  // StrictMode 会把 effect 跑两遍（setup → cleanup → setup）。若 URL 来自 useMemo，
  // 第一次 cleanup 会把**仍在用的**那个 revoke 掉，第二次 setup 因为依赖没变拿回的
  // 还是同一个已失效的 URL —— 表现就是图片裂开。
  // 放在 effect 里，每次 setup 新建一批，cleanup 只回收自己那一批。
  const [urls, setUrls] = useState<(string | null)[]>([]);
  useEffect(() => {
    const created = files.map((file) =>
      attachmentKind(file.name, file.type) === 'image' ? URL.createObjectURL(file) : null,
    );
    setUrls(created);
    return () => {
      for (const url of created) if (url) URL.revokeObjectURL(url);
    };
  }, [files]);

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
