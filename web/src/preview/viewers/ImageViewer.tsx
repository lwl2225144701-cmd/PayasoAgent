// ImageViewer：图片 lightbox —— 适应窗口 + 缩放/平移/复位。
// 加载失败（404 被外部删除 / 403 symlink 逃逸）转 FallbackViewer。

import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { previewFileUrl } from '../api';
import type { ViewerProps } from '../registry';
import FallbackViewer from './FallbackViewer';
import styles from './ImageViewer.module.css';

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const SCALE_STEP = 0.25;

export default function ImageViewer({ path, name, runId }: ViewerProps) {
  // 挂载级缓存破坏：外部改文件后重挂载时确保 <img> 拿到新字节
  const mountId = useMemo(() => Date.now().toString(36), []);
  const { t } = useI18n();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <FallbackViewer path={path} name={name} />;
  }

  const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

  return (
    <div className={styles.stage}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => setScale((s) => clampScale(s - SCALE_STEP))}
          title={t('preview.viewer.image.zoomOut')}
          aria-label={t('preview.viewer.image.zoomOut')}
        >
          −
        </button>
        <span className={styles.scaleLabel}>{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => setScale((s) => clampScale(s + SCALE_STEP))}
          title={t('preview.viewer.image.zoomIn')}
          aria-label={t('preview.viewer.image.zoomIn')}
        >
          +
        </button>
        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => {
            setScale(1);
            setOffset({ x: 0, y: 0 });
          }}
          title={t('preview.viewer.image.reset')}
          aria-label={t('preview.viewer.image.reset')}
        >
          {t('preview.viewer.image.reset')}
        </button>
      </div>
      <div
        className={styles.canvas}
        onWheel={(event) => {
          // 滚轮缩放：ctrl/踩住灵敏步进，否则整步进（触控板连续滚动更可控）
          if (!event.ctrlKey && Math.abs(event.deltaY) < 40) return;
          event.preventDefault();
          setScale((s) => clampScale(s - Math.sign(event.deltaY) * SCALE_STEP));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const startX = event.clientX - offset.x;
          const startY = event.clientY - offset.y;
          const target = event.currentTarget;
          target.setPointerCapture(event.pointerId);
          const move = (e: PointerEvent) =>
            setOffset({ x: e.clientX - startX, y: e.clientY - startY });
          const up = () => {
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
          };
          target.addEventListener('pointermove', move);
          target.addEventListener('pointerup', up);
        }}
      >
        <img
          className={styles.img}
          src={`${previewFileUrl(path, { runId })}&v=${mountId}`}
          alt={name}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          onError={() => setFailed(true)}
          draggable={false}
        />
      </div>
    </div>
  );
}
