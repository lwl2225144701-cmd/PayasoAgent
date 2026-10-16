export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'payaso.themeMode';

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function readThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Private browsing / blocked storage should not prevent theme switching.
  }
}

export function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 桌面壳能力桥的最小结构。
 *
 * 权威声明在 `web/src/vite-env.d.ts`（全局 `Window` 增强）；这里另写一份是因为
 * `tests/` 按根 tsconfig 检查本文件时看不到 web 自己的全局声明。方法全是
 * 可选的 —— 老壳（本次改动之前安装的版本）的桥里没有 `setNativeTheme`，
 * 新网页配老壳不能因此抛异常。
 */
interface NativeThemeBridge {
  setNativeTheme?: (mode: ThemeMode, resolved: ResolvedTheme) => void;
}

/**
 * 把主题报给桌面壳，让它同步原生 chrome（系统标题栏 / 菜单栏 / 窗口按钮叠加层）。
 *
 * 报的是「模式 + 解析值」两样：模式让壳设 `themeSource`（`system` 才能继续跟随
 * 系统），解析值让壳直接刷 Windows 的窗口按钮叠加层颜色 —— 壳不用再猜一次。
 *
 * 浏览器里没有这个桥（`window.payasoDesktop` 为 undefined）→ 静默跳过；
 * 报失败也不该影响页面主题，所以整体 try/catch。
 */
function publishNativeTheme(mode: ThemeMode, resolved: ResolvedTheme): void {
  const bridge = (window as unknown as { payasoDesktop?: NativeThemeBridge }).payasoDesktop;
  try {
    bridge?.setNativeTheme?.(mode, resolved);
  } catch {
    // 桥不可用/被拒：页面主题照旧生效。
  }
}

export function applyThemeMode(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveThemeMode(mode);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeMode = mode;
  root.style.colorScheme = resolved;

  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute('content', resolved === 'dark' ? '#0f1115' : '#f5f7fb');
  publishNativeTheme(mode, resolved);
  return resolved;
}

export function subscribeToSystemTheme(listener: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => listener();
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }
  media.addListener(onChange);
  return () => media.removeListener(onChange);
}
