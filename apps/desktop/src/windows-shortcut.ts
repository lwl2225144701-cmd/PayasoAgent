// Windows 安装目录在更新时会被 NSIS 整目录挪走再写回。
// 桌面 .lnk 会被系统链接跟踪改到临时路径；文件落盘后要按当前 exe 重写。
import path from 'node:path';

/** 与 electron-builder.yml 的 appId 一致，NSIS 写进快捷方式的 AppUserModelID。 */
export const WINDOWS_APP_USER_MODEL_ID = 'com.payaso.agent';

/** 与 productName 一致，NSIS 的快捷方式文件名是 `${SHORTCUT_NAME}.lnk`。 */
export const WINDOWS_SHORTCUT_NAME = 'PayasoAgent.lnk';

export const WINDOWS_SHORTCUT_DESCRIPTION =
  'PayasoAgent 桌面壳：安装后自动拉起自带 Node 跑的后端，并直接打开 Web UI';

export interface ShortcutLink {
  target: string;
  cwd?: string;
  icon?: string;
  iconIndex?: number;
  appUserModelId?: string;
}

export interface ShortcutDetails {
  target: string;
  cwd: string;
  icon: string;
  iconIndex: number;
  appUserModelId: string;
  description: string;
}

export type ShortcutRepair = { action: 'skip' } | { action: 'write'; reason: 'missing' | 'stale' };

export function sameWindowsPath(left: string, right: string): boolean {
  const norm = (value: string) =>
    path.win32
      .normalize(value)
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  return norm(left) === norm(right);
}

/** 快捷方式是否已经指向这次安装的 exe、图标和工作目录。空的图标 / AUMID 视为旧快捷方式，不因此重写。 */
export function shortcutMatchesInstall(
  link: ShortcutLink,
  execPath: string,
  appUserModelId: string,
): boolean {
  if (!link.target || !sameWindowsPath(link.target, execPath)) return false;
  if (link.icon && (!sameWindowsPath(link.icon, execPath) || (link.iconIndex ?? 0) !== 0))
    return false;
  if (link.appUserModelId && link.appUserModelId !== appUserModelId) return false;
  if (link.cwd && !sameWindowsPath(link.cwd, path.win32.dirname(execPath))) return false;
  return true;
}

/**
 * 更新后要不要改这条快捷方式。
 * 目标已经错了就立刻改写；文件不存在时，只有「这次是更新后的启动」才补建，避免用户删掉图标后又被加回来。
 */
export function planShortcutRepair(options: {
  existing: ShortcutLink | null;
  execPath: string;
  appUserModelId: string;
  restoreIfMissing: boolean;
}): ShortcutRepair {
  if (!options.existing) {
    return options.restoreIfMissing ? { action: 'write', reason: 'missing' } : { action: 'skip' };
  }
  if (!shortcutMatchesInstall(options.existing, options.execPath, options.appUserModelId)) {
    return { action: 'write', reason: 'stale' };
  }
  return { action: 'skip' };
}

/** 安装器带着 --updated 拉起，或这个版本还没成功核对过快捷方式时，允许把被系统删掉的图标补回来。 */
export function shouldRestoreMissingShortcut(options: {
  argv: readonly string[];
  seenVersion: string | null;
  currentVersion: string;
}): boolean {
  if (options.argv.includes('--updated')) return true;
  return options.seenVersion !== options.currentVersion;
}

export function windowsShortcutDetails(
  execPath: string,
  appUserModelId: string,
  description: string,
): ShortcutDetails {
  return {
    target: execPath,
    cwd: path.win32.dirname(execPath),
    icon: execPath,
    iconIndex: 0,
    appUserModelId,
    description,
  };
}
