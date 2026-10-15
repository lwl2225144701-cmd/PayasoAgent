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
}

interface Window {
  payasoDesktop?: PayasoDesktopBridge;
}
