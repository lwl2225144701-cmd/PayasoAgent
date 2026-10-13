// 用户消息图片附件的**尺寸决策** —— 纯函数，无 DOM、无 React，便于单测。
//
// 对齐 DSH 的 Message Images：这一层不做响应式，不看视图宽度、不用容器查询，
// 显示尺寸只由「变体 + 原图 intrinsic 宽高」决定。变体分派是唯一的尺寸决策点
// （DSH MessageImage.tsx:178 的同一条件）。
//
// 三个变体：
//   single     单张图、无 compact —— singleFit() 按长边 240 动态算框
//   tile       compact，或组内多于 1 张 —— 固定 64×64 方格，cover 居中裁
//   thumbnail  调用方显式要求 —— 固定 48×48，contain 不裁
//              （DSH 的 Trajectory 附件行用它；本仓暂无消费方，保留契约）

export type MessageImageVariant = 'single' | 'tile' | 'thumbnail';

/** 单图长边基准（px）。 */
export const SINGLE_LONG_EDGE = 240;
/** 多附件组里的方格边长（px）。 */
export const TILE_SIZE = 64;
/** 列表缩略图边长（px）。 */
export const THUMBNAIL_SIZE = 48;
/** 渲染宽高比夹紧区间；超出部分交给 object-fit: cover 裁掉。 */
export const MIN_ASPECT = 0.25;
export const MAX_ASPECT = 4;

export interface ImageBox {
  width: number;
  height: number;
  /** cover 裁切锚点：极高图顶对齐、极宽图左对齐，其余居中。 */
  objectPosition: string;
}

/**
 * 变体分派（唯一的尺寸决策点）。
 * thumbnail 优先级最高；compact 由调用方给（用户消息气泡：附件多于 1 个即 compact，
 * 所以"1 张图 + 1 个文档"里的图也是 64px 方格）；count 覆盖 Assistant 正文那种
 * 连续图片块合并成 gallery、没有 compact 的场景。
 */
export function messageImageVariant(opts: {
  thumbnail?: boolean;
  compact?: boolean;
  count: number;
}): MessageImageVariant {
  if (opts.thumbnail) return 'thumbnail';
  if (opts.compact || opts.count > 1) return 'tile';
  return 'single';
}

/** 固定方格变体的显示框。 */
export function squareBox(variant: Exclude<MessageImageVariant, 'single'>): ImageBox {
  const size = variant === 'thumbnail' ? THUMBNAIL_SIZE : TILE_SIZE;
  return { width: size, height: size, objectPosition: 'center' };
}

/**
 * 单图显示框：长边 240 基准、渲染宽高比夹紧到 [0.25, 4]、从不放大。
 *
 * 1. 先按**夹紧后**的比例算出 240 长边的框（超出真实比例的部分由 cover 裁掉）；
 * 2. scale = min(1, 原宽/框宽, 原高/框高) —— 所以小图按原始像素显示，不放大；
 * 3. 结果取整且每边 ≥1（0 宽/0 高会被浏览器当隐藏）。
 *
 * 宽高缺失/为 0（尚未探测出、或解码失败）时按 240×240 方格兜底。
 */
export function singleFit(naturalWidth: number, naturalHeight: number): ImageBox {
  const w = naturalWidth > 0 ? naturalWidth : SINGLE_LONG_EDGE;
  const h = naturalHeight > 0 ? naturalHeight : SINGLE_LONG_EDGE;
  const rawAspect = w / h;
  const aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, rawAspect));
  const boxW = aspect >= 1 ? SINGLE_LONG_EDGE : SINGLE_LONG_EDGE * aspect;
  const boxH = aspect >= 1 ? SINGLE_LONG_EDGE / aspect : SINGLE_LONG_EDGE;
  const scale = Math.min(1, w / boxW, h / boxH);
  return {
    width: Math.max(1, Math.round(boxW * scale)),
    height: Math.max(1, Math.round(boxH * scale)),
    objectPosition:
      rawAspect < MIN_ASPECT ? 'center top' : rawAspect > MAX_ASPECT ? 'left center' : 'center',
  };
}

/**
 * 单图显示框的**来源优先级**：Host 随附件发布的宽高 → <img> onLoad 探测到的
 * → 240×240 兜底。
 *
 * Host 那份（归一化后、EXIF 已应用）在图片加载前就存在，所以正常路径第一帧
 * 就是最终尺寸，没有跳动；只有历史事件缺这两个字段时才轮到探测。
 */
export function singleBox(opts: {
  width?: number;
  height?: number;
  measured?: ImageBox | null;
}): ImageBox {
  if (opts.width && opts.height) return singleFit(opts.width, opts.height);
  return opts.measured ?? singleFit(0, 0);
}
