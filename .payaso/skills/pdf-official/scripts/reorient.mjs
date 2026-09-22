// reorient.mjs — 旋转指定页面（90/180/270，叠加到已有旋转角）。
// 用法: node reorient.mjs in.pdf --angle 90 --targets 1,3-5 --out rot.pdf
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';
import { CliError, readPdfBytes, run } from './lib.mjs';

/** "all" 或 "1,3-5" → 升序页码集合。 */
function selection(spec, total) {
  if (spec.trim().toLowerCase() === 'all') {
    return new Set(Array.from({ length: total }, (_, i) => i + 1));
  }
  const picks = new Set();
  for (const token of spec.split(',')) {
    const t = token.trim();
    if (!t) continue;
    const [loPart, hiPart] = t.includes('-') ? t.split('-') : [t, t];
    const start = loPart ? Number(loPart) : 1;
    const end = hiPart ? Number(hiPart) : total;
    if (!(1 <= start && start <= end && end <= total)) {
      throw new CliError(`目标 ${t} 超出 1..${total}`, 2);
    }
    for (let n = start; n <= end; n++) picks.add(n);
  }
  return picks;
}

run(async (argv) => {
  let angle = null;
  let targets = null;
  let out = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--angle') {
      angle = Number(argv[++i]);
    } else if (a === '--targets') {
      targets = argv[++i];
    } else if (a === '--out') {
      out = argv[++i];
    } else if (a.startsWith('--')) {
      throw new CliError(`未知参数: ${a}`, 2);
    } else {
      positional.push(a);
    }
  }
  if (!positional.length) throw new CliError('缺少 input.pdf', 2);
  if (![90, 180, 270].includes(angle)) throw new CliError('--angle 仅支持 90/180/270', 2);
  if (!targets) throw new CliError('缺少 --targets', 2);
  if (!out) throw new CliError('缺少 --out', 2);

  const filePath = positional[0];
  const src = await PDFDocument.load(readPdfBytes(filePath));
  const total = src.getPageCount();
  const targetsSet = selection(targets, total);

  const dst = await PDFDocument.create();
  const pages = await dst.copyPages(src, src.getPageIndices());
  for (let i = 0; i < pages.length; i++) {
    if (targetsSet.has(i + 1)) {
      const current = pages[i].getRotation().angle;
      pages[i].setRotation(degrees((((current + angle) % 360) + 360) % 360));
    }
    dst.addPage(pages[i]);
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await dst.save()));
  console.log(`wrote ${out} (${targetsSet.size} 页旋转 ${angle}°)`);
});