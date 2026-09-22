// table_dump.mjs — PDF 表格结构还原（行聚类 + 列切分 → markdown 表格 / JSON）。
// 用法: node table_dump.mjs FILE.pdf [--pages 1-3,5] [--format markdown|json] [--out F]
// 退出码: 0 成功 / 1 运行失败 / 2 用法错误（与其余脚本一致）。
// 算法在 table-layout.mjs（纯函数、可单测）；本文件只做 pdfjs 接线与输出。
import fs from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { CliError, expandPageSelection, readPdfBytes, run } from './lib.mjs';
import { renderPage } from './table-layout.mjs';

async function analyzePage(doc, pageNo) {
  const tc = await (await doc.getPage(pageNo)).getTextContent();
  return { page: pageNo, ...renderPage(tc.items, 'json') };
}

function writeOut(out, text) {
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text, 'utf8');
    console.log(`wrote ${out}`);
  } else {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }
}

run(async (argv) => {
  const positional = [];
  let format = 'markdown';
  let select = '';
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') {
      format = argv[++i];
      if (!['markdown', 'json'].includes(format)) throw new CliError('--format 仅支持 markdown|json', 2);
    } else if (a === '--pages') {
      select = argv[++i] ?? '';
    } else if (a === '--out') {
      out = argv[++i];
    } else if (a.startsWith('--')) {
      throw new CliError(`未知参数: ${a}`, 2);
    } else {
      positional.push(a);
    }
  }
  if (!positional.length) throw new CliError('缺少参数 path', 2);

  const doc = await getDocument({
    data: new Uint8Array(readPdfBytes(positional[0])),
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  const pages =
    expandPageSelection(select, doc.numPages) ??
    Array.from({ length: doc.numPages }, (_, i) => i + 1);

  if (format === 'json') {
    const analyses = [];
    for (const pageNo of pages) analyses.push(await analyzePage(doc, pageNo));
    writeOut(out, JSON.stringify({ pages: analyses }, null, 2));
    return;
  }
  const chunks = [];
  for (const pageNo of pages) {
    const tc = await (await doc.getPage(pageNo)).getTextContent();
    chunks.push(`\f--- page ${pageNo} ---\n${renderPage(tc.items, 'markdown')}`);
  }
  writeOut(out, chunks.join('\n'));
});