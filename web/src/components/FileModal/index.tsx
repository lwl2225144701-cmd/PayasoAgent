import { useEffect, useState } from 'react';
import { readFile } from '../../api';
import { formatBytes } from '../../format';
import { useI18n } from '../../i18n';
import type { FileEntry } from '../../types';
import { CopyButton } from '../CopyButton';
import { IconButton } from '../IconButton';
import { CloseIcon, FileIcon } from '../icons';
import { Modal } from '../Modal';
import styles from './FileModal.module.css';

interface FileModalProps {
  runId: string;
  file: FileEntry;
  onClose: () => void;
}

export function FileModal({ runId, file, onClose }: FileModalProps) {
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(null);
  // 只记失败事实，文案在渲染时按当前语言取（避免把语言快照进 state）
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setFailed(false);
    readFile(runId, file.name)
      .then((resp) => {
        if (!cancelled) setContent(resp.content);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, file.name]);

  return (
    <Modal onClose={onClose} ariaLabel={t('shell.file.preview')}>
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
            <CopyButton text={content} label={t('common.copy')} copiedLabel={t('common.copied')} />
          )}
          <IconButton
            buttonSize="sm"
            variant="ghost"
            shape="rounded"
            onClick={onClose}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <CloseIcon size={16} />
          </IconButton>
        </div>
      </div>
      <div className={styles.body}>
        {failed ? (
          <div className={styles.placeholder}>{t('shell.file.loadFailed')}</div>
        ) : content === null ? (
          <div className={styles.placeholder}>{t('common.loading')}</div>
        ) : (
          <pre className={styles.content}>{content}</pre>
        )}
      </div>
    </Modal>
  );
}
