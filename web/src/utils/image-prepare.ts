// 粘贴图片的客户端预处理（附件 v2 P2）：发送前把像素压到模型预算内，
// 请求体从 20MB 级降回 ~2MB 级。Host 侧 sharp 仍做最终校验/归一化兜底，
// 这里纯粹为了缩请求体。
// - gif 跳过：canvas 重编会丢动画帧，原样上传（Host 对 gif 也是透传）
// - 同格式重编：png→png（保透明）、jpeg→jpeg、webp→webp；
//   浏览器不支持目标格式编码时（如 Safari 的 webp），以实际产出 type 为准
// - 任何一步失败 → 回退原始字节（功能不因浏览器差异而不可用）

export const CLIENT_PIXEL_TARGET = 2048 * 2048;
export const CLIENT_BYTES_TARGET = 2 * 1024 * 1024;
export const CLIENT_QUALITY_LADDER = [0.8, 0.6, 0.45] as const;

export interface DownscaleDims {
  width: number;
  height: number;
}

/** 超出像素预算时按比例缩小（floor 保证乘积不超预算）；不需要缩放返回 null */
export function downscaleDims(
  width: number,
  height: number,
  pixelTarget: number = CLIENT_PIXEL_TARGET,
): DownscaleDims | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const pixels = width * height;
  if (pixels <= pixelTarget) return null;
  const factor = Math.sqrt(pixelTarget / pixels);
  return {
    width: Math.max(1, Math.floor(width * factor)),
    height: Math.max(1, Math.floor(height * factor)),
  };
}

export interface PreparedUploadImage {
  dataBase64: string;
  mimeType: string;
}

async function fileToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const view = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function prepareImageForUpload(file: File): Promise<PreparedUploadImage> {
  // gif：canvas 重编丢动画，原样上传
  if (file.type === 'image/gif') {
    return { dataBase64: await fileToBase64(file), mimeType: file.type };
  }
  try {
    const bitmap = await createImageBitmap(file);
    const dims = downscaleDims(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(
      dims ? dims.width : bitmap.width,
      dims ? dims.height : bitmap.height,
    );
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d 上下文不可用');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    // png 无质量参数，单次编码；jpeg/webp 按阶梯重试压到字节预算
    const qualities: (number | undefined)[] =
      file.type === 'image/png' ? [undefined] : [...CLIENT_QUALITY_LADDER];
    let blob: Blob | null = null;
    for (const quality of qualities) {
      const encoded = await canvas.convertToBlob({
        type: file.type,
        ...(quality !== undefined ? { quality } : {}),
      });
      blob = encoded;
      if (encoded.size <= CLIENT_BYTES_TARGET) break;
    }
    if (!blob) throw new Error('图片编码失败');
    // 浏览器可能不支持目标类型编码而回退（如 webp → png），以实际产出为准
    const mimeType = blob.type || file.type;
    return { dataBase64: await fileToBase64(blob), mimeType };
  } catch {
    // 回退：原样上传（Host sharp 归一化兜底）
    return {
      dataBase64: await fileToBase64(file),
      mimeType: file.type || 'application/octet-stream',
    };
  }
}
