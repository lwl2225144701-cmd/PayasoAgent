// FallbackViewer：无法渲染时的统一兜底 UI。
// 两种出场：① registry 直接指向（M2 的 pdf/docx/xlsx，reason='pending'）；
// ② 其它 viewer 加载失败时转交（reason=错误码）。都提供下载入口。

import { formatBytes } from '../../format';
import { useI18n } from '../../i18n';
import { previewFileUrl } from '../api';
import type { ViewerProps } from '../registry';
import { FileIconFor, fileIconName } from '../registry';
import type { PreviewErrorCode } from '../types';
import styles from './viewer-common.module.css';

export interface FallbackViewerProps extends ViewerProps {
  /** pending = 类型预览暂未提供（M3 上线）；错误码 = 加载失败原因；缺省 = 通用失败。 */
  reason?: 'pending' | PreviewErrorCode;
  /** too_large 时携带上限字节数。 */
  detail?: { limit?: number };
}

export default function FallbackViewer({ path, name, runId, reason, detail }: FallbackViewerProps) {
  const { t } = useI18n();
  const reasonText = (() => {
    switch (reason) {
      case 'pending':
        return t('preview.viewer.reason.pending');
      case 'unsupported':
        return t('preview.viewer.reason.unsupported');
      case 'too_large':
        return t('preview.viewer.reason.too_large', {
          limit: formatBytes(detail?.limit ?? 0),
        });
      case 'not_found':
        return t('preview.viewer.reason.not_found');
      case 'permission_denied':
        return t('preview.viewer.reason.permission_denied');
      case 'outside_workspace':
        return t('preview.viewer.reason.outside_workspace');
      case 'invalid_path':
        return t('preview.viewer.reason.invalid_path');
      case 'no_workspace':
        return t('preview.viewer.reason.no_workspace');
      default:
        return t('preview.viewer.reason.loadFailed');
    }
  })();

  return (
    <div className={styles.fallback}>
      <div className={styles.fallbackIcon}>
        <FileIconFor name={fileIconName(name)} size={22} />
      </div>
      <div className={styles.fallbackName}>{name}</div>
      <div className={styles.fallbackReason}>{reasonText}</div>
      <div className={styles.fallbackActions}>
        {/* download 属性：浏览器下载而非导航；直链由 Host 做路径校验 */}
        <a className={styles.downloadLink} href={previewFileUrl(path, { runId })} download={name}>
          {t('preview.viewer.download')}
        </a>
      </div>
    </div>
  );
}
