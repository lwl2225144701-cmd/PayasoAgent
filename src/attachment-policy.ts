// 消息附件公共策略：浏览器与 Host 共用类型判断和大小限制，无平台依赖。
// 上限依据：图片 8MiB 对齐读图上限；文本 2MiB 对齐读文件上限；Office 系
// （docx/pptx/xlsx/doc/ppt）8MiB；PDF 16MiB（普遍偏大）；整条请求体
// 24MiB，保证 16MiB PDF 的 base64（×4/3 ≈ 21.3MiB）加 JSON 开销放得下。
export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_OFFICE_BYTES = 8 * 1024 * 1024; // docx / pptx / xlsx / doc / ppt
export const MAX_PDF_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENT_BODY_BYTES = 24 * 1024 * 1024;
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_EXTENSIONS = new Set('txt md markdown json jsonc yaml yml toml csv tsv ts tsx js jsx mjs cjs py pyi html htm css scss less sql sh bash zsh xml ini conf cfg log c h cpp hpp rs go java kt swift rb php vue svelte graphql proto'.split(' '));
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', '.gitignore', '.editorconfig', '.npmrc']);
const DOCX_EXTENSIONS = new Set(['docx']);
const PPTX_EXTENSIONS = new Set(['pptx']);
const XLSX_EXTENSIONS = new Set(['xlsx']);
const PDF_EXTENSIONS = new Set(['pdf']);
// 旧版 OLE2 二进制：无法零依赖可靠解包，原样接收，由 Agent 用系统工具转换。
const BINARY_EXTENSIONS = new Set(['doc', 'ppt']);
export type AttachmentKind =
  | 'image'
  | 'text'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'pdf'
  | 'binary';
export function attachmentKind(name: string, mimeType: string): AttachmentKind | null {
  if (IMAGE_MIMES.has(mimeType.toLowerCase())) return 'image';
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const ext = base.split('.').pop() ?? '';
  if (DOCX_EXTENSIONS.has(ext)) return 'docx';
  if (PPTX_EXTENSIONS.has(ext)) return 'pptx';
  if (XLSX_EXTENSIONS.has(ext)) return 'xlsx';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (BINARY_EXTENSIONS.has(ext)) return 'binary';
  if (TEXT_NAMES.has(base) || TEXT_EXTENSIONS.has(ext)) return 'text';
  return null;
}
export function attachmentSizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
export function decodeAttachmentText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('binary');
  return text;
}
