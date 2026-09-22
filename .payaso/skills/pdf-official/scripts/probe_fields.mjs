// probe_fields.mjs — 探测 PDF 交互表单字段（AcroForm widgets）。
// 用法: node probe_fields.mjs FORM.pdf [--output out.json]
// 只支持 widgets 模式；skeleton（坐标级）与 --render-marked 依赖 pdfplumber/PIL，待迁移。
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { CliError, pdfFieldKind, readPdfBytes, run } from './lib.mjs';

function describe(field) {
  const rec = { name: field.getName(), kind: pdfFieldKind(field) };
  if (rec.kind === 'text') {
    rec.multiline = field.isMultiline();
    rec.password = field.isPassword();
  } else if (rec.kind === 'choice' || rec.kind === 'radio_group') {
    rec.options = field.getOptions();
  }
  return rec;
}

run(async (argv) => {
  const positional = [];
  let output = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output') {
      output = argv[++i];
    } else if (a === '--mode') {
      const mode = argv[++i];
      if (mode !== 'widgets') throw new CliError(`仅支持 --mode widgets（${mode} 待迁移）`, 2);
    } else if (a === '--render-marked' || a === '--dpi') {
      throw new CliError(`--render-marked/--dpi 待迁移（需 canvas 渲染 + 字体）`, 2);
    } else if (a.startsWith('--')) {
      throw new CliError(`未知参数: ${a}`, 2);
    } else {
      positional.push(a);
    }
  }
  if (!positional.length) throw new CliError('缺少 FORM.pdf', 2);

  const doc = await PDFDocument.load(readPdfBytes(positional[0]));
  const json = JSON.stringify(doc.getForm().getFields().map(describe), null, 2);
  if (output) {
    fs.writeFileSync(output, json, 'utf8');
    console.log(`wrote ${output}`);
  } else {
    console.log(json);
  }
});