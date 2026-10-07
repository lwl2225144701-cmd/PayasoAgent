// 生成 macOS 应用图标（build/icon.icns）—— 从仓库里现成的 web/public/icon-512.png 派生。
//
// 用法: node scripts/make-icon.mjs
//
// 产物是二进制，不进 git（见 .gitignore），由 npm run setup 重新生成。
// 只用 macOS 自带的 sips + iconutil，不引入额外依赖。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.resolve(here, '..', '..', '..', 'web', 'public', 'icon-512.png');
const iconset = path.join(root, 'build', 'icon.iconset');
const out = path.join(root, 'build', 'icon.icns');

if (process.platform !== 'darwin') {
  console.error('make-icon 只支持 macOS（用 iconutil）');
  process.exit(1);
}
if (!existsSync(source)) {
  console.error(`缺少源图: ${source}`);
  process.exit(1);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`命令失败: ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

// iconutil 要求的成对命名：icon_{N}x{N}.png 与 icon_{N}x{N}@2x.png
for (const size of [16, 32, 128, 256, 512]) {
  run('sips', [
    '-z',
    String(size),
    String(size),
    source,
    '--out',
    path.join(iconset, `icon_${size}x${size}.png`),
  ]);
  run('sips', [
    '-z',
    String(size * 2),
    String(size * 2),
    source,
    '--out',
    path.join(iconset, `icon_${size}x${size}@2x.png`),
  ]);
}

run('iconutil', ['-c', 'icns', iconset, '-o', out]);
rmSync(iconset, { recursive: true, force: true });
console.log(`OK ${out}`);
