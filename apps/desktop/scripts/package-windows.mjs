// 保留上游卸载器生成、签名、压缩与体检，只改 makensis 输入的两个受控插入点。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = require('app-builder-lib/package.json');
if (pkg.version !== '26.15.3')
  throw new Error(`Review NSIS adapter for app-builder-lib ${pkg.version}`);
const templates = path.join(
  path.dirname(require.resolve('app-builder-lib/package.json')),
  'templates',
  'nsis',
);
const hashes = {
  'installer.nsi': '8811964416d122612c3e7601728af5d3f998d677918df829a4e8b4c739c8b9f8',
  'installSection.nsh': '74c4dbb4163cdd90ca4850b75d304e916235c882d6af7b5cdad63bffbc977072',
};
for (const [file, hash] of Object.entries(hashes)) {
  if (
    createHash('sha256')
      .update(readFileSync(path.join(templates, file)))
      .digest('hex') !== hash
  )
    throw new Error(`Upstream NSIS template changed: ${file}`);
}
let section = readFileSync(path.join(templates, 'installSection.nsh'), 'utf8');
section = section.replace(
  'Var /GLOBAL keepShortcuts',
  '!insertmacro payasoPrepareUpdate\n\nVar /GLOBAL keepShortcuts',
);
section = section.replace('!insertmacro StartApp', '!insertmacro payasoStartVerifiedApp');
// 上游失败分支使用 Quit 而不是 Abort，不会触发 .onInstFailed；必须先恢复链接。
for (const scope of ['SHELL_CONTEXT', 'HKEY_CURRENT_USER']) {
  const call = `!insertmacro uninstallOldVersion ${scope}`;
  if (!section.includes(call)) throw new Error(`Missing uninstall call for ${scope}`);
  section = section.replace(call, `${call}\n!insertmacro payasoCheckUninstall`);
}
if (
  (section.match(/payasoPrepareUpdate/g) ?? []).length !== 1 ||
  (section.match(/payasoStartVerifiedApp/g) ?? []).length !== 1
)
  throw new Error('Missing or duplicate NSIS insertion points');
if (
  section.indexOf('CHECK_APP_RUNNING') > section.indexOf('payasoPrepareUpdate') ||
  section.indexOf('payasoPrepareUpdate') > section.indexOf('!insertmacro uninstallOldVersion')
)
  throw new Error('Unsafe NSIS update ordering');
// 先初始化公共入口，避免先加载内部 NsisTarget 触发上游循环依赖。
const { build, Platform } = require('electron-builder');
const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget.js');
if (process.argv.includes('--check')) {
  console.log('NSIS template hashes and transaction insertion points verified');
} else {
  if (process.platform !== 'win32') throw new Error('Package Windows installer on Windows');
  const output = path.join(root, 'build', 'nsis-generated');
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'installSection.nsh'), section);
  const original = NsisTarget.prototype.executeMakensis;
  NsisTarget.prototype.executeMakensis = function (defines, commands, script, options) {
    const include = '!include "installSection.nsh"';
    if (!script.includes(include)) throw new Error('NSIS adapter lost installer include');
    return original.call(
      this,
      defines,
      commands,
      script.replace(
        include,
        '!include "${BUILD_RESOURCES_DIR}\\nsis-generated\\installSection.nsh"',
      ),
      options,
    );
  };
  try {
    await build({
      projectDir: root,
      targets: Platform.WINDOWS.createTarget(['nsis', 'zip']),
      publish: 'never',
    });
  } finally {
    NsisTarget.prototype.executeMakensis = original;
  }
}
