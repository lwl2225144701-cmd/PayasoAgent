// 消息附件公共策略：浏览器与 Host 共用类型判断和大小限制，无平台依赖。
export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_ATTACHMENT_BODY_BYTES = 12 * 1024 * 1024;
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_EXTENSIONS = new Set('txt md markdown json jsonc yaml yml toml csv tsv ts tsx js jsx mjs cjs py pyi html htm css scss less sql sh bash zsh xml ini conf cfg log c h cpp hpp rs go java kt swift rb php vue svelte graphql proto'.split(' '));
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', '.gitignore', '.editorconfig', '.npmrc']);
export function attachmentKind(name: string, mimeType: string): 'image' | 'text' | null {
  if (IMAGE_MIMES.has(mimeType.toLowerCase())) return 'image';
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (TEXT_NAMES.has(base) || TEXT_EXTENSIONS.has(base.split('.').pop() ?? '')) return 'text';
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
