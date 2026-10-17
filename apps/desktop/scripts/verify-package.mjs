// 打包产物体检：装完点不开的事故，最容易出在「Node 依赖没被打进 app.asar」上。
//
// tsc 只负责把 import 编出来，electron-builder 不会替你验证它能不能解析 ——
// 于是出现「打包成功、上传成功、用户一启动就崩」：v0.4.8 / v0.4.9 的
// electron-builder.yml 在 files 里写了 `!node_modules/**`（`files` 里的 `!` 会被
// 当成「连生产依赖一起排除」），electron-updater 及其 15 个依赖全没进包，
// main.js 的静态 import 直接抛 ERR_MODULE_NOT_FOUND，整个壳起不来
// （2026-10-17 用户实装复现）。这个脚本就是那次的防线。
//
// 检查的是「产物里到底有什么」，而不是「配置想干什么」：
//   1. 本地 dist/ 的每个文件都必须在 app.asar 里（main / preload / update/*）；
//   2. dist/ 里所有静态 import / require 的外部包，必须在 asar 的 node_modules
//      里真实存在（含 electron-updater 这类运行时依赖）；
//   3. --require-feed 时 app-update.yml 必须存在且 provider 是 github
//      （CI 用；本地 `--dir` 打包不写 feed，所以默认只提示）。
//
// 用法:
//   node scripts/verify-package.mjs [--app <PayasoAgent.app | resources 目录 | app.asar>]
//                                   [--require-feed]
// 退出码非 0 = 这个包别发。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const distDir = path.join(appRoot, 'dist');
const releaseDir = path.join(appRoot, 'release');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
};
const requireFeed = flag('--require-feed');
const explicitApp = option('--app');

const errors = [];
const warnings = [];
const info = [];

/** 在候选路径里找 app.asar；显式传入时只认传入的。 */
function findAsar() {
  const candidates = [];
  if (explicitApp) {
    const target = path.resolve(explicitApp);
    if (target.endsWith('.asar')) {
      candidates.push(target);
    } else if (target.endsWith('.app')) {
      candidates.push(path.join(target, 'Contents', 'Resources', 'app.asar'));
    } else {
      candidates.push(
        path.join(target, 'app.asar'),
        path.join(target, 'resources', 'app.asar'),
        path.join(target, 'Contents', 'Resources', 'app.asar'),
      );
    }
  } else if (existsSync(releaseDir)) {
    for (const entry of readdirSync(releaseDir)) {
      const dir = path.join(releaseDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      // mac：release/mac-arm64/PayasoAgent.app/Contents/Resources/app.asar
      candidates.push(path.join(dir, 'PayasoAgent.app', 'Contents', 'Resources', 'app.asar'));
      // win：release/win-unpacked/resources/app.asar
      candidates.push(path.join(dir, 'resources', 'app.asar'));
    }
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `找不到打包产物 app.asar。候选路径:\n${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
        '先跑一次打包（npm run dist:dmg / dist:win），或显式传 --app。',
    );
  }
  return found;
}

/** 解析 asar 头部，返回包内文件路径集合（`node_modules/x/package.json` 这种形式）。 */
function readAsarEntries(asarPath) {
  const buffer = readFileSync(asarPath);
  let header = null;
  // asar 头部是 Chromium Pickle：先按 (offset=16, length@12) 试，再退 (8, 4)
  for (const [offset, lengthOffset] of [
    [16, 12],
    [8, 4],
  ]) {
    try {
      const length = buffer.readUInt32LE(lengthOffset);
      header = JSON.parse(buffer.subarray(offset, offset + length).toString('utf8'));
      break;
    } catch {
      header = null;
    }
  }
  if (!header || typeof header !== 'object')
    throw new Error('解析 app.asar 头部失败（格式不认识）');

  const entries = new Set();
  const walk = (nodes, prefix) => {
    for (const [name, value] of Object.entries(nodes ?? {})) {
      const full = `${prefix}${name}`;
      if (value && typeof value === 'object' && value.files) walk(value.files, `${full}/`);
      else entries.add(full);
    }
  };
  walk(header.files, '');
  return entries;
}

/** 递归列 dist/ 下的 JS 文件（相对 appRoot 的 asar 内路径 + 绝对路径）。 */
function listDistFiles(dir = distDir, prefix = 'dist') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listDistFiles(full, relative));
    else if (/\.(c|m)?js$/.test(entry.name)) files.push({ asarPath: relative, file: full });
  }
  return files;
}

/** 从源码文本里抠出所有裸包名（相对路径 / node: / 内置模块 / electron 都不算）。 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g, // import ... from 'x' / export ... from 'x'
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // 动态 import('x')
  /\bimport\s+['"]([^'"]+)['"]/g, // 副作用 import 'x'
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g, // CJS require('x')
];

const nodeBuiltins = new Set(builtinModules);
/** 由 Electron 运行时提供，不在 node_modules 里。 */
const runtimeProvided = new Set(['electron']);
const subpathExtension = /\.(c|m)?js$/;

function packageNameOf(specifier) {
  if (!specifier) return null;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#'))
    return null;
  if (specifier.startsWith('node:')) return null;
  const clean = specifier.split('?')[0].replace(subpathExtension, '');
  const parts = clean.split('/');
  const name = clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!name) return null;
  if (nodeBuiltins.has(name)) return null;
  if (runtimeProvided.has(name)) return null;
  return name;
}

function collectExternalPackages() {
  /** @type {Map<string, Set<string>>} 包名 → 引用它的 dist 文件 */
  const required = new Map();
  for (const { asarPath, file } of listDistFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const name = packageNameOf(match[1]);
        if (!name) continue;
        if (!required.has(name)) required.set(name, new Set());
        required.get(name).add(asarPath);
      }
    }
  }
  return required;
}

function main() {
  const asarPath = findAsar();
  const entries = readAsarEntries(asarPath);
  const packages = [
    ...new Set(
      [...entries]
        .filter((e) => e.startsWith('node_modules/') && e.split('/')[2] === 'package.json')
        .map((e) => e.split('/')[1]),
    ),
  ].sort();

  const appName = asarPath.includes('.app/')
    ? path.basename(path.resolve(asarPath, '../../..'))
    : path.basename(path.dirname(path.dirname(asarPath)));
  info.push(
    `app.asar    ${appName}  (${(statSync(asarPath).size / 1024 / 1024).toFixed(2)} MB，${entries.size} 个条目)`,
  );
  info.push(`依赖        ${packages.length} 个: ${packages.join(', ') || '（无）'}`);

  // 1) dist 编译产物必须整份在包里
  if (!existsSync(distDir)) {
    errors.push(`本地 ${distDir} 不存在（先 npm run build）`);
  } else {
    const missingBuildFiles = listDistFiles()
      .filter(({ asarPath: p }) => !entries.has(p))
      .map(({ asarPath: p }) => p);
    if (missingBuildFiles.length > 0)
      errors.push(`asar 缺少编译产物: ${missingBuildFiles.join(', ')}`);
  }

  // 2) dist 引用的外部包必须真的在 asar 的 node_modules 里
  const required = collectExternalPackages();
  const missing = [...required.entries()].filter(
    ([name]) => !entries.has(`node_modules/${name}/package.json`),
  );
  if (missing.length > 0) {
    for (const [name, importers] of missing) {
      errors.push(
        `asar 里缺少依赖 "${name}"（被 ${[...importers].join(', ')} 引用）→ 装完一启动就会 ERR_MODULE_NOT_FOUND`,
      );
    }
  }

  // 3) 自更新 feed（CI 硬门禁；本地 --dir 不生成，只提示）
  const feedPath = path.join(path.dirname(asarPath), 'app-update.yml');
  if (!existsSync(feedPath)) {
    const message = `缺少 ${feedPath}（publish 没生效 / 打包没走到最后）`;
    if (requireFeed) errors.push(message);
    else warnings.push(`${message} —— 本地 --dir 打包正常，CI 会用 --require-feed 卡住`);
  } else {
    const feed = readFileSync(feedPath, 'utf8');
    if (!/provider:\s*github/.test(feed)) errors.push(`${feedPath} 的 provider 不是 github`);
    else info.push('feed        app-update.yml ✓ (provider: github)');
  }

  for (const line of info) console.log(`✓ ${line}`);
  for (const line of warnings) console.log(`⚠ ${line}`);
  for (const line of errors) console.error(`✗ ${line}`);

  if (errors.length > 0) {
    console.error(`\n打包产物体检失败：${errors.length} 个问题。这个包不能发。`);
    process.exit(1);
  }
  console.log('\n打包产物体检通过。');
}

main();
