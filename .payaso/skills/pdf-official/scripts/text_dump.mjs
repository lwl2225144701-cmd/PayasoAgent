// text_dump.mjs — 提取 PDF 纯文本（pdfjs 引擎，支持 Type0/ToUnicode 中文）。
// 用法: node text_dump.mjs FILE.pdf [--out OUT.txt] [--select 1-3,5,8-]
import fs from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { CliError, expandPageSelection, readPdfBytes, run } from './lib.mjs';

async function extract(filePath, pages) {
  const bytes = readPdfBytes(filePath);
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  const wanted = pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
  let out = '';
  for (const n of wanted) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    out += `\f--- page ${n} ---\n`;
    out += `${tc.items.map((it) => ('str' in it ? it.str : '')).join(' ')}\n`;
  }
  return out;
}

run(async (argv) => {
  const positional = [];
  let out = null;
  let select = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      out = argv[++i];
    } else if (a === '--select') {
      select = argv[++i] ?? '';
    } else if (a.startsWith('--')) {
      throw new CliError(`未知参数: ${a}`, 2);
    } else {
      positional.push(a);
    }
  }
  if (!positional.length) throw new CliError('缺少参数 path', 2);
  const filePath = positional[0];

  // 先解析页数以校验 --select，再提取。
  const bytes = readPdfBytes(filePath);
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  const pages = expandPageSelection(select, doc.numPages);
  const text = await extract(filePath, pages);

  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text, 'utf8');
    console.log(`wrote ${out}`);
  } else {
    process.stdout.write(text);
  }
});