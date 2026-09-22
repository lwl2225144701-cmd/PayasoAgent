// overlay_text.mjs — 在 PDF 页上覆盖文本（用于不可填表单 / 补字）。
// 用法: node overlay_text.mjs IN.pdf entries.json --out OUT.pdf [--font CJK.ttf]
// entries.json: [{"page":1,"x":72,"y":720,"text":"张三","size":12}]
// 坐标原点左下，单位 PDF point（1/72 英寸）。缺省用内置 Helvetica（仅 ASCII）；
// 含中文需 --font 指定 TTF 字体文件路径。
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { CliError, readPdfBytes, run } from './lib.mjs';

run(async (argv) => {
  let out = null;
  let fontPath = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      out = argv[++i];
    } else if (a === '--font') {
      fontPath = argv[++i];
    } else if (a.startsWith('--')) {
      throw new CliError(`未知参数: ${a}`, 2);
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 2) throw new CliError('用法: overlay_text.mjs IN.pdf entries.json --out OUT.pdf', 2);
  if (!out) throw new CliError('缺少 --out', 2);

  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(positional[1], 'utf8'));
  } catch (err) {
    throw new CliError(`无法读取 entries.json: ${err?.message ?? err}`, 2);
  }
  if (!Array.isArray(entries)) throw new CliError('entries.json 必须是数组', 2);

  const doc = await PDFDocument.load(readPdfBytes(positional[0]));
  let font;
  if (fontPath) {
    font = await doc.embedFont(fs.readFileSync(fontPath));
  } else {
    font = await doc.embedFont(StandardFonts.Helvetica);
  }

  const pageCount = doc.getPageCount();
  for (const e of entries) {
    const pageNo = Number(e.page);
    if (!(1 <= pageNo && pageNo <= pageCount)) throw new CliError(`page ${e.page} 超出 1..${pageCount}`, 2);
    const page = doc.getPage(pageNo - 1);
    page.drawText(String(e.text), {
      x: Number(e.x),
      y: Number(e.y),
      size: Number(e.size ?? 12),
      font,
      color: rgb(0, 0, 0),
    });
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await doc.save()));
  console.log(`wrote ${out} (${entries.length} 处文本)`);
});