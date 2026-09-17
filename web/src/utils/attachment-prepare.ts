// 文本不做有损转换；文档类（docx/pptx/xlsx/pdf）与旧版二进制（doc/ppt）
// 原样上传（Host 端解包提取或交由 Agent 工具转换），图片继续走现有归一化，
// 类型与限制和 Host 共用（attachment-policy 单一来源）。
// 异常文案走 translate（语言是入参，模块内不留隐藏语言状态，与 image-prepare 一致）。
import { attachmentKind, decodeAttachmentText, MAX_OFFICE_BYTES, MAX_PDF_BYTES, MAX_TEXT_BYTES } from '../../../src/attachment-policy';
import { translate } from '../i18n/translate';
import { alignedAttachmentName, prepareImageForUpload } from './image-prepare';
import type { Language } from '../i18n/translate';

const OFFICE_MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  ppt: 'application/vnd.ms-powerpoint',
};

export async function prepareAttachmentForUpload(file: File, language: Language) {
  const kind = attachmentKind(file.name, file.type);
  if (kind === 'image') {
    const prepared = await prepareImageForUpload(file, language);
    return { name: alignedAttachmentName(file.name.replace(/[\\/]/g, '_') || 'image.png', prepared.mimeType), mimeType: prepared.mimeType, dataBase64: prepared.dataBase64 };
  }
  if (kind !== 'text') {
    if (kind === 'pdf') {
      if (file.size > MAX_PDF_BYTES) throw new Error(translate(language, 'composer.attachment.pdfTooLarge', { name: file.name }));
    } else if (file.size > MAX_OFFICE_BYTES) {
      throw new Error(translate(language, 'composer.attachment.officeTooLarge', { name: file.name }));
    }
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const mimeType = kind === 'pdf' ? 'application/pdf' : OFFICE_MIME[ext] ?? 'application/octet-stream';
    return { name: file.name, mimeType, dataBase64: await blobToBase64(file) };
  }
  if (file.size > MAX_TEXT_BYTES) throw new Error(translate(language, 'composer.attachment.textTooLarge', { name: file.name }));
  const bytes = new Uint8Array(await file.arrayBuffer());
  try { decodeAttachmentText(bytes); } catch { throw new Error(translate(language, 'composer.attachment.notUtf8', { name: file.name })); }
  return { name: file.name, mimeType: 'text/plain', dataBase64: await blobToBase64(file) };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
