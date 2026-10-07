// 取「官方 Node 运行时」放进 runtime/bin/node —— A1 的核心（壳自带 Node，绕开
// Electron 与官方 Node 的 ABI 差异，三个原生模块一个都不用重编）。
//
// 用法: node scripts/fetch-node.mjs [version]     默认 v22.22.3（后端开发/测试所用版本）
//
// 只解出 bin/node 一个文件（不带 npm/npx），体积约 100MB 量级。
// nodejs.org 在国内网络下可能拉不动，脚本会自动回退 npmmirror 镜像。
// Windows 暂不处理：本项目当前目标是 macOS，Windows 桌面包另议。

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const version = process.argv[2] ?? 'v22.22.3';
const platform = process.platform;
const arch = process.arch;

if (platform === 'win32') {
  console.error('暂不支持 Windows：请先补 win32 的解压与放置逻辑');
  process.exit(1);
}
const platformTag = platform === 'darwin' ? 'darwin' : 'linux';
const archiveName = `node-${version}-${platformTag}-${arch}.tar.xz`;
const innerDir = `node-${version}-${platformTag}-${arch}`;

const mirrors = [
  `https://nodejs.org/dist/${version}/${archiveName}`,
  `https://npmmirror.com/mirrors/node/${version}/${archiveName}`,
];

const outDir = path.join(root, 'runtime', 'bin');
const nodeBin = path.join(outDir, 'node');
const workDir = path.join(root, 'runtime', '.tmp');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`命令失败: ${cmd} ${args.join(' ')}`);
    return false;
  }
  return true;
}

mkdirSync(outDir, { recursive: true });

// 已经有了且版本对得上，就直接跳过（可重复执行）
if (existsSync(nodeBin)) {
  const v = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' });
  if (v.stdout?.trim() === version) {
    console.log(`已存在 ${nodeBin} (${v.stdout.trim()})，跳过下载`);
    process.exit(0);
  }
}

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const archive = path.join(workDir, archiveName);
let downloaded = false;
for (const url of mirrors) {
  console.log(`下载 ${url}`);
  if (run('curl', ['-fL', '--retry', '3', '--retry-delay', '2', '-o', archive, url])) {
    downloaded = true;
    break;
  }
}
if (!downloaded) {
  console.error('两个镜像都拉不到 Node 运行时；请手动下载后放到:', nodeBin);
  process.exit(1);
}

// 只解 bin/node，其余（npm、头文件、文档）一概不要
if (!run('tar', ['-xJf', archive, '-C', workDir, '--strip-components=1', `${innerDir}/bin/node`])) {
  process.exit(1);
}

const extracted = path.join(workDir, 'bin', 'node');
if (!existsSync(extracted)) {
  console.error('解压后没找到 bin/node');
  process.exit(1);
}
chmodSync(extracted, 0o755);
rmSync(nodeBin, { force: true });
mkdirSync(path.dirname(nodeBin), { recursive: true });
run('mv', [extracted, nodeBin]);
rmSync(workDir, { recursive: true, force: true });

const check = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' });
if (check.status !== 0) {
  console.error('放置后的 node 跑不起来:', check.stderr);
  process.exit(1);
}
console.log(`OK ${nodeBin} (${check.stdout.trim()})`);
