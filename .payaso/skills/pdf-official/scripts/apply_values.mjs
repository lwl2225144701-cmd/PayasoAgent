// apply_values.mjs — 填充 AcroForm 表单字段。
// 用法: node apply_values.mjs FORM.pdf values.json --out filled.pdf [--flatten]
// values.json: [{"name":"field.name","value":"..."}]；checkbox 值 truthy/非 truthy → 勾选/取消。
// 退出码: 0 成功 / 1 运行失败 / 2 用法错误 / 3 校验失败（字段缺失或值非法）。
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { CliError, pdfFieldKind, readPdfBytes, run } from './lib.mjs';

function apply(form, entries) {
  const problems = [];
  for (const entry of entries) {
    const name = entry?.name;
    if (!name || typeof entry.value === 'undefined') {
      problems.push(`${JSON.stringify(entry)}: 缺少 name 或 value`);
      continue;
    }
    const field = form.getFields().find((f) => f.getName() === name);
    if (!field) {
      problems.push(`${name}: 字段不存在`);
      continue;
    }
    const kind = pdfFieldKind(field);
    if (kind === 'text') {
      field.setText(String(entry.value));
    } else if (kind === 'checkbox') {
      if (entry.value) field.check();
      else field.uncheck();
    } else if (kind === 'radio_group' || kind === 'choice') {
      if (!field.getOptions().includes(String(entry.value))) {
        problems.push(`${name}: '${entry.value}' 不在可选值 ${JSON.stringify(field.getOptions())}`);
        continue;
      }
      field.select(String(entry.value));
    } else {
      problems.push(`${name}: ${kind} 类型不支持填充（需真实证书或待迁移）`);
    }
  }
  return problems;
}

run(async (argv) => {
  let out = null;
  let flatten = false;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      out = argv[++i];
    } else if (a === '--flatten') {
      flatten = true;
    } else if (a.startsWith('--')) {
      throw new CliError(`未知参数: ${a}`, 2);
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 2) throw new CliError('用法: apply_values.mjs FORM.pdf values.json --out out.pdf', 2);
  if (!out) throw new CliError('缺少 --out', 2);

  const [formPath, valuesPath] = positional;
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(valuesPath, 'utf8'));
  } catch (err) {
    throw new CliError(`无法读取 values.json: ${err?.message ?? err}`, 2);
  }
  if (!Array.isArray(entries)) throw new CliError('values.json 必须是数组', 2);

  const doc = await PDFDocument.load(readPdfBytes(formPath));
  const form = doc.getForm();
  const problems = apply(form, entries);
  if (problems.length) {
    for (const p of problems) console.error(`validation: ${p}`);
    process.exit(3);
  }

  if (flatten) form.flatten();
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await doc.save()));
  console.log(`wrote ${out}`);
});