import { useEffect, useState } from 'react';
import { readFile } from '../../api';
import { formatBytes } from '../../format';
import { useI18n } from '../../i18n';
import type { FileEntry } from '../../types';
import { CopyButton } from '../CopyButton';
import { IconButton } from '../IconButton';
import { CloseIcon, FileIcon } from '../icons';
import { MarkdownText } from '../MarkdownText';
import { Modal } from '../Modal';
import styles from './FileModal.module.css';

interface FileModalProps {
  runId: string;
  file: FileEntry;
  onClose: () => void;
}

/** 按扩展名决定是否按 Markdown 预览；其余文件仍按源码原样显示。 */
const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i;

export function FileModal({ runId, file, onClose }: FileModalProps) {
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(null);
  // 只记失败事实，文案在渲染时按当前语言取（避免把语言快照进 state）
  const [failed, setFailed] = useState(false);
  const isMarkdown = MARKDOWN_FILE.test(file.name);

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
        ) : isMarkdown ? (
          // Markdown 文件按渲染后的样子预览（与聊天里同一套元素主题）。
          // 这里刻意**不做** normalizeFences 那套畸形 fence 修复：它是面向模型聊天输出的
          // 预处理，而这里展示的是磁盘上的文档本身 —— 文件长什么样就该显示成什么样，
          // 与编辑器 / 代码托管平台的渲染保持一致。
          <div className={styles.markdown}>
            <MarkdownText text={content} />
          </div>
        ) : (
          <pre className={styles.content}>{content}</pre>
        )}
      </div>
    </Modal>
  );
}
