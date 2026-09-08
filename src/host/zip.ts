// 零依赖 ZIP 写入器（store-only，不压缩）：用于会话日志导出。
// 纯函数：输入条目 → 完整 ZIP 字节（本地文件头 + 中央目录 + EOCD），
// UTF-8 文件名（bit 11）。导出体积以文本为主，store-only 足够且实现可靠。

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** 归档内路径（'/' 分隔，UTF-8）。 */
  name: string;
  /** 文件内容（UTF-8 文本或原始字节）。 */
  data: string | Uint8Array;
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** 小端无符号整数写入。 */
function writeU32(target: Uint8Array, offset: number, value: number): void {
  const view = new DataView(target.buffer, target.byteOffset + offset, 4);
  view.setUint32(0, value >>> 0, true);
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  const view = new DataView(target.buffer, target.byteOffset + offset, 2);
  view.setUint16(0, value & 0xffff, true);
}

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
/**通用位标志 bit 11：UTF-8 文件名。 */
const UTF8_FLAG = 1 << 11;
const STORE_METHOD = 0;
const DOS_TIME_BASE = 1980;

/**
 * 把 DOS 时间编码为 ZIP 的 16 位时间/日期（本地文件头与中央目录共用）。
 * ZIP 只支持 2 秒精度与 1980 年起的年份。
 */
export function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(DOS_TIME_BASE, date.getFullYear());
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - DOS_TIME_BASE) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * 生成完整 ZIP 归档字节（Deterministic：同输入同输出，便于测试与缓存）。
 * @param entries - 归档条目；name 重复时后者覆盖前者。
 * @throws 条目名为空或包含反斜杠时拒绝（规范强制 '/' 分隔）。
 */
export function createZip(entries: ZipEntry[], timestamp: Date = new Date()): Uint8Array {
  const cleaned = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (!entry.name || entry.name.includes('\\')) {
      throw new Error(`zip: 非法条目名 ${JSON.stringify(entry.name)}`);
    }
    cleaned.set(entry.name, typeof entry.data === 'string' ? encodeText(entry.data) : entry.data);
  }
  const { time, date } = dosDateTime(timestamp);

  const names = [...cleaned.keys()];
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const [name, data] of cleaned) {
    const nameBytes = encodeText(name);
    const crc = crc32(data);

    const local = new Uint8Array(LOCAL_HEADER_SIZE + nameBytes.length + data.length);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20); // version needed
    writeU16(local, 6, UTF8_FLAG);
    writeU16(local, 8, STORE_METHOD);
    writeU16(local, 10, time);
    writeU16(local, 12, date);
    writeU32(local, 14, crc);
    writeU32(local, 18, data.length); // compressed
    writeU32(local, 22, data.length); // uncompressed
    writeU16(local, 26, nameBytes.length);
    writeU16(local, 28, 0); // extra length
    local.set(nameBytes, LOCAL_HEADER_SIZE);
    local.set(data, LOCAL_HEADER_SIZE + nameBytes.length);
    localChunks.push(local);

    const central = new Uint8Array(CENTRAL_HEADER_SIZE + nameBytes.length);
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 4, 20); // version made by
    writeU16(central, 6, 20); // version needed
    writeU16(central, 8, UTF8_FLAG);
    writeU16(central, 10, STORE_METHOD);
    writeU16(central, 12, time);
    writeU16(central, 14, date);
    writeU32(central, 16, crc);
    writeU32(central, 20, data.length);
    writeU32(central, 24, data.length);
    writeU16(central, 28, nameBytes.length);
    writeU16(central, 42, offset); // local header offset
    central.set(nameBytes, CENTRAL_HEADER_SIZE);
    centralChunks.push(central);

    offset += local.length;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const total = offset + centralSize + EOCD_SIZE;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of localChunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  for (const chunk of centralChunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  const eocd = new Uint8Array(EOCD_SIZE);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 8, names.length);
  writeU16(eocd, 10, names.length);
  writeU32(eocd, 12, centralSize);
  writeU32(eocd, 16, offset);
  out.set(eocd, cursor);
  return out;
}

/** 解析 ZIP 中央目录（仅用于测试回读校验条目内容）。 */
export function readZipEntries(zip: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // 从尾部找 EOCD 签名（兼容带注释的归档）。
  let eocd = -1;
  for (let i = zip.length - EOCD_SIZE; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const result: Array<{ name: string; data: Uint8Array }> = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('zip: bad central header');
    const method = view.getUint16(cursor + 10, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(
      zip.subarray(cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLen),
    );
    if (method !== STORE_METHOD) throw new Error(`zip: ${name} 不是 store 方法`);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + LOCAL_HEADER_SIZE + localNameLen + localExtraLen;
    result.push({ name, data: zip.subarray(dataStart, dataStart + size) });
    cursor += CENTRAL_HEADER_SIZE + nameLen + extraLen + commentLen;
  }
  return result;
}
