// 桌面壳 → 渲染进程的能力桥（唯一出口）。
//
// 暴露两件事：① 选目录 ② 把页面主题模式报给原生 chrome。
//
// 选目录为什么必须走这里（而不是 Host 侧 shell 出去调系统命令）：
// - **慢**：旧实现 win32 走 PowerShell 5.1，光 `powershell.exe` 冷启动 +
//   `Add-Type -AssemblyName System.Windows.Forms` 加载 WinForms 程序集就要
//   1.5~4 秒（真机反馈"windows 打开原生目录很慢"）；darwin 的 osascript
//   实测也有 40~100ms 的进程开销。Electron 的 dialog 是已加载进程内的原生
//   调用，没有这两段开销。
// - **被遮挡**：shell 出去的对话框归那个 shell 进程所有，与应用窗口没有父子
//   关系，Windows 上会跑到窗口后面去。`showOpenDialog(window, …)` 归应用窗口
//   （macOS 挂成窗口 sheet / Windows 正确模态），不会遮挡。
//
// 文件是 .cts（→ 编译为 CommonJS 的 preload.cjs）：Electron 的 sandbox 化
// preload 不能是 ESM，而本包 package.json 是 "type": "module"。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('payasoDesktop', {
  /** 打开系统目录选择框。返回选中的绝对路径；用户取消返回 null。 */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('payaso:pickDirectory'),
  /**
   * 主题模式 → 主进程 `nativeTheme.themeSource`。DSH 同款配方：它的渲染进程
   * 监听 `data-theme-source` 后发 `dsh-desktop:native-theme-set`，主进程设
   * themeSource。不报的话，Windows/macOS 的**系统**标题栏、菜单栏会跟系统
   * 外观走，页面深色、窗口边框却是浅色。
   *
   * 第二个参数是**解析后**的主题（light/dark）：Windows 的窗口按钮叠加层颜色
   * 按它刷，主进程不用再猜一次（猜就要读 shouldUseDarkColors，多一次时序假设）。
   */
  setNativeTheme: (mode: 'light' | 'dark' | 'system', resolved: 'light' | 'dark'): void => {
    ipcRenderer.send('payaso:nativeThemeSet', mode, resolved);
  },
  /**
   * 订阅自更新状态，并在监听器就绪后请求当前快照，避免刷新时漏掉状态。
   *
   * 页面侧用它渲染侧边栏「设置」上方的条目（真机反馈：下载 227MB 期间界面没有
   * 任何反馈）。返回取消订阅函数；浏览器里没有这个桥，页面必须容忍。
   */
  onUpdateStatus: (listener: (status: unknown) => void): (() => void) => {
    const channel = 'payaso:updateStatus';
    const handler = (_event: Electron.IpcRendererEvent, status: unknown): void => listener(status);
    ipcRenderer.on(channel, handler);
    ipcRenderer.send('payaso:updateStatusRequest');
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
  /** 点侧边栏「新版本」→ 让壳开始下载（安装确认仍走原生对话框）。 */
  startUpdateDownload: (): void => {
    ipcRenderer.send('payaso:updateDownload');
  },
});
