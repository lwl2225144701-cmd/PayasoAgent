// electron-builder afterPack 钩子：给 .app 补 ad-hoc 签名。
//
// 为什么必须签：Apple Silicon 要求每个可执行映像至少有 ad-hoc 签名。electron-builder
// 找不到证书时整个跳过签名（"skipped macOS application code signing"），而打包过程改了
// Electron 的 Resources（app.asar / extraResources），Electron 原有的签名封条失效 ——
// 用户下载后 Gatekeeper 直接弹「已损坏，无法打开，移到废纸篓」（不是"未验证开发者"，
// 右键打开都不给走）。
//
// 补 `codesign -s -` 后签名有效但非 Developer ID → 弹窗降级为「无法验证开发者」，
// 右键 → 打开 可通行。要彻底零弹窗需要 Apple Developer ID 签名 + 公证（CI 已留
// CSC_*/APPLE_* 入口，配了 secrets 即自动签名公证，本钩子届时自然不生效——见下方判断）。
//
// 位置必须是 afterPack：dmg/zip 是从打包完的 .app 制作的，钩子在目标制作前跑，
// 保证 DMG 里、ZIP 里都是签好的 app。
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // 配了真证书时 electron-builder 自己会签（Developer ID），这里不抢活。
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.MAC_CERTS) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  // 自检：签完必须有效，坏了就当场报错，别让坏包流出去。
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
};
