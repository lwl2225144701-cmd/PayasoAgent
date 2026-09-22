// survey.mjs — 分诊 PDF：页数 / 加密 / 表单字段数 / 是否扫描 / 元数据（JSON）。
// 用法: node survey.mjs FILE.pdf [--pretty]
import path from 'node:path';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { CliError, readPdfBytes, run } from './lib.mjs';

/** 第一页几乎无文本且有图片 → 判定为扫描件。 */
async function looksScanned(doc) {
  if (doc.numPages < 1) return false;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const text = tc.items.map((it) => ('str' in it ? it.str : '')).join('').trim();
  if (text.length >= 40) return false;
  const ops = await page.getOperatorList();
  return ops.fnArray.includes(OPS.paintImageXObject);
}

async function probe(filePath) {
  const bytes = readPdfBytes(filePath);
  let doc;
  try {
    doc = await getDocument({
      data: new Uint8Array(bytes),
      useWorkerFetch: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
  } catch (err) {
    // pdfjs 对加密 PDF 抛 PasswordException；判定为已加密，其余字段置空。
    if (err?.name === 'PasswordException' || /password/i.test(err?.message ?? '')) {
      return {
        path: path.resolve(filePath),
        page_count: null,
        is_locked: true,
        form_field_count: 0,
        looks_scanned: false,
        metadata: {},
      };
    }
    throw new CliError(`无法读取 ${filePath}: ${err?.message ?? err}`);
  }

  const fields = (await doc.getFieldObjects()) ?? new Map();
  const meta = await doc.getMetadata();
  const metadata = {};
  for (const [key, value] of Object.entries(meta?.info ?? {})) {
    if (value != null) metadata[key.replace(/^\/+/, '')] = String(value);
  }
  return {
    path: path.resolve(filePath),
    page_count: doc.numPages,
    is_locked: false,
    form_field_count: fields.size,
    looks_scanned: await looksScanned(doc),
    metadata,
  };
}

run(async (argv) => {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const pretty = argv.includes('--pretty');
  if (!positional.length) throw new CliError('缺少参数 path', 2);
  const report = await probe(positional[0]);
  console.log(JSON.stringify(report, null, pretty ? 2 : 0));
});