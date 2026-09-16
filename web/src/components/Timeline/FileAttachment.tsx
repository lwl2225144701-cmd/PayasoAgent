// 普通附件卡片：预览只渲染转义文本，下载使用原字节，不执行 HTML。
import { useEffect, useRef, useState } from 'react';
import { readFile, workspaceFileUrl } from '../../api';
import { useI18n } from '../../i18n';
import type { RunAttachment } from '../../types';
import { FileIcon } from '../icons';
import { attachmentSizeLabel } from '../../../../src/attachment-policy';
import styles from './FileAttachment.module.css';

export function FileAttachment({ runId, file }: { runId: string; file: RunAttachment }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function preview() {
    if (loading) return;
    if (open) { setOpen(false); return; }
    setOpen(true);
    setLoading(true);
    setError('');
    try {
      const result = await readFile(runId, file.path);
      if (active.current) setContent(result.content);
    } catch (err) { if (active.current) setError(String(err)); }
    finally { if (active.current) setLoading(false); }
  }
  async function download() {
    if (downloading) return;
    setDownloading(true);
    setError('');
    try {
      const response = await fetch(`${workspaceFileUrl(runId, file.path)}?download=1`, { mode: 'cors' });
      if (!response.ok) throw new Error(await response.text());
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = file.name;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { if (active.current) setError(String(err)); }
    finally { if (active.current) setDownloading(false); }
  }
  return <div className={styles.attachment}>
    <div className={styles.card}>
      <FileIcon size={24} />
      <button type="button" className={styles.info} onClick={() => void preview()} title={file.name} aria-expanded={open} disabled={loading}>
        <span className={styles.name}>{file.name}</span>
        <span className={styles.meta}>{file.name.split('.').pop()?.toUpperCase()}{file.sizeBytes === undefined ? '' : ` · ${attachmentSizeLabel(file.sizeBytes)}`}</span>
      </button>
      <button type="button" onClick={() => void download()} disabled={downloading}>{t('composer.attachment.download')}</button>
    </div>
    {error && <div role="alert" className={styles.error}>{error}</div>}
    {open && <div className={styles.preview}>
      <button type="button" onClick={() => setOpen(false)}>{t('composer.attachment.close')}</button>
      <pre>{loading ? '…' : (content ?? '').slice(0, 65536)}</pre>
      {(content?.length ?? 0) > 65536 && <p>{t('composer.attachment.previewLimited')}</p>}
    </div>}
  </div>;
}
