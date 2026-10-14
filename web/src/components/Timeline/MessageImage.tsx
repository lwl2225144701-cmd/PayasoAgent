// 用户消息里的图片附件 —— 只做「测量 + 渲染」，尺寸决策全在 message-image.ts。
//
// 对齐 DSH 的 MessageImage：尺寸**不靠 CSS 宽高**，而是把 singleFit() 的结果写成
// 盒子上的 inline style；<img> 在 CSS 里恒为 100%×100%（cover 居中裁，thumbnail
// 变体改成 contain）。加载态与失败态沿用同一个尺寸盒，所以重试文案变长也不会
// 撑大布局、不会让整条消息跳动。
//
// 与 DSH 的差异已经消掉：宽高来自 Host 随 `run_started.attachments` 一起发布的
// attachment.width/height（归一化后、EXIF 已应用），所以单图在**图片加载前**就能
// 算出显示框，没有首帧跳动。历史事件没有这两个字段时退回 onLoad 探测，仍未探测出
// 之前用 240×240 兜底。
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { ImageLightbox } from './ImageLightbox';
import styles from './MessageImage.module.css';
import {
  type ImageBox,
  messageImageVariant,
  singleBox,
  singleFit,
  squareBox,
} from './message-image';

export interface MessageImageProps {
  /** 原图直链（左键开灯箱；中键/Cmd/右键仍走新标签页拿原件）。 */
  href: string;
  /** 文件名（title / alt）。 */
  name: string;
  /** 本条消息是否 compact：附件多于 1 个时，图片降级为 64px 方格。 */
  compact?: boolean;
  /** 本组图片张数（> 1 时自动走方格）。 */
  count: number;
  /** 显式要求 48px contain 缩略图。 */
  thumbnail?: boolean;
  /** 归一化后的像素宽高（Host 随附件发布）；缺省时退回 onLoad 探测。 */
  width?: number;
  height?: number;
}

export function MessageImage({
  href,
  name,
  compact,
  count,
  thumbnail,
  width,
  height,
}: MessageImageProps) {
  const { t } = useI18n();
  const variant = messageImageVariant({ compact, count, thumbnail });
  const [measured, setMeasured] = useState<ImageBox | null>(null);
  const [failed, setFailed] = useState(false);
  // 重试计数：当作 <img> 的 key，换 key 即重新发起一次请求
  const [attempt, setAttempt] = useState(0);
  const [lightbox, setLightbox] = useState(false);

  // 固定变体当场就有框；单图走来源优先级（Host 宽高 → onLoad 探测 → 240×240 兜底）。
  const box = variant === 'single' ? singleBox({ width, height, measured }) : squareBox(variant);
  const boxStyle = { width: box.width, height: box.height };

  if (failed) {
    return (
      <button
        type="button"
        className={styles.box}
        style={boxStyle}
        data-variant={variant}
        onClick={() => {
          setFailed(false);
          setAttempt((n) => n + 1);
        }}
        title={name}
      >
        <span className={styles.retry}>{t('common.retry')}</span>
      </button>
    );
  }

  return (
    <>
      <a
        className={styles.box}
        style={boxStyle}
        data-variant={variant}
        href={href}
        target="_blank"
        rel="noreferrer"
        title={name}
        // 左键点开灯箱；不 preventDefault 之外的修饰点击（中键 / Cmd / 右键）
        // 仍走浏览器原生的"新标签页打开"，保留直接拿到原件的能力。
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          setLightbox(true);
        }}
      >
        <img
          key={attempt}
          className={styles.img}
          style={{ objectPosition: box.objectPosition }}
          src={href}
          alt={name}
          loading="lazy"
          onLoad={(event) => {
            // 单图才需要按原图收敛；Host 已经给了宽高就不必再探测
            if (variant !== 'single' || (width && height)) return;
            const img = event.currentTarget;
            setMeasured(singleFit(img.naturalWidth, img.naturalHeight));
          }}
          onError={() => setFailed(true)}
        />
      </a>
      {lightbox && <ImageLightbox src={href} name={name} onClose={() => setLightbox(false)} />}
    </>
  );
}
