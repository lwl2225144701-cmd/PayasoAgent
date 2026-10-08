// 取「官方 Node 运行时」放进 runtime/bin/node —— A1 的核心（壳自带 Node，绕开
// Electron 与官方 Node 的 ABI 差异，三个原生模块一个都不用重编）。
//
// 用法: node scripts/fetch-node.mjs [version]     默认 v22.22.3（后端开发/测试所用版本）
//
// 只解出 node 本体一个文件（不带 npm/npx），体积约 100MB 量级。
// nodejs.org 在国内网络下可能拉不动，脚本会自动回退 npmmirror 镜像。
// win32 / darwin / linux 三平台都支持（win 发 zip + node.exe，其余 tar.xz + bin/node）。

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const version = process.argv[2] ?? 'v22.22.3';
const platform = process.platform;
const arch = process.arch;

// win32：官方发 zip（内含 node.exe）；darwin / linux 发 tar.xz（内含 bin/node）
const isWin = platform === 'win32';
const platformTag = isWin ? 'win' : platform === 'darwin' ? 'darwin' : 'linux';
const archiveName = `node-${version}-${platformTag}-${arch}${isWin ? '.zip' : '.tar.xz'}`;
const innerDir = `node-${version}-${platformTag}-${arch}`;
const innerFile = isWin ? 'node.exe' : 'bin/node';

const mirrors = [
  `https://nodejs.org/dist/${version}/${archiveName}`,
  `https://npmmirror.com/mirrors/node/${version}/${archiveName}`,
];

const outDir = path.join(root, 'runtime', 'bin');
const nodeBin = path.join(outDir, isWin ? 'node.exe' : 'node');
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

// 只解 node 本体，其余（npm、头文件、文档）一概不要。tar 三平台都内置
// （Windows 10+ 自带 bsdtar，能直接解 zip），压缩格式靠 -xf 自动识别。
if (
  !run('tar', ['-xf', archive, '-C', workDir, '--strip-components=1', `${innerDir}/${innerFile}`])
) {
  process.exit(1);
}

const extracted = path.join(workDir, isWin ? 'node.exe' : path.join('bin', 'node'));
if (!existsSync(extracted)) {
  console.error(`解压后没找到 ${innerFile}`);
  process.exit(1);
}
chmodSync(extracted, 0o755);
rmSync(nodeBin, { force: true });
mkdirSync(path.dirname(nodeBin), { recursive: true });
renameSync(extracted, nodeBin); // 跨平台搬运（Windows 没有 mv 命令）
rmSync(workDir, { recursive: true, force: true });

const check = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' });
if (check.status !== 0) {
  console.error('放置后的 node 跑不起来:', check.stderr);
  process.exit(1);
}
console.log(`OK ${nodeBin} (${check.stdout.trim()})`);
