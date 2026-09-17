// OOXML（docx/pptx/xlsx）共用的 zip 解析：从附件字节里取指定条目，解压为
// Buffer。手写 EOCD → 中央目录 → 局部头 + zlib inflateRaw，零新依赖。
// 判定职责交给调用方（缺条目 / 非法 zip 抛错带格式名），这里只负责解析。
import { inflateRawSync } from 'node:zlib';

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
// EOCD 固定 22 字节 + 每条目可带 0xFFFF 大小的注释区，扫描窗口取 64KiB。
const EOCD_SCAN_BYTES = 64 * 1024;
const MAX_ENTRIES = 4096;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

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
    if (entryCount > MAX_ENTRIES) throw new Error('文档条目数超限');
    return { offset: readUint32(bytes, offset + 16), entryCount };
  }
  throw new Error('zip 目录缺失');
}

function readCentralEntries(
  bytes: Buffer,
  directory: { offset: number; entryCount: number },
): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();
  let offset = directory.offset;
  for (let index = 0; index < Math.min(directory.entryCount, MAX_ENTRIES); index += 1) {
    if (offset + 46 > bytes.length || readUint32(bytes, offset) !== CENTRAL_DIRECTORY_SIGNATURE)
      break;
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
  if (
    entry.localHeaderOffset + 30 > bytes.length ||
    readUint32(bytes, entry.localHeaderOffset) !== LOCAL_HEADER_SIGNATURE
  ) {
    throw new Error('局部头损坏');
  }
  const nameLength = readUint16(bytes, entry.localHeaderOffset + 26);
  const extraLength = readUint16(bytes, entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (dataStart + entry.compressedSize > bytes.length) throw new Error('条目数据不完整');
  if (entry.compressionMethod === 0) {
    if (data.length > MAX_ENTRY_BYTES) throw new Error('文档条目解压大小超限');
    return data;
  }
  if (entry.compressionMethod === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch {
      throw new Error('内容损坏或解压大小超限');
    }
  }
  throw new Error('使用了不支持的压缩方式');
}

/** 每份文档只解析一次目录；限制单条目及累计解压大小。 */
export function openZip(bytes: Buffer) {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE)
    throw new Error('不是有效的 zip 文件');
  const entries = readCentralEntries(bytes, locateCentralDirectory(bytes));
  let total = 0;
  return {
    names: [...entries.keys()],
    read(name: string): Buffer | undefined {
      const entry = entries.get(name);
      if (!entry) return undefined;
      const output = extractEntry(bytes, entry);
      total += output.length;
      if (total > MAX_DOCUMENT_BYTES) throw new Error('文档累计解压大小超限');
      return output;
    },
  };
}
