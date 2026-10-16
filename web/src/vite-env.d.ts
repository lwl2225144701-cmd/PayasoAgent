/// <reference types="vite/client" />

/**
 * 桌面壳（Electron）通过 preload 注入的能力桥。
 *
 * **只有壳里才有**：用浏览器直接打开 http://127.0.0.1:4500（或 `pnpm dev`）
 * 时它是 undefined，此时必须回落到页内目录选择器。
 */
interface PayasoDesktopBridge {
  /** 打开系统原生目录选择框。返回选中的绝对路径；用户取消返回 null。 */
  pickDirectory: () => Promise<string | null>;
  /**
   * 把页面主题模式（light/dark/system）同步给壳的原生 chrome。
   *
   * 不报的话，「系统标题栏 / 菜单栏 / 原生控件」会跟着**系统**外观走 ——
   * 页面是深色、窗口边框却是浅色（DSH 由渲染进程发
   * `dsh-desktop:native-theme-set` 做同一件事）。
   */
  setNativeTheme: (mode: 'light' | 'dark' | 'system') => void;
}

interface Window {
  payasoDesktop?: PayasoDesktopBridge;
}
