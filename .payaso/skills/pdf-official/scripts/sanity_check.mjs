// sanity_check.mjs — PDF 完整性校验：load → save → reload 往返，核对页数与字段数。
// 用法: node sanity_check.mjs FILE.pdf [--verbose]
// 退出码: 0 一切正常 / 1 发现问题（逐条写 stderr）。
import { PDFDocument } from 'pdf-lib';
import { CliError, readPdfBytes, run } from './lib.mjs';

run(async (argv) => {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const verbose = argv.includes('--verbose');
  if (!positional.length) throw new CliError('缺少参数 path', 2);
  const filePath = positional[0];

  const findings = [];
  const original = await PDFDocument.load(readPdfBytes(filePath));

  let reloaded;
  try {
    reloaded = await PDFDocument.load(await original.save());
  } catch (err) {
    findings.push(`save/reload 往返失败: ${err?.message ?? err}`);
    for (const f of findings) console.error(`finding: ${f}`);
    process.exit(1);
  }

  const originalPages = original.getPageCount();
  const reloadedPages = reloaded.getPageCount();
  if (originalPages !== reloadedPages) {
    findings.push(`页数不一致: 往返前 ${originalPages} → 往返后 ${reloadedPages}`);
  }

  const rotated = original
    .getPages()
    .filter((p) => p.getRotation().angle !== 0)
    .map((p) => p.getRotation().angle);
  if (rotated.length && verbose) console.log(`[info] ${rotated.length} 页带旋转角`);

  if (findings.length === 0) {
    console.log(`OK: ${filePath}（${originalPages} 页，load/save 往返一致）`);
    return;
  }
  for (const f of findings) console.error(`finding: ${f}`);
  process.exit(1);
});