// .docx（OOXML）文本提取：docx 本质是 zip，正文在 word/document.xml 的
// <w:t> 文本节点里。这里手写 zip 解析（EOCD → 中央目录 → 局部头）+ zlib
// inflateRaw，零新依赖 —— sharp 走可选依赖的先例，包体积是 npm 分发的
// 硬约束，mammoth 这类转换库不值得进 bundle。
// 输出契约：段落（</w:p>）转换行、<w:tab/> 转制表、<w:br/> 转换行，其余
// XML 结构全部剥掉，只留可见文本；XML 实体解码。提取失败一律抛错，由
// prepareAttachment 包装成对用户可见的 400。
import { inflateRawSync } from 'node:zlib';

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
// EOCD 固定 22 字节 + 每条目可带 0xFFFF 大小的注释区，扫描窗口取 64KiB。
const EOCD_SCAN_BYTES = 64 * 1024;
const MAX_ENTRIES = 4096;

interface ZipEntry {
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readUint32(bytes: Buffer, offset: number): number {
  return bytes.readUInt32LE(offset);
}

function readUint16(bytes: Buffer, offset: number): number {
  return bytes.readUInt16LE(offset);
}

// 从尾部找 EOCD，拿中央目录的位置与条目数。zip64（>4GB 或 >65535 条）超出
// 附件场景，不做支持。
function locateCentralDirectory(bytes: Buffer): { offset: number; entryCount: number } {
  const scanStart = Math.max(0, bytes.length - EOCD_SCAN_BYTES);
  for (let offset = bytes.length - 22; offset >= scanStart; offset -= 1) {
    if (readUint32(bytes, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const entryCount = readUint16(bytes, offset + 10);
    return { offset: readUint32(bytes, offset + 16), entryCount };
  }
  throw new Error('不是有效的 .docx 文件（zip 目录缺失）');
}

function readCentralEntries(bytes: Buffer, directory: { offset: number; entryCount: number }): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();
  let offset = directory.offset;
  for (let index = 0; index < Math.min(directory.entryCount, MAX_ENTRIES); index += 1) {
    if (offset + 46 > bytes.length || readUint32(bytes, offset) !== CENTRAL_DIRECTORY_SIGNATURE) break;
    const nameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.set(name, {
      compressionMethod: readUint16(bytes, offset + 10),
      compressedSize: readUint32(bytes, offset + 20),
      localHeaderOffset: readUint32(bytes, offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// 数据偏移要看局部头里的真实变长字段（中央目录的 extra 与局部头的 extra
// 可能不一致 —— streaming 写出的 zip 常见）。
function extractEntry(bytes: Buffer, entry: ZipEntry): Buffer {
  if (entry.localHeaderOffset + 30 > bytes.length || readUint32(bytes, entry.localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error('不是有效的 .docx 文件（局部头损坏）');
  }
  const nameLength = readUint16(bytes, entry.localHeaderOffset + 26);
  const extraLength = readUint16(bytes, entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return data;
  if (entry.compressionMethod === 8) {
    try {
      return inflateRawSync(data);
    } catch {
      throw new Error('.docx 内容损坏，无法解包');
    }
  }
  throw new Error('.docx 使用了不支持的压缩方式');
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// document.xml 里可见文本只存在于 <w:t>；结构信号（段落/换行/制表）是
// 自闭合或闭标签，直接在流式扫描里翻成纯文本控制符。
function documentXmlToText(xml: string): string {
  let text = '';
  let position = 0;
  while (position < xml.length) {
    const tagStart = xml.indexOf('<', position);
    if (tagStart < 0) break;
    const tagEnd = xml.indexOf('>', tagStart);
    if (tagEnd < 0) break;
    const tag = xml.slice(tagStart, tagEnd + 1);
    if (tag === '</w:p>' || tag === '<w:br/>' || tag === '<w:br>') text += '\n';
    else if (tag === '<w:tab/>' || tag === '<w:tab>') text += '\t';
    else if (tag.startsWith('<w:t') && !tag.endsWith('/>')) {
      const close = xml.indexOf('</w:t>', tagEnd);
      if (close < 0) break;
      text += xml.slice(tagEnd + 1, close);
      position = close;
    }
    position = tagEnd + 1;
  }
  return decodeXmlEntities(text).replace(/\r\n/g, '\n');
}

/** 提取 .docx 正文纯文本；非 zip / 缺正文 / 解包失败一律抛错。 */
export function extractDocxText(bytes: Buffer): string {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('不是有效的 .docx 文件（缺 zip 头）');
  }
  const entries = readCentralEntries(bytes, locateCentralDirectory(bytes));
  const document = entries.get('word/document.xml');
  if (!document) throw new Error('.docx 缺少正文（word/document.xml）');
  return documentXmlToText(extractEntry(bytes, document).toString('utf8'));
}
