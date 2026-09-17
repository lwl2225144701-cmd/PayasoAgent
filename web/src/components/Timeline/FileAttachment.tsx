// 附件卡片：文本类（含 docx/pptx/xlsx/pdf 解包产物）可预览（只渲染转义
// 文本）与下载；二进制类（.doc/.ppt）read 读不了，只提供下载并提示。
import { useEffect, useRef, useState } from 'react';
import { readFile, workspaceFileUrl } from '../../api';
import { useI18n } from '../../i18n';
import type { RunAttachment } from '../../types';
import { FileIcon } from '../icons';
import { attachmentSizeLabel } from '../../../../src/attachment-policy';
import styles from './FileAttachment.module.css';

export function FileAttachment({ runId, file }: { runId: string; file: RunAttachment }) {
  const { t } = useI18n();
  const binary = file.kind === 'binary';
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
      {binary ? (
        <div className={styles.info} title={file.name}>
          <span className={styles.name}>{file.name}</span>
          <span className={styles.meta}>{file.name.split('.').pop()?.toUpperCase()}{file.sizeBytes === undefined ? '' : ` · ${attachmentSizeLabel(file.sizeBytes)}`}</span>
        </div>
      ) : (
        <button type="button" className={styles.info} onClick={() => void preview()} title={file.name} aria-expanded={open} disabled={loading}>
          <span className={styles.name}>{file.name}</span>
          <span className={styles.meta}>{file.name.split('.').pop()?.toUpperCase()}{file.sizeBytes === undefined ? '' : ` · ${attachmentSizeLabel(file.sizeBytes)}`}</span>
        </button>
      )}
      <button type="button" onClick={() => void download()} disabled={downloading}>{t('composer.attachment.download')}</button>
    </div>
    {binary && <p className={styles.binaryNote}>{t('composer.attachment.binaryNote')}</p>}
    {error && <div role="alert" className={styles.error}>{error}</div>}
    {!binary && open && <div className={styles.preview}>
      <button type="button" onClick={() => setOpen(false)}>{t('composer.attachment.close')}</button>
      <pre>{loading ? '…' : (content ?? '').slice(0, 65536)}</pre>
      {(content?.length ?? 0) > 65536 && <p>{t('composer.attachment.previewLimited')}</p>}
    </div>}
  </div>;
}
