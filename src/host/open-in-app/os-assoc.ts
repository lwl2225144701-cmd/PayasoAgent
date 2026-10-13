// os-assoc：问操作系统"这个文件能用哪些应用打开"（macOS 实现）。
//
// 为什么问系统而不是查表：文件类型与应用的关联是系统事实（LaunchServices 数据库，
// 由每个 App 的 Info.plist CFBundleDocumentTypes 声明 + 用户选择演化而来），
// 任何静态清单都是猜——猜的结果就是 PDF 菜单里出现 Cursor。目录目标没有统一的
// "用某 App 打开目录"关联机制，那一边仍用编译期白名单（catalog.ts），两端互补。
//
// 实现：osascript 跑一段**固定**的 JXA 脚本（下面内嵌），路径只经 argv 传入
// （不经 shell、不插进脚本文本）；只读关联信息，绝不修改系统默认应用。
// Windows / Linux 暂无适配器 → 返回 null，由调用方回落白名单（见 openable.ts）。
//
// 去重（对齐参考实现）：同 bundleId + 同显示名折叠成一条——自更新 App 会留多份
// 拷贝（实测一台机器上 3 份 LibreOffice：codex / TRAE / MiMo 各带一份），
// 保留默认项，否则版本最高的。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 一个"能打开该文件的应用"。id = .app 捆绑绝对路径（也是打开动作的凭据）。 */
export interface OsAssocApp {
  id: string;
  label: string;
  /** 是否系统默认应用（用户选择优先，否则按声明角色）。 */
  isDefault: boolean;
  /** 32px PNG data URL；取不到为 null（前端回退字形芯片）。 */
  icon: string | null;
}

const QUERY_TIMEOUT_MS = 10_000;
const ICON_PX = 32;

/**
 * 固定 JXA 脚本（刻意不用模板字面量，便于原样内嵌进 TS）：
 * stdout 输出单行 JSON [{path,name,default,icon}]，路径取最后一个 argv。
 */
const JXA_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('ImageIO');

function unwrap(value) {
  return value === null || value === undefined ? null : ObjC.deepUnwrap(value);
}

function lastArgument() {
  const args = unwrap($.NSProcessInfo.processInfo.arguments);
  return args.length > 0 ? String(args[args.length - 1]) : null;
}

function bundleInfo(appPath) {
  const bundle = $.NSBundle.bundleWithPath(appPath);
  const info = bundle ? bundle.infoDictionary : null;
  const fallbackName = appPath.split('/').pop().replace(/\\.app$/, '');
  if (info === null || info === undefined) {
    return { bundleId: null, name: fallbackName, version: '0' };
  }
  return {
    bundleId: unwrap(info.objectForKey('CFBundleIdentifier')),
    name: unwrap(info.objectForKey('CFBundleDisplayName'))
        || unwrap(info.objectForKey('CFBundleName'))
        || fallbackName,
    version: String(unwrap(info.objectForKey('CFBundleShortVersionString')) || '0'),
  };
}

function pngDataUrl(source) {
  try {
    const options = $.NSDictionary.dictionaryWithObjectForKey(
      ${ICON_PX},
      'kCGImageSourceThumbnailMaxPixelSize',
    );
    const thumb = $.CGImageSourceCreateThumbnailAtIndex(source, 0, options);
    if (thumb === null || thumb === undefined) return null;
    const rep = $.NSBitmapImageRep.alloc.initWithCGImage(thumb);
    const png = rep.representationUsingTypeProperties(4, $.NSDictionary.dictionary);
    if (png === null || png === undefined) return null;
    const b64 = unwrap(png.base64EncodedStringWithOptions(0));
    return typeof b64 === 'string' ? 'data:image/png;base64,' + b64 : null;
  } catch (e) {
    return null;
  }
}

// 图标首选直读 bundle 内的 icns（ImageIO，~10ms）：NSWorkspace.iconForFile 的
// TIFFRepresentation 会整张 1024px 光栅出来（实测 74MB / 190ms），只为 32px
// 缩略图代价荒谬。直读失败再退回 NSImage 路线。
function iconDataUrl(appPath) {
  try {
    const bundle = $.NSBundle.bundleWithPath(appPath);
    const iconName = bundle ? unwrap(bundle.objectForInfoDictionaryKey('CFBundleIconFile')) : null;
    if (iconName) {
      const resourcePath = unwrap(bundle.resourcePath);
      const iconFile = String(iconName).indexOf('.') === -1 ? iconName + '.icns' : iconName;
      if (resourcePath) {
        const iconPath = resourcePath + '/' + iconFile;
        if ($.NSFileManager.defaultManager.fileExistsAtPath(iconPath)) {
          const url = pngDataUrl($.CGImageSourceCreateWithURL($.NSURL.fileURLWithPath(iconPath), null));
          if (url) return url;
        }
      }
    }
  } catch (e) {
    // 直读失败 → NSImage 兜底
  }
  try {
    const image = $.NSWorkspace.sharedWorkspace.iconForFile(appPath);
    return pngDataUrl($.CGImageSourceCreateWithData(image.TIFFRepresentation, null));
  } catch (e) {
    return null;
  }
}

function compareVersion(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const va = Number.parseInt(pa[i] || '0', 10) || 0;
    const vb = Number.parseInt(pb[i] || '0', 10) || 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

const target = lastArgument();
if (!target) throw new Error('usage: osascript -l JavaScript <script> <file-path>');

const fileURL = $.NSURL.fileURLWithPath(target);
const workspace = $.NSWorkspace.sharedWorkspace;
const appURLs = workspace.URLsForApplicationsToOpenURL(fileURL);
const defaultURL = workspace.URLForApplicationToOpenURL(fileURL);
const defaultPath = defaultURL ? unwrap(defaultURL.path) : null;

const byKey = new Map();
const count = Number(appURLs.count);
for (let i = 0; i < count; i++) {
  const appPath = unwrap(appURLs.objectAtIndex(i).path);
  if (!appPath) continue;
  const info = bundleInfo(appPath);
  const key = (info.bundleId || appPath) + '|' + info.name;
  const isDefault = appPath === defaultPath;
  const prev = byKey.get(key);
  if (!prev) {
    byKey.set(key, { appPath: appPath, name: info.name, version: info.version, isDefault: isDefault });
    continue;
  }
  const replace = !prev.isDefault && (isDefault || compareVersion(info.version, prev.version) > 0);
  if (replace) {
    byKey.set(key, {
      appPath: appPath,
      name: info.name,
      version: info.version,
      isDefault: prev.isDefault || isDefault,
    });
  }
}

const apps = [];
byKey.forEach(function (app) {
  apps.push({
    path: app.appPath,
    name: app.name,
    default: app.isDefault,
    icon: iconDataUrl(app.appPath),
  });
});

JSON.stringify(apps);
`;

/**
 * 查询"能用 absPath 打开的应用"（macOS）。任何失败 / 非 macOS → null，
 * 调用方据此回落白名单。id 为 .app 捆绑绝对路径，打开前必须经
 * {@link queryFileAssociations} 重新验明正身（见 open 端点的安全边界）。
 */
export async function queryFileAssociations(absPath: string): Promise<OsAssocApp[] | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-l', 'JavaScript', '-e', JXA_SCRIPT, absPath],
      { timeout: QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    const apps: OsAssocApp[] = [];
    for (const item of parsed) {
      const record = item as { path?: unknown; name?: unknown; default?: unknown; icon?: unknown };
      const id = typeof record.path === 'string' ? record.path : '';
      const label = typeof record.name === 'string' ? record.name : '';
      // id 将进入 `open -a <id>` 的 argv：只认绝对 .app 路径
      if (!id.startsWith('/') || !id.endsWith('.app') || label === '') continue;
      apps.push({
        id,
        label,
        isDefault: record.default === true,
        icon: typeof record.icon === 'string' ? record.icon : null,
      });
    }
    return apps;
  } catch {
    return null;
  }
}
