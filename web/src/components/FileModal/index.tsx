import { useState, useEffect } from 'react';
import type { FileEntry } from '../../types';
import { readFile } from '../../api';
import { formatBytes } from '../../format';
import { FileIcon } from '../icons';
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

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  function copyContent() {
    if (content != null) {
      navigator.clipboard?.writeText(content).catch(() => {});
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true">
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.headerIcon}>
            <FileIcon size={16} />
          </div>
          <div className={styles.headerText}>
            <span className={styles.title}>{file.name}</span>
            <span className={styles.meta}>{formatBytes(file.size)}</span>
          </div>
          <div className={styles.headerActions}>
            {content != null && (
              <button className={styles.actionBtn} onClick={copyContent}>
                复制
              </button>
            )}
            <button className={styles.closeBtn} onClick={onClose} aria-label="关闭">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
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
      </div>
    </div>
  );
}
