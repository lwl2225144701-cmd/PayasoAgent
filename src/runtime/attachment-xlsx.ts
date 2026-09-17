// .xlsx（OOXML 电子表格）文本提取：字符串常量在 xl/sharedStrings.xml，
// 各 sheet 的 xl/worksheets/sheetN.xml 里单元格 <c r="A1" t="s"><v>0</v></c>
// 引用共享串。按行还原成 TSV：空列用连续制表符占位（保持列对齐），每张表
// 以 "--- Sheet N ---" 分节。公式/数字/布尔取 <v> 原值，内联串取 <is><t>。
import { zipEntry, zipEntryNames } from './attachment-zip.js';

const SHEET_RE = /^xl\/worksheets\/sheet(\d+)\.xml$/;
const CELL_RE = /<c\b[^>]*r="([A-Z]+)\d+"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g;

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

function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

// 共享串表：每个 <si> 是一格字符串，内容可能是多个 <r><t> 运行拼接，
// 也可能是裸 <t>；换行标记 <phoneticPr> 等忽略。
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  for (const match of xml.matchAll(siRe)) {
    const body = match[1];
    const runs: string[] = [];
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
    for (const t of body.matchAll(tRe)) runs.push(t[1] ?? '');
    strings.push(decodeXmlEntities(runs.join('')));
  }
  return strings;
}

function sheetXmlToTsv(xml: string, sharedStrings: string[]): string {
  const lines: string[] = [];
  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
  for (const row of xml.matchAll(rowRe)) {
    const cells = new Map<number, string>();
    for (const cell of row[1].matchAll(CELL_RE)) {
      const col = columnIndex(cell[1]);
      const body = cell[2] ?? '';
      const typeMatch = /t="([^"]+)"/.exec(cell[0]);
      let value = '';
      if (typeMatch && typeMatch[1] === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        const index = v ? Number(v[1]) : NaN;
        value = Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : '';
      } else if (typeMatch && typeMatch[1] === 'inlineStr') {
        const t = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(body);
        value = t ? decodeXmlEntities(t[1]) : '';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? decodeXmlEntities(v[1]) : '';
      }
      cells.set(col, value.replace(/\r\n/g, '\n'));
    }
    if (cells.size === 0) continue;
    const maxCol = Math.max(...cells.keys());
    const parts: string[] = [];
    for (let col = 0; col <= maxCol; col += 1) parts.push(cells.get(col) ?? '');
    // 行尾空列不保留悬挂制表符
    while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    lines.push(parts.join('\t'));
  }
  return lines.join('\n');
}

/** 提取 .xlsx 全部工作表为 TSV；缺共享串表按空串处理，缺 sheet 抛错。 */
export function extractXlsxText(bytes: Buffer): string {
  const names = zipEntryNames(bytes);
  const sheets = names
    .map((name) => SHEET_RE.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (sheets.length === 0) throw new Error('.xlsx 缺少工作表（xl/worksheets/sheetN.xml）');
  const sharedRaw = zipEntry(bytes, 'xl/sharedStrings.xml');
  const sharedStrings = sharedRaw ? parseSharedStrings(sharedRaw.toString('utf8')) : [];
  const parts: string[] = [];
  for (const match of sheets) {
    const xml = zipEntry(bytes, match[0]);
    if (!xml) continue;
    const tsv = sheetXmlToTsv(xml.toString('utf8'), sharedStrings);
    if (tsv.trim()) parts.push(`--- Sheet ${match[1]} ---\n${tsv}`);
  }
  if (parts.length === 0) throw new Error('.xlsx 未提取到内容');
  return parts.join('\n\n');
}
