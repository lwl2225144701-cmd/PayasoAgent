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
   * 把页面主题同步给壳的原生 chrome。
   *
   * 两个参数都要：`mode`（light/dark/system）让壳设 `nativeTheme.themeSource`
   * —— 报 `system` 才能继续跟随系统；`resolved` 是解析后的实际主题，Windows 的
   * 窗口按钮叠加层颜色按它刷（壳不用再猜一次）。
   *
   * 不报的话，「系统标题栏 / 菜单栏 / 窗口按钮」会跟着**系统**外观走 ——
   * 页面是深色、窗口右上角却是浅色（DSH 由渲染进程发
   * `dsh-desktop:native-theme-set` 做同一件事）。
   */
  setNativeTheme: (mode: 'light' | 'dark' | 'system', resolved: 'light' | 'dark') => void;
  /** 订阅自更新状态（有新版本 / 下载中）；返回取消订阅。 */
  onUpdateStatus: (listener: (status: unknown) => void) => () => void;
  /** 点侧边栏「新版本」→ 让壳开始下载（安装确认仍走原生对话框）。 */
  startUpdateDownload: () => void;
}

interface Window {
  payasoDesktop?: PayasoDesktopBridge;
}
