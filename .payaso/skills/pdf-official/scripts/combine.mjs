// combine.mjs — 合并多个 PDF 为一个。
// 用法: node combine.mjs A.pdf B.pdf ... --out combined.pdf [--preserve-metadata FIRST|NONE]
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { CliError, readPdfBytes, run } from './lib.mjs';

/** 复制源 PDF 的标准元数据字段到目标（pdf-lib 仅暴露这些标准字段）。 */
function copyMetadata(dst, src) {
  dst.setTitle(src.getTitle() ?? '');
  dst.setAuthor(src.getAuthor() ?? '');
  dst.setSubject(src.getSubject() ?? '');
  dst.setCreator(src.getCreator() ?? '');
  dst.setProducer(src.getProducer() ?? '');
}

run(async (argv) => {
  const sources = [];
  let out = null;
  let preserve = 'NONE';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      out = argv[++i];
    } else if (a === '--preserve-metadata') {
      preserve = argv[++i] ?? 'NONE';
      if (!['FIRST', 'NONE'].includes(preserve)) {
        throw new CliError(`非法的 --preserve-metadata 值: ${preserve}`, 2);
      }
    } else if (a.startsWith('--')) {
      throw new CliError(`未知参数: ${a}`, 2);
    } else {
      sources.push(a);
    }
  }
  if (!sources.length) throw new CliError('缺少输入 PDF', 2);
  if (!out) throw new CliError('缺少 --out', 2);

  const dst = await PDFDocument.create();
  let total = 0;
  for (const src of sources) {
    let doc;
    try {
      doc = await PDFDocument.load(readPdfBytes(src));
    } catch (err) {
      throw new CliError(`${src} 无法读取（可能加密）: ${err?.message ?? err}`);
    }
    const pages = await dst.copyPages(doc, doc.getPageIndices());
    for (const page of pages) dst.addPage(page);
    total += pages.length;
  }

  if (preserve === 'FIRST') {
    copyMetadata(dst, await PDFDocument.load(readPdfBytes(sources[0])));
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await dst.save()));
  console.log(`wrote ${out} (${total} pages)`);
});