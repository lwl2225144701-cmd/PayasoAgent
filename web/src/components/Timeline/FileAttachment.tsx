// 附件卡片：预览提取正文或普通文本，下载始终使用原件路径。
//
// 图标按文件类型着色（PDF 红 / Word 蓝 / 表格绿 / 幻灯片橙 / 图片蓝灰），
// 类型判定与图标取自共享模块 components/file-kind（扩展名只在那里出现一次，
// FileTree / 标签栏 / FallbackViewer 与本卡片同一来源）。
import { useEffect, useRef, useState } from 'react';
import { attachmentSizeLabel } from '../../../../src/attachment-policy';
import { downloadWorkspaceFile, readFile } from '../../api';
import { useI18n } from '../../i18n';
import type { RunAttachment } from '../../types';
import { FileKindIcon, fileKindOf } from '../file-kind';
import { DownloadIcon, PreviewIcon } from '../icons';
import styles from './FileAttachment.module.css';

export function FileAttachment({
  runId,
  file,
  onOpenPreview,
}: {
  runId: string;
  file: RunAttachment;
  /** M4：在右侧预览面板里打开原件（pdf/docx/xlsx 等 binary 附件也适用）。 */
  onOpenPreview?: (path: string, name: string, runId: string) => void;
}) {
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
  const kind = fileKindOf(file.name);
  const meta = [
    file.name.split('.').pop()?.toUpperCase(),
    file.sizeBytes === undefined ? '' : attachmentSizeLabel(file.sizeBytes),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={styles.attachment}>
      <div className={styles.card}>
        <span className={styles.glyph} data-kind={kind} aria-hidden="true">
          <FileKindIcon kind={kind} size={20} />
        </span>
        {binary ? (
          <div className={styles.info} title={file.name}>
            <span className={styles.name}>{file.name}</span>
            <span className={styles.meta}>{meta}</span>
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
            <span className={styles.meta}>{meta}</span>
          </button>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            onClick={() => void download()}
            disabled={downloading}
            title={t('composer.attachment.download')}
          >
            <DownloadIcon size={13} />
            {t('composer.attachment.download')}
          </button>
          {onOpenPreview && (
            <button
              type="button"
              className={styles.action}
              onClick={() => onOpenPreview(file.path, file.name, runId)}
              title={file.path}
            >
              <PreviewIcon size={13} />
              {t('composer.attachment.preview')}
            </button>
          )}
        </div>
      </div>
      {/* 提取说明（"PDF 为简易提取…"）不渲染：卡片自带「预览」入口，长注释是噪音。
          Host 仍照旧产出 extraction.message —— 那是模型可见的附件清单内容。 */}
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
