// 基线验收独立于 Agent：检查实际产物，不采信模型自述的“测试通过”。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
export interface Assertion { kind: 'text' | 'javascript'; target: string; patterns?: string[]; expression?: string }
export interface BaselineCase {
  id: string; category: string; title: string; files: Record<string, string>; turns: string[];
  initialChecks?: Assertion[]; allowedChanges: string[]; checks: Assertion[]; review: string[];
}
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  function walk(relative: string) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isSymbolicLink()) out[name] = `[symlink] ${fs.readlinkSync(path.join(root, name))}`;
      else if (entry.isFile()) out[name] = fs.readFileSync(path.join(root, name), 'utf8');
    }
  }
  walk('');
  return out;
}
export function evaluate(test: BaselineCase, files: Record<string, string>, answer: string, previous?: Record<string, string>): string[] {
  const failures: string[] = [];
  for (const name of new Set([...Object.keys(test.files), ...Object.keys(files)])) {
    if (!test.allowedChanges.includes(name) && test.files[name] !== files[name]) failures.push(`越界改动：${name}`);
  }
  for (const check of test.checks) {
    const source = check.target === '@answer' ? answer : files[check.target];
    if (source === undefined) { failures.push(`缺少产物：${check.target}`); continue; }
    try {
      if (check.kind === 'text') {
        for (const pattern of check.patterns ?? []) if (!new RegExp(pattern, 'iu').test(source)) failures.push(`${check.target} 未匹配事实：${pattern}`);
      } else {
        // 输入是本基线的合成代码；限时运行独立断言，不开放 require/process。
        const code = check.target.endsWith('.json') ? '' : `(function(module, exports) { ${source}\n})(module, module.exports);`;
        vm.runInNewContext(`${code}\n${check.expression}`, { module: { exports: {} }, source }, { timeout: 1000 });
      }
    } catch (error) { failures.push(`${check.target}：${(error as Error).message}`); }
  }
  if (test.id === 'M2' && previous?.['report.md'] && !files['report.md']?.startsWith(previous['report.md'].trimEnd())) failures.push('第二轮改写了第一轮报告内容');
  return failures;
}
