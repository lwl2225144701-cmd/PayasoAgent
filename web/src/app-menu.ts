// 模块: 桌面壳「应用」菜单的页面侧桥（Windows 专用）。
//
// 为什么需要：Windows 的窗口是 `titleBarStyle: 'hidden'` 的无边框窗口，Electron 不会把
// 原生菜单挂到 HWND 上（实测 GetMenu=0），只有 macOS 有系统菜单栏。所以 Windows 的
// 「关于 / 检查更新… / 退出」只能由页面自绘，再经 preload 桥回主进程执行。
//
// 与 update-status.ts 同一套容错约定：桥方法全部可选（新页面配老壳不能抛），
// 浏览器里没有桥 → 整块菜单不渲染。

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
}

interface DesktopAppBridge {
  platform?: string;
  checkForUpdates?: () => Promise<void>;
  quitApp?: () => void;
  getAppInfo?: () => Promise<AppInfo | null>;
}

function bridge(): DesktopAppBridge | undefined {
  return (window as unknown as { payasoDesktop?: DesktopAppBridge }).payasoDesktop;
}

/**
 * 只在「桌面壳 + Windows」时渲染自绘菜单。
 * macOS 用系统菜单栏（本方案明确不动它），浏览器直开时没有壳。
 */
export function canShowAppMenu(): boolean {
  return bridge()?.platform === 'win32';
}

/** 触发一次交互式检查；结果由壳用原生对话框反馈，页面不重复渲染。 */
export async function checkForUpdates(): Promise<void> {
  try {
    await bridge()?.checkForUpdates?.();
  } catch {
    // 桥不可用/被拒：忽略（菜单项本来就只在壳里出现）
  }
}

/** 退出应用（壳会先优雅停后端，见 main.ts 的 before-quit）。 */
export function quitApp(): void {
  try {
    bridge()?.quitApp?.();
  } catch {
    // 同上：失败也不该在页面里炸
  }
}

/** 「关于」要展示的版本信息；老壳没有该方法时返回 null（弹窗只显示应用版本）。 */
export async function readAppInfo(): Promise<AppInfo | null> {
  try {
    const info = await bridge()?.getAppInfo?.();
    if (!info || typeof info.version !== 'string') return null;
    return {
      version: info.version,
      electron: typeof info.electron === 'string' ? info.electron : '',
      node: typeof info.node === 'string' ? info.node : '',
    };
  } catch {
    return null;
  }
}
