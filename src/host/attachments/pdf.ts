// Host 的 PDF 简易文本提取：支持原始与 FlateDecode 流，设置解压预算。
// 不处理 OCR、加密和字体字符映射；调用方保留原件并标记 partial / failed。
import { inflateRawSync, inflateSync } from 'node:zlib';
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

const TEXT_SHOW_RE =
  /\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")|\[([\s\S]*?)\]\s*TJ|<([0-9a-fA-F\s]*)>\s*Tj/g;
const ESCAPE_RE = /\\([nrtbf()\\])|\\0?([0-7]{1,3})/g;
const NEWLINE_RE = /\bT[dD*]\b|\bT\*\b/;

function decodeLiteral(raw: string): string {
  return raw.replace(ESCAPE_RE, (_match, simple?: string, octal?: string) => {
    if (simple) {
      switch (simple) {
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        case 't':
          return '\t';
        case 'b':
          return '\b';
        case 'f':
          return '\f';
        default:
          return simple;
      }
    }
    return octal ? String.fromCharCode(parseInt(octal, 8)) : '';
  });
}

function decodeHex(raw: string): string {
  const compact = raw.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 1 < compact.length; i += 2) {
    const byte = parseInt(compact.slice(i, i + 2), 16);
    if (Number.isFinite(byte)) out += String.fromCharCode(byte);
  }
  return out;
}

function decodeStream(raw: Buffer): Buffer {
  // PDF 的 FlateDecode 用 zlib 包裹；个别工具产出裸 deflate，依次尝试。
  try {
    return inflateSync(raw, { maxOutputLength: MAX_STREAM_BYTES });
  } catch {
    try {
      return inflateRawSync(raw, { maxOutputLength: MAX_STREAM_BYTES });
    } catch {
      throw new Error('PDF 内容流解压失败');
    }
  }
}

function contentStreamToText(stream: Buffer): string {
  const content = stream.toString('latin1');
  // 只看文本对象内的运算符；按 BT 分块，块间用换行隔离
  const blocks = [...content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)].map((match) => match[1]);
  const lines: string[] = [];
  for (const block of blocks) {
    const line: string[] = [];
    let previousEnd = 0;
    for (const match of block.matchAll(TEXT_SHOW_RE)) {
      if (NEWLINE_RE.test(block.slice(previousEnd, match.index))) {
        lines.push(line.join(''));
        line.length = 0;
      }
      previousEnd = match.index + match[0].length;
      const literal = match[1];
      const array = match[2];
      const hex = match[3];
      if (literal !== undefined) line.push(decodeLiteral(literal));
      else if (array !== undefined) {
        // TJ 数组：元素是字符串或数值（数值=微位移，负值≈紧凑，正值≈空格）
        const parts: string[] = [];
        const elementRe = /\(((?:[^()\\]|\\.)*)\)|(-?\d+(?:\.\d+)?)/g;
        for (const element of array.matchAll(elementRe)) {
          if (element[1] !== undefined) parts.push(decodeLiteral(element[1]));
          else if (Number(element[2]) < -120) parts.push(' ');
        }
        line.push(parts.join(''));
      } else if (hex !== undefined) line.push(decodeHex(hex));
    }
    if (line.length) lines.push(line.join(''));
  }
  return lines.join('\n');
}

/** 简易提取，不推断“扫描件”；不支持的编码交给后续工具处理原件。 */
export function extractPdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  if (!raw.startsWith('%PDF-')) throw new Error('不是有效的 PDF 文件（缺 %PDF 头）');
  if (/\/Encrypt\b|\/Type0\b|\/ToUnicode\b/.test(raw))
    throw new Error('PDF 加密或字体字符映射不受简易提取器支持');
  const parts: string[] = [];
  let total = 0;
  // 字典用于识别流编码；复杂对象结构可能遗漏，调用方始终标注 partial。
  for (const match of raw.matchAll(/<<((?:(?!>>)[\s\S])*)>>\s*stream\r?\n([\s\S]*?)endstream/g)) {
    const dictionary = match[1];
    if (/\/Subtype\s*\/Image\b/.test(dictionary)) continue;
    const filters = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dictionary)?.[1];
    if (filters && !/^\/FlateDecode$|^\[\s*\/FlateDecode\s*\]$/.test(filters))
      throw new Error('PDF 内容流编码不受支持');
    const encoded = Buffer.from(match[2], 'latin1');
    const decoded = filters ? decodeStream(encoded) : encoded;
    total += decoded.length;
    if (decoded.length > MAX_STREAM_BYTES || total > MAX_DOCUMENT_BYTES)
      throw new Error('PDF 解压大小超限');
    const text = contentStreamToText(decoded).trim();
    if (text) parts.push(text);
  }
  return parts
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
