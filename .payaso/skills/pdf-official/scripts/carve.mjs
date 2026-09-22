// carve.mjs — 拆分 PDF：按范围 / 逐页 / 固定块。
// 用法: node carve.mjs input.pdf (--by-range 1-3 4-6 7-z | --every-page | --chunk-size N) --dest DIR/
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { CliError, readPdfBytes, run } from './lib.mjs';

function parseRange(token, total) {
  if (token.includes('-')) {
    const [left, right] = token.split('-');
    const start = left ? Number(left) : 1;
    const end = right === '' || right === 'z' || right === 'Z' ? total : Number(right);
    return { start, end };
  }
  const n = Number(token);
  return { start: n, end: n };
}

function label(range) {
  return range.start === range.end
    ? `p${String(range.start).padStart(3, '0')}`
    : `p${String(range.start).padStart(3, '0')}-p${String(range.end).padStart(3, '0')}`;
}

async function emit(src, indices, destPath) {
  const dst = await PDFDocument.create();
  const pages = await dst.copyPages(src, indices);
  for (const p of pages) dst.addPage(p);
  fs.writeFileSync(destPath, Buffer.from(await dst.save()));
  console.log(`wrote ${destPath}`);
}

run(async (argv) => {
  let mode = null;
  let ranges = null;
  let chunkSize = null;
  let dest = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--by-range') {
      mode = 'range';
      ranges = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ranges.push(argv[++i]);
    } else if (a === '--every-page') {
      mode = 'every';
    } else if (a === '--chunk-size') {
      mode = 'chunk';
      chunkSize = Number(argv[++i]);
    } else if (a === '--dest') {
      dest = argv[++i];
    } else if (a.startsWith('--')) {
      throw new CliError(`未知参数: ${a}`, 2);
    } else {
      positional.push(a);
    }
  }
  if (!positional.length) throw new CliError('缺少 input.pdf', 2);
  if (!mode) throw new CliError('需指定 --by-range / --every-page / --chunk-size 之一', 2);
  if (!dest) throw new CliError('缺少 --dest', 2);

  const filePath = positional[0];
  const src = await PDFDocument.load(readPdfBytes(filePath));
  const total = src.getPageCount();
  const stem = path.basename(filePath, '.pdf');
  fs.mkdirSync(path.resolve(dest), { recursive: true });

  if (mode === 'range') {
    for (const token of ranges) {
      const r = parseRange(token, total);
      if (!(1 <= r.start && r.start <= r.end && r.end <= total)) {
        throw new CliError(`范围 ${token} 超出 1..${total}`, 2);
      }
      const indices = Array.from({ length: r.end - r.start + 1 }, (_, k) => r.start - 1 + k);
      await emit(src, indices, path.join(dest, `${stem}__${label(r)}.pdf`));
    }
  } else if (mode === 'every') {
    for (let i = 0; i < total; i++) {
      await emit(src, [i], path.join(dest, `${stem}__p${String(i + 1).padStart(3, '0')}.pdf`));
    }
  } else {
    // chunk
    if (!(chunkSize >= 1)) throw new CliError('--chunk-size 必须 >= 1', 2);
    for (let start = 0; start < total; start += chunkSize) {
      const end = Math.min(start + chunkSize, total);
      const indices = Array.from({ length: end - start }, (_, k) => start + k);
      const r = { start: start + 1, end };
      await emit(src, indices, path.join(dest, `${stem}__${label(r)}.pdf`));
    }
  }
});