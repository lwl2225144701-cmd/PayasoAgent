// 把发布版本号同步进 apps/desktop/package.json（DMG 文件名与应用「关于」里的版本都来自它）。
//
// 用法:
//   PAYASO_RELEASE_VERSION=0.2.0 node scripts/sync-version.mjs
//
// 未设置该环境变量时原样退出（本地开发不想被改版本）。
// 同时更新 package-lock.json 的 version 字段，否则之后 `npm ci` 会报
// "package.json and package-lock.json are in sync" 之外的那个错（不同步）。
//
// 为什么不让 electron-builder 自己传版本：它只认 package.json；而 lock 也得跟着改，
// 交给一个可测试的小脚本比在 workflow 里内联 sed 稳。

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

const version = process.env.PAYASO_RELEASE_VERSION?.trim();
if (!version) {
  console.log('PAYASO_RELEASE_VERSION 未设置，跳过版本同步（本地开发）');
  process.exit(0);
}

// 宽松 semver：major.minor.patch，允许预发布后缀（0.2.0-beta.1）
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/.test(version)) {
  console.error(`非法版本号: ${version}（应为 major.minor.patch）`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const previous = pkg.version;
if (previous === version) {
  console.log(`版本已是 ${version}，无需改动`);
  process.exit(0);
}
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// lock 里有两处：顶层 version 与 packages[""].version
try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`版本 ${previous} → ${version}（package.json + package-lock.json）`);
} catch (error) {
  console.error(
    '未能同步 package-lock.json，请检查:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}
