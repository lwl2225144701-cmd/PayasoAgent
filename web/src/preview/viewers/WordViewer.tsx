// WordViewer：mammoth 把 .docx 转 HTML（标题/列表/表格/加粗），内嵌图片走
// mammoth.images.dataUri（库自带 base64 data URI 转换器，免手写 base64）。
//
// 安全硬门槛（设计 §8）：mammoth 产物**必须**经 DOMPurify 消毒才能进
// dangerouslySetInnerHTML —— docx 是可篡改的 zip，其转换产物不可信。
// legacy .doc（OLE 二进制）mammoth 直接拒绝 → 转 FallbackViewer 下载兜底。

import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { fetchFileBytes, PreviewApiError } from '../api';
import type { ViewerProps } from '../registry';
import type { PreviewErrorCode } from '../types';
import FallbackViewer from './FallbackViewer';
import styles from './WordViewer.module.css';

async function convertDocx(path: string, runId?: string | null): Promise<string> {
  const [mammoth, DOMPurify] = await Promise.all([import('mammoth'), import('dompurify')]);
  const { buffer } = await fetchFileBytes(path, { runId });
  const result = await mammoth.convertToHtml(
    { arrayBuffer: buffer },
    // dataUri：内嵌图 → data URI 内联（与 images.inline 等价，库自带实现）
    { convertImage: mammoth.images.dataUri },
  );
  // 消毒：剥 script/on* 属性/javascript: URL；保留语义标签与表格样式
  return DOMPurify.default.sanitize(result.value, { USE_PROFILES: { html: true } });
}

export default function WordViewer({ path, name, runId }: ViewerProps) {
  const { t } = useI18n();
  const [html, setHtml] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    reason?: PreviewErrorCode;
    detail?: { limit?: number };
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setFailure(null);
    convertDocx(path, runId)
      .then((clean) => {
        if (!cancelled) setHtml(clean);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof PreviewApiError) {
          setFailure({ reason: err.code, detail: err.detail });
        } else {
          // mammoth 对 legacy .doc / 损坏 docx 抛非契约错误：按不支持呈现
          setFailure({ reason: 'unsupported' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, runId]);

  if (failure) {
    return (
      <FallbackViewer path={path} name={name} reason={failure.reason} detail={failure.detail} />
    );
  }
  if (html === null) {
    return <div className={styles.loading}>{t('preview.viewer.loading')}</div>;
  }
  return (
    <div className={styles.doc}>
      {/* 安全边界：html 已过 DOMPurify（USE_PROFILES: html），见 convertDocx；
          mammoth 产物来自可篡改的 docx zip，未消毒不得进 innerHTML（设计 §8 硬门槛） */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify 已消毒，见 convertDocx */}
      <div className={styles.docBody} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
