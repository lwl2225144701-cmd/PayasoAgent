import { useState, useEffect } from 'react';
import type { FileEntry } from '../../types';
import { readFile } from '../../api';
import { formatBytes } from '../../format';
import { CloseIcon, FileIcon } from '../icons';
import { Modal } from '../Modal';
import { CopyButton } from '../CopyButton';
import { IconButton } from '../IconButton';
import styles from './FileModal.module.css';

interface FileModalProps {
  runId: string;
  file: FileEntry;
  onClose: () => void;
}

export function FileModal({ runId, file, onClose }: FileModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    readFile(runId, file.name)
      .then(resp => {
        if (!cancelled) setContent(resp.content);
      })
      .catch(() => {
        if (!cancelled) setError('加载文件内容失败。');
      });
    return () => {
      cancelled = true;
    };
  }, [runId, file.name]);

  return (
    <Modal onClose={onClose} ariaLabel="文件预览">
      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <FileIcon size={16} />
        </div>
        <div className={styles.headerText}>
          <span className={styles.title}>{file.name}</span>
          <span className={styles.meta}>{formatBytes(file.size)}</span>
        </div>
        <div className={styles.headerActions}>
          {content != null && <CopyButton text={content} label="复制" copiedLabel="已复制" />}
          <IconButton
            buttonSize="sm"
            variant="ghost"
            shape="rounded"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <CloseIcon size={16} />
          </IconButton>
        </div>
      </div>
      <div className={styles.body}>
        {error ? (
          <div className={styles.placeholder}>{error}</div>
        ) : content === null ? (
          <div className={styles.placeholder}>加载中…</div>
        ) : (
          <pre className={styles.content}>{content}</pre>
        )}
      </div>
    </Modal>
  );
}
