// .pdf 文本提取（尽力而为，零依赖）：多数"数字生成"的 PDF 把文本放在
// FlateDecode 压缩的 content stream 里，用 Tj / TJ / ' / " 运算符输出文字
// 字面量。这里解流（node:zlib inflateRaw 兼容 zlib 包裹与裸 deflate）后按
// 文本对象（BT…ET）分块抽取：
// - 括号字面量 (...) 与十六进制字面量 <...>
// - 转义 \( \) \\ \n \r \t \b \f \ddd 解码
// - Td/TD/T*/' 等排版指令处换行（保留大致行结构）
// 局限（如实标注，不假装全能）：扫描件无文本层 → 返回占位说明；CID 字体
// 缺 ToUnicode 时可能得到字形码；解不了的对象（如 DCTDecode 图像）跳过。
import { inflateRawSync, inflateSync } from 'node:zlib';

const TEXT_SHOW_RE =
  /\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")|\[([\s\S]*?)\]\s*TJ|<([0-9a-fA-F\s]*)>\s*Tj/g;
const ESCAPE_RE = /\\([nrtbf()\\])|\\0?([0-7]{1,3})/g;
const NEWLINE_RE = /\bT[dD*]\b|\bT\*\b/;

function decodeLiteral(raw: string): string {
  return raw.replace(ESCAPE_RE, (_match, simple?: string, octal?: string) => {
    if (simple) {
      switch (simple) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        default: return simple;
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
    return inflateSync(raw);
  } catch {
    try {
      return inflateRawSync(raw);
    } catch {
      throw new Error('PDF 内容流解压失败');
    }
  }
}

function contentStreamToText(stream: Buffer): string {
  let content = '';
  try {
    content = decodeStream(stream).toString('latin1');
  } catch {
    return ''; // 解不开的流跳过，不拖垮整体
  }
  // 只看文本对象内的运算符；按 BT 分块，块间用换行隔离
  const blocks = content.split(/\bBT\b/g).slice(1);
  const lines: string[] = [];
  for (const block of blocks) {
    const line: string[] = [];
    for (const match of block.matchAll(TEXT_SHOW_RE)) {
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
          else if (Number(element[2]) > 120) parts.push(' ');
        }
        line.push(parts.join(''));
      } else if (hex !== undefined) line.push(decodeHex(hex));
      if (NEWLINE_RE.test(block.slice(0, match.index))) {
        // 该文本之前出现过换行指令：把前面已收的内容落行
        lines.push(line.join(''));
        line.length = 0;
      }
    }
    if (line.length) lines.push(line.join(''));
  }
  return lines.join('\n');
}

function streamBlocks(bytes: Buffer): Buffer[] {
  const blocks: Buffer[] = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  for (const match of bytes.toString('latin1').matchAll(re)) {
    // 跳过 stream 关键字前若有 /Length 之类属性无所谓；直接收原始字节
    const start = match.index + match[0].indexOf('\n') + 1;
    blocks.push(bytes.subarray(start, start + match[1].length));
  }
  return blocks;
}

/** 提取 .pdf 可读文本；无文本层/解不开时返回占位说明（不抛错，附件仍可用）。 */
export function extractPdfText(bytes: Buffer): string {
  if (bytes.length < 8 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('不是有效的 PDF 文件（缺 %PDF 头）');
  }
  const parts: string[] = [];
  for (const block of streamBlocks(bytes)) {
    const text = contentStreamToText(block).trim();
    if (text) parts.push(text);
  }
  const joined = parts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return joined.trim() || '\n[该 PDF 无文本层（可能是扫描件），未能提取文字。可用 OCR 工具或请用户提供文本版本。]\n';
}
