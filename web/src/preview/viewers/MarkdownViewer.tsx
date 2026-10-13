// MarkdownViewer：md/markdown/mdx 的文档级预览。
// 与聊天内 MarkdownText 的区别：① 文档级排版（标题层级/表格/代码块留白）；
// ② 相对路径图片重写为 /preview/file 直链（工作区文档的本地图能显示）；
// ③ 不做 normalizeFences 那套畸形 fence 修复——磁盘文档按原样渲染
//    （磁盘文档按原样渲染，不做畸形 fence 修复）。

import { useEffect, useState } from 'react';
import { MarkdownContent } from '../../components/MarkdownText';
import { useI18n } from '../../i18n';
import { fetchFileText, PreviewApiError } from '../api';
import type { ViewerProps } from '../registry';
import { rewriteRelativeImages } from '../rewrite-relative-images';
import type { PreviewErrorCode } from '../types';
import FallbackViewer from './FallbackViewer';
import styles from './MarkdownViewer.module.css';

/** 'a/b/c.md' → 'a/b'（相对图片的解析基准）。 */
function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

export default function MarkdownViewer({ path, name, runId }: ViewerProps) {
  const { t } = useI18n();
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    reason?: PreviewErrorCode;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMarkdown(null);
    setFailure(null);
    fetchFileText(path, { runId })
      .then((content) => {
        if (!cancelled) setMarkdown(rewriteRelativeImages(content, dirnameOf(path), { runId }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof PreviewApiError) {
          setFailure({ reason: err.code });
        } else {
          setFailure({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, runId]);

  if (failure) {
    return <FallbackViewer path={path} name={name} reason={failure.reason} />;
  }
  if (markdown === null) {
    return <div className={styles.loading}>{t('preview.viewer.loading')}</div>;
  }
  return (
    <div className={styles.doc}>
      <div className={styles.docBody}>
        <MarkdownContent text={markdown} />
      </div>
    </div>
  );
}
