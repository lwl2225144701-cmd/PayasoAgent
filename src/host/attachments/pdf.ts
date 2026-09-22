// Host 的 PDF 文本提取：手写快路径（零依赖）+ pdfjs 兜底（策略链）。
// 不处理 OCR；调用方保留原件并标记 partial / failed。
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

// FlateDecode：内置收益有限、但依赖更全的引擎可解，故标为「能力不足」以触发回退。
function decodeStream(raw: Buffer): Buffer {
  try {
    return inflateSync(raw, { maxOutputLength: MAX_STREAM_BYTES });
  } catch {
    try {
      return inflateRawSync(raw, { maxOutputLength: MAX_STREAM_BYTES });
    } catch {
      throw new UnsupportedPdfError('PDF 内容流解压失败');
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

/** 提取后统一清理：去掉行尾空白与多余空行。 */
function cleanupText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- 提取策略 ----

/**
 * 内建引擎能力不足（编码/字体/流不受支持），应由后续引擎兜底。
 * 与「真·坏文件」（缺 %PDF 头、解压超预算）区分：后者直接失败，不触发回退。
 */
class UnsupportedPdfError extends Error {}

/** PDF 文本提取策略：输入字节、输出文本；能力不足时抛 UnsupportedPdfError。 */
interface PdfTextExtractor {
  readonly name: string;
  extract(bytes: Buffer): Promise<string>;
}

/** 手写快路径（零依赖，同步核心）：覆盖简单 ASCII / FlateDecode 文本。 */
function extractBuiltinText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  if (/\/Encrypt\b|\/Type0\b|\/ToUnicode\b/.test(raw)) {
    throw new UnsupportedPdfError('PDF 加密或字体字符映射不受简易提取器支持');
  }
  const parts: string[] = [];
  let total = 0;
  // 字典用于识别流编码；复杂对象结构可能遗漏，返回的文本始终标注 partial。
  for (const match of raw.matchAll(/<<((?:(?!>>)[\s\S])*)>>\s*stream\r?\n([\s\S]*?)endstream/g)) {
    const dictionary = match[1];
    if (/\/Subtype\s*\/Image\b/.test(dictionary)) continue;
    const filters = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dictionary)?.[1];
    if (filters && !/^\/FlateDecode$|^\[\s*\/FlateDecode\s*\]$/.test(filters)) {
      throw new UnsupportedPdfError('PDF 内容流编码不受支持');
    }
    const encoded = Buffer.from(match[2], 'latin1');
    const decoded = filters ? decodeStream(encoded) : encoded;
    total += decoded.length;
    if (decoded.length > MAX_STREAM_BYTES || total > MAX_DOCUMENT_BYTES) {
      // 安全预算超限不回退：换引擎同样要解压，不能借回退绕过预算。
      throw new Error('PDF 解压大小超限');
    }
    const text = contentStreamToText(decoded).trim();
    if (text) parts.push(text);
  }
  return cleanupText(parts.join('\n'));
}

/** pdfjs 兜底：懒加载 legacy build，完整支持 Type0/ToUnicode（中文）字体映射。 */
async function extractPdfjsText(bytes: Buffer): Promise<string> {
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    throw new Error(
      '未安装 pdfjs-dist（可选依赖），无法提取中文/复杂 PDF；请运行 npm install pdfjs-dist 后重试',
    );
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out += `${content.items.map((item) => ('str' in item ? item.str : '')).join(' ')}\n`;
  }
  return cleanupText(out);
}

const EXTRACTORS: readonly PdfTextExtractor[] = [
  { name: 'builtin', extract: (bytes) => Promise.resolve(extractBuiltinText(bytes)) },
  { name: 'pdfjs', extract: extractPdfjsText },
];

/** 简易提取，不推断「扫描件」；按策略顺序尝试，前一个能力不足才轮到下一个。 */
export async function extractPdfText(bytes: Buffer): Promise<string> {
  if (!bytes.toString('latin1').startsWith('%PDF-')) {
    throw new Error('不是有效的 PDF 文件（缺 %PDF 头）');
  }
  for (const extractor of EXTRACTORS) {
    try {
      return await extractor.extract(bytes);
    } catch (err) {
      if (err instanceof UnsupportedPdfError) continue;
      throw err;
    }
  }
  throw new UnsupportedPdfError('PDF 提取失败：所有引擎均无法处理');
}
