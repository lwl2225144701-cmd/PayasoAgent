// 通用 CLI 辅助：统一退出码语义与文件读取（无 PDF 库依赖，可被任一脚本复用）。
// 退出码契约与原 Python 脚本一致：0 成功 / 1 运行失败 / 2 用法错误（参数或路径）。
import fs from 'node:fs';
import path from 'node:path';

/** CLI 错误：exitCode 默认 1（运行失败），传 2 表示用法错误。 */
export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** 统一入口：main(argv) -> Promise<number|void>；按 CliError.exitCode 退出。 */
export function run(main) {
  main(process.argv.slice(2)).catch((err) => {
    const code = err instanceof CliError ? err.exitCode : 1;
    if (code !== 0) console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(code);
  });
}

/** 读取 .pdf 文件字节；路径缺失 / 非 .pdf 抛用法错误（exit 2）。 */
export function readPdfBytes(filePath) {
  if (!filePath || path.extname(filePath).toLowerCase() !== '.pdf') {
    throw new CliError(`${filePath} 不是 .pdf 文件`, 2);
  }
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    throw new CliError(`${filePath} 不存在或无法读取`, 2);
  }
  return buf;
}

/** 由 pdf-lib 字段实例的类名判定字段类型（纯字符串判断，无 PDF 库依赖）。 */
export function pdfFieldKind(field) {
  switch (field?.constructor?.name) {
    case 'PDFTextField':
      return 'text';
    case 'PDFCheckBox':
      return 'checkbox';
    case 'PDFRadioGroup':
      return 'radio_group';
    case 'PDFDropdown':
      return 'choice';
    case 'PDFSignature':
      return 'signature';
    default:
      return 'unknown';
  }
}
/**
 * 展开页码选择 "1-3,5,8-" 为升序页码数组（1-based，末尾 - 表示到最后）。
 * spec 为空返回 null（全部页）。非法规格抛 CliError（exit 2）。
 */
export function expandPageSelection(spec, total) {
  if (!spec) return null;
  const picks = new Set();
  for (const token of spec.split(',')) {
    const m = /^\s*(\d*)\s*(-)?\s*(\d*)\s*$/.exec(token);
    if (!m || token.trim() === '') throw new CliError(`非法范围: ${token}`, 2);
    const [, lo, dash, hi] = m;
    const start = dash === undefined ? Number(lo) : lo ? Number(lo) : 1;
    const end = dash === undefined ? Number(lo) : hi ? Number(hi) : total;
    if (!(1 <= start && start <= end && end <= total)) {
      throw new CliError(`范围 ${token} 超出 1..${total}`, 2);
    }
    for (let n = start; n <= end; n++) picks.add(n);
  }
  return [...picks].sort((a, b) => a - b);
}
