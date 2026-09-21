// 附件卡片：预览提取正文或普通文本，下载始终使用原件路径。
import { useEffect, useRef, useState } from 'react';
import { readFile, downloadWorkspaceFile } from '../../api';
import { useI18n } from '../../i18n';
import type { RunAttachment } from '../../types';
import { FileIcon } from '../icons';
import { attachmentSizeLabel } from '../../../../src/attachment-policy';
import styles from './FileAttachment.module.css';

export function FileAttachment({ runId, file }: { runId: string; file: RunAttachment }) {
  const { t } = useI18n();
  const previewPath = file.extraction?.path ?? (file.kind === 'binary' ? undefined : file.path);
  const binary = !previewPath;
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function preview() {
    if (loading) return;
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError('');
    try {
      const result = await readFile(runId, previewPath!);
      if (active.current) setContent(result.content);
    } catch (err) {
      if (active.current) setError(String(err));
    } finally {
      if (active.current) setLoading(false);
    }
  }
  async function download() {
    if (downloading) return;
    setDownloading(true);
    setError('');
    try {
      await downloadWorkspaceFile(runId, file.path, file.name);
    } catch (err) {
      if (active.current) setError(String(err));
    } finally {
      if (active.current) setDownloading(false);
    }
  }
  return (
    <div className={styles.attachment}>
      <div className={styles.card}>
        <FileIcon size={24} />
        {binary ? (
          <div className={styles.info} title={file.name}>
            <span className={styles.name}>{file.name}</span>
            <span className={styles.meta}>
              {file.name.split('.').pop()?.toUpperCase()}
              {file.sizeBytes === undefined ? '' : ` · ${attachmentSizeLabel(file.sizeBytes)}`}
            </span>
          </div>
        ) : (
          <button
            type="button"
            className={styles.info}
            onClick={() => void preview()}
            title={file.name}
            aria-expanded={open}
            disabled={loading}
          >
            <span className={styles.name}>{file.name}</span>
            <span className={styles.meta}>
              {file.name.split('.').pop()?.toUpperCase()}
              {file.sizeBytes === undefined ? '' : ` · ${attachmentSizeLabel(file.sizeBytes)}`}
            </span>
          </button>
        )}
        <button type="button" onClick={() => void download()} disabled={downloading}>
          {t('composer.attachment.download')}
        </button>
      </div>
      {file.extraction?.message && <p className={styles.binaryNote}>{file.extraction.message}</p>}
      {binary && !file.extraction && (
        <p className={styles.binaryNote}>{t('composer.attachment.binaryNote')}</p>
      )}
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      {!binary && open && (
        <div className={styles.preview}>
          <button type="button" onClick={() => setOpen(false)}>
            {t('composer.attachment.close')}
          </button>
          <pre>{loading ? '…' : (content ?? '').slice(0, 65536)}</pre>
          {(content?.length ?? 0) > 65536 && <p>{t('composer.attachment.previewLimited')}</p>}
        </div>
      )}
    </div>
  );
}
