// Host 上传预处理：验证图片/文本，提取文档正文；不属于 Agent 执行循环。
// 附件解码校验与归一化（docs/attachment-v2-content-store.md P1 期）。
// 设计要点：
// - sharp 动态加载：安装失败/加载抛错 → 降级为"仅魔数嗅探"，功能不回退、
//   启动不阻塞（console.warn 一次）
// - 校验链：魔数 sniff（无依赖前置）→ sharp 完整解码（声明 MIME 必须
//   与实际字节一致）→ 尺寸上限（像素 ≤64M、单边 ≤16384）→ 归一化
// - 归一化：>2048² 总像素按比例下采样（保纵横比），编码目标 ≤4MiB
//   （jpeg/webp 逐级降质量重试，png 降级为调色板重试）；EXIF 方向应用、
//   元数据默认剥离（sharp 默认行为）
// - gif/webp 动图：只校验不重编（动图语义不破坏，多帧 resize 会丢帧）
// - 入库字节 = 归一化后字节（内容寻址对归一化结果去重），originalDimensions
//   记录归一化前原图尺寸

import {
  attachmentKind,
  decodeAttachmentText,
  MAX_OFFICE_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_BYTES,
} from '../../attachment-policy.js';
import { extractDocxText } from './docx.js';
import { extractPptxText } from './pptx.js';
import { extractXlsxText } from './xlsx.js';
import { extractPdfText } from './pdf.js';
import type { CreateRunAttachmentInput } from './types.js';

export const ATTACHMENT_PIXEL_LIMIT = 64 * 1024 * 1024;
export const ATTACHMENT_SIDE_LIMIT = 16_384;
export const NORMALIZE_PIXEL_TARGET = 2048 * 2048;
export const NORMALIZE_BYTES_TARGET = 4 * 1024 * 1024;

type SharpModule = typeof import('sharp')['default'];
type SharpInstance = ReturnType<SharpModule>;

export type PreparedAttachment = CreateRunAttachmentInput;

let sharpPromise: Promise<SharpModule | null> | null = null;
let sharpUnavailableWarned = false;

// 动态加载 sharp（失败不抛：降级路径由调用方处理）
export function loadSharp(): Promise<SharpModule | null> {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((m) => m.default)
      .catch(() => {
        if (!sharpUnavailableWarned) {
          sharpUnavailableWarned = true;
          console.warn('[attachment] sharp 不可用：附件仅做魔数校验，不做解码校验与归一化');
        }
        return null;
      });
  }
  return sharpPromise;
}

// 魔数嗅探（无 sharp 依赖，校验链第一环）：声明 MIME 必须与字节一致
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  const six = bytes.subarray(0, 6).toString('latin1');
  if (six === 'GIF87a' || six === 'GIF89a') return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

const FORMAT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export async function prepareAttachments(
  list: CreateRunAttachmentInput[],
  injectSharp?: SharpModule | null,
): Promise<PreparedAttachment[]> {
  const sharp =
    injectSharp !== undefined
      ? injectSharp
      : list.some((item) => attachmentKind(item.name, item.mimeType) === 'image')
        ? await loadSharp()
        : null;
  return Promise.all(list.map((item) => prepareAttachment(sharp, item)));
}

async function prepareAttachment(
  sharp: SharpModule | null,
  item: CreateRunAttachmentInput,
): Promise<PreparedAttachment> {
  const bytes = Buffer.from(item.dataBase64, 'base64');
  const kind = attachmentKind(item.name, item.mimeType);
  if (kind === 'text') {
    if (bytes.length > MAX_TEXT_BYTES) throw new Error(`附件 ${item.name} 超过 2 MiB 上限`);
    try {
      decodeAttachmentText(bytes);
    } catch {
      throw new Error(`附件 ${item.name} 不是 UTF-8 文本，请转码后重试`);
    }
    return { name: item.name, mimeType: 'text/plain', dataBase64: bytes.toString('base64') };
  }
  if (kind === 'docx' || kind === 'pptx' || kind === 'xlsx' || kind === 'pdf') {
    // 原件不变，正文单独保存。提取失败仍接受原件，供后续工具处理。
    const limit = kind === 'pdf' ? MAX_PDF_BYTES : MAX_OFFICE_BYTES;
    if (bytes.length > limit) throw new Error(`附件 ${item.name} 超过大小上限`);
    try {
      const text =
        kind === 'docx'
          ? extractDocxText(bytes)
          : kind === 'pptx'
            ? extractPptxText(bytes)
            : kind === 'xlsx'
              ? extractXlsxText(bytes)
              : extractPdfText(bytes);
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES)
        throw new Error('提取正文超过 2 MiB，请拆分文档');
      if (!text.trim())
        throw new Error('未能提取文字；可能无文本层或格式不受支持，需要其他工具处理原件');
      return {
        ...item,
        extraction: {
          status: kind === 'pdf' ? 'partial' : 'extracted',
          text,
          ...(kind === 'pdf'
            ? {
                message:
                  'PDF 为简易提取，可能遗漏文字或布局；不支持 OCR 和字体字符映射，必要时使用其他工具处理原件',
              }
            : {}),
        },
      };
    } catch (error) {
      return {
        ...item,
        extraction: {
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  if (kind === 'binary') {
    // .doc/.ppt 旧版 OLE2：无法零依赖解包，原样保留字节（mimeType 透传），
    // 由 Agent 在沙箱里用系统工具（textutil/antiword/python 等）转换。
    if (bytes.length > MAX_OFFICE_BYTES) throw new Error(`附件 ${item.name} 超过 8 MiB 上限`);
    return {
      name: item.name,
      mimeType: item.mimeType || 'application/octet-stream',
      dataBase64: bytes.toString('base64'),
    };
  }
  if (bytes.length === 0) throw new Error(`附件 ${item.name} 内容为空`);
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) throw new Error(`附件 ${item.name} 不是可识别的图片字节`);
  if (sniffed !== item.mimeType) {
    throw new Error(`附件 ${item.name} 声明类型与实际字节不符（${item.mimeType} ≠ ${sniffed}）`);
  }
  if (!sharp) {
    // 降级：仅魔数校验通过，原样入库（与 P0 行为一致）
    return { ...item, dataBase64: bytes.toString('base64') };
  }

  let meta: Awaited<ReturnType<SharpInstance['metadata']>>;
  try {
    meta = await sharp(bytes).metadata();
  } catch (err) {
    throw new Error(
      `附件 ${item.name} 解码失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const expectedFormat = FORMAT_BY_MIME[item.mimeType];
  if (meta.format !== expectedFormat) {
    throw new Error(
      `附件 ${item.name} 声明类型与实际格式不符（${item.mimeType} ≠ ${meta.format}）`,
    );
  }
  // EXIF 方向 ≥5 表示旋转 90°，有效宽高互换
  const oriented = (meta.orientation ?? 1) >= 5;
  const rawWidth = meta.width ?? 0;
  const rawHeight = meta.height ?? 0;
  const effWidth = oriented ? rawHeight : rawWidth;
  const effHeight = oriented ? rawWidth : rawHeight;
  if (
    effWidth <= 0 ||
    effHeight <= 0 ||
    effWidth * effHeight > ATTACHMENT_PIXEL_LIMIT ||
    Math.max(effWidth, effHeight) > ATTACHMENT_SIDE_LIMIT
  ) {
    throw new Error(`附件 ${item.name} 尺寸超限（${effWidth}x${effHeight}）`);
  }
  // 动图（gif 一律、webp 多帧）：只校验不重编
  const animated = item.mimeType === 'image/gif' || (meta.pages ?? 1) > 1;
  // EXIF 方向 ≥5（横躺）必须重编应用方向——模型端解码器通常忽略 EXIF，
  // 原样入库会导致模型看到旋转 90° 的图。下采样同理必须重编。
  const needsOrientationApply = oriented;
  const needsDownscale = effWidth * effHeight > NORMALIZE_PIXEL_TARGET;
  if (animated || (!needsOrientationApply && !needsDownscale)) {
    return {
      ...item,
      width: effWidth,
      height: effHeight,
      originalDimensions:
        effWidth !== rawWidth || effHeight !== rawHeight ? `${rawWidth}x${rawHeight}` : undefined,
    };
  }

  const factor = needsDownscale ? Math.sqrt(NORMALIZE_PIXEL_TARGET / (effWidth * effHeight)) : 1;
  // floor 保证缩放后乘积不超预算（round 在临界处可能越界 0.03%）
  const targetWidth = Math.max(1, Math.floor(effWidth * factor));
  const targetHeight = Math.max(1, Math.floor(effHeight * factor));
  const resizeOptions = { width: targetWidth, height: targetHeight, fit: 'inside' as const };

  let pipeline = sharp(bytes).rotate().resize(resizeOptions);
  if (item.mimeType === 'image/jpeg') {
    pipeline = pipeline.jpeg({ quality: 80 });
  } else if (item.mimeType === 'image/webp') {
    pipeline = pipeline.webp({ quality: 80 });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9 });
  }
  let out = await pipeline.toBuffer({ resolveWithObject: true });

  // 编码预算重试：jpeg/webp 逐级降质量；png 转调色板
  const qualities =
    item.mimeType === 'image/jpeg' ? [60, 45] : item.mimeType === 'image/webp' ? [60, 45] : [];
  for (const quality of qualities) {
    if (out.data.length <= NORMALIZE_BYTES_TARGET) break;
    let retry: SharpInstance;
    if (item.mimeType === 'image/jpeg') {
      retry = sharp(bytes).rotate().resize(resizeOptions).jpeg({ quality });
    } else {
      retry = sharp(bytes).rotate().resize(resizeOptions).webp({ quality });
    }
    out = await retry.toBuffer({ resolveWithObject: true });
  }
  if (item.mimeType === 'image/png' && out.data.length > NORMALIZE_BYTES_TARGET) {
    out = await sharp(bytes)
      .rotate()
      .resize(resizeOptions)
      .png({ compressionLevel: 9, palette: true })
      .toBuffer({ resolveWithObject: true });
  }

  return {
    ...item,
    dataBase64: out.data.toString('base64'),
    width: out.info.width,
    height: out.info.height,
    originalDimensions: `${rawWidth}x${rawHeight}`,
  };
}
