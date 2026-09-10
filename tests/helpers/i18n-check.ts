// i18n 开发工具：扫描指定文件（缺省=整个 web/src）里仍写死中文的用户可见位置。
// 用法: npx tsx tests/helpers/i18n-check.ts [file…]
import { listWebSources, scanUserVisibleCjk } from './i18n-scan.js';

const targets = process.argv.slice(2);
const files = targets.length > 0 ? targets : listWebSources();
const hits = scanUserVisibleCjk(files);
if (hits.length === 0) {
  console.log(`i18n 扫描：${files.length} 个文件，无用户可见中文残留 ✓`);
  process.exit(0);
}
console.log(`i18n 扫描：${files.length} 个文件，仍有 ${hits.length} 处用户可见中文：`);
for (const hit of hits) console.log(`  ${hit.file}:${hit.line}  ${hit.text}`);
process.exit(1);
