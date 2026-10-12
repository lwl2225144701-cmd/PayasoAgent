// TextViewer：txt / 代码 / 无扩展名文件的文本预览（registry 兜底条目）。
// 行号 + 等宽；加载失败（含后端 415 已知二进制）转 FallbackViewer 下载兜底。

import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { fetchFileText, PreviewApiError } from '../api';
import type { ViewerProps } from '../registry';
import type { PreviewErrorCode } from '../types';
import FallbackViewer from './FallbackViewer';
import styles from './TextViewer.module.css';

export default function TextViewer({ path, name, runId }: ViewerProps) {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    reason?: PreviewErrorCode;
    detail?: { limit?: number };
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setFailure(null);
    fetchFileText(path, { runId })
      .then((content) => {
        if (!cancelled) setText(content);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof PreviewApiError) {
          setFailure({ reason: err.code, detail: err.detail });
        } else {
          setFailure({});
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
  if (text === null) {
    return <div className={styles.loading}>{t('preview.viewer.loading')}</div>;
  }

  const lines = text.split('\n');
  return (
    <div className={styles.wrap}>
      <pre className={styles.pre}>
        <code>
          {lines.map((line, i) => (
            // 行号视图：行是位置性身份（无重排/无中间增删），index 即稳定 key
            // biome-ignore lint/suspicious/noArrayIndexKey: 行号预览按位置渲染，index 是行的稳定身份
            <span className={styles.line} key={i}>
              <span className={styles.lineNo}>{i + 1}</span>
              <span className={styles.lineText}>{line || ' '}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
