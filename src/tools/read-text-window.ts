// 工具层内部的按行读取：分块扫描，只保留目标窗口与每行有限前缀。
// 文件大小不改变 offset/limit 的行号语义；统计总行数便于给出准确续读提示。
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export async function readTextWindow(
  file: string,
  startLine: number,
  limit: number,
  maxLineBytes: number,
) {
  const lines: string[] = [];
  const truncatedLines: number[] = [];
  let lineNumber = 1;
  let parts: Buffer[] = [];
  let kept = 0;
  let truncated = false;
  let hadBom = false;
  let firstChunk = true;

  function keep(segment: Buffer) {
    if (lineNumber < startLine || lineNumber >= startLine + limit) return;
    const size = Math.min(segment.length, maxLineBytes - kept);
    if (size) parts.push(Buffer.from(segment.subarray(0, size)));
    kept += size;
    if (size < segment.length) truncated = true;
  }
  function finishLine() {
    if (lineNumber >= startLine && lineNumber < startLine + limit) {
      const decoder = new StringDecoder('utf8');
      let text = decoder.write(Buffer.concat(parts, kept));
      // 截断处不把半个 UTF-8 字符渲染成乱码。
      if (!truncated) text += decoder.end();
      if (lineNumber === 1 && hadBom) text = text.slice(1);
      lines.push(text);
      if (truncated) truncatedLines.push(lineNumber);
    }
    parts = [];
    kept = 0;
    truncated = false;
  }

  for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const bytes = chunk as Buffer;
    if (firstChunk) {
      hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      firstChunk = false;
    }
    let position = 0;
    for (;;) {
      const newline = bytes.indexOf(10, position);
      if (newline < 0) {
        keep(bytes.subarray(position));
        break;
      }
      keep(bytes.subarray(position, newline));
      finishLine();
      lineNumber++;
      position = newline + 1;
    }
  }
  // 沿用原有 split('\n') 语义：末尾换行后保留一个空行。
  finishLine();
  return { lines, totalLines: lineNumber, hadBom, truncatedLines };
}
