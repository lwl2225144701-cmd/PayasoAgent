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