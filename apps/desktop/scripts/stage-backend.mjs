// 组装「后端整体」到 .stage/app/ —— 供 electron-builder 的 extraResources 打进包里。
//
// 用法: node scripts/stage-backend.mjs
//
// 做四件事（顺序有意如此）：
//   1. 重新构建服务端与前端 —— dist/ 会过期，别赌它是新的
//   2. 清空并重建 staging 目录
//   3. 拷 dist/ + web/dist/ + bin/ + package.json + package-lock.json
//   4. 在 staging 里只装**生产**依赖（npm ci --omit=dev）
//
// 为什么 staging 而不是直接拷整个 node_modules：根目录 node_modules 是 312MB
// 且含大量开发依赖（tsx / typescript / biome / vite …），装进 App 全是死重。
// 生产依赖只有 sharp / pi-ai / pdf-lib / pdfjs-dist 等少数几个。

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..'); // 仓库根
const stage = path.resolve(here, '..', '.stage', 'app');

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}   (cwd=${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`失败: ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else total += statSync(p).size;
  }
  return total;
}

// 1. 构建（dist/ 会过期，见 desktop-client-electron-plan.md）
run('npm', ['run', 'build:server'], root);
run('npm', ['run', 'build:web'], root);

// 2. 重建 staging
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 3. 拷贝后端与前端产物
for (const rel of ['dist', path.join('web', 'dist'), 'bin']) {
  const from = path.join(root, rel);
  if (!existsSync(from)) {
    console.error(`缺少 ${from}，先构建`);
    process.exit(1);
  }
  cpSync(from, path.join(stage, rel), { recursive: true });
}
for (const file of ['package.json', 'package-lock.json']) {
  cpSync(path.join(root, file), path.join(stage, file));
}

// 4. 只装生产依赖
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], stage);

console.log(`\nOK 后端整体已就绪: ${stage}`);
console.log(
  `   dist/            ${(dirSize(path.join(stage, 'dist')) / 1024 / 1024).toFixed(1)} MB`,
);
console.log(
  `   web/dist/        ${(dirSize(path.join(stage, 'web', 'dist')) / 1024 / 1024).toFixed(1)} MB`,
);
console.log(
  `   node_modules/    ${(dirSize(path.join(stage, 'node_modules')) / 1024 / 1024).toFixed(1)} MB`,
);
console.log(`   合计             ${(dirSize(stage) / 1024 / 1024).toFixed(1)} MB`);
