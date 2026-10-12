// open-in-app 的固定应用清单 —— "装了什么应用是 Host 的事实，Client 不猜"。
//
// 每个条目声明各平台的定位方式，resolver.ts 逐条**证明**装机（扫目录/查 PATH/
// 读注册表/XDG），未证明的不出现在列表里。本文件不做任何 IO。
//
// 平台定位方式：
// - darwin app-bundle：在 /Applications、/System/Applications、/System/Library/CoreServices、
//   ~/Applications 里找 <name>（names 为候选序，命中即止）
// - path：可执行文件名，在 PATH 各目录下探测（X_OK）
// - win-path：相对用户目录的固定相对路径（%USERPROFILE% 下），存在即装
// - win-registry：reg.exe query <key>（Uninstall 键存在即装）
// - desktop-entry：XDG 数据目录 applications/ 下存在 <name>.desktop

export type LocateSpec =
  | { kind: 'app-bundle'; names: string[] }
  | { kind: 'path'; names: string[] }
  | { kind: 'win-path'; rel: string }
  | { kind: 'win-registry'; key: string }
  | { kind: 'desktop-entry'; names: string[] };

export interface AppCatalogEntry {
  /** 稳定 id（URL 与 localStorage 选择用）。 */
  id: string;
  /** 显示名（原样渲染，不做 i18n——应用名是专有名词）。 */
  label: string;
  darwin?: LocateSpec;
  win32?: LocateSpec;
  linux?: LocateSpec;
}

export const APP_CATALOG: readonly AppCatalogEntry[] = [
  // —— 系统默认 ——
  { id: 'finder', label: '访达', darwin: { kind: 'app-bundle', names: ['Finder.app'] } },
  {
    id: 'terminal',
    label: '终端',
    darwin: { kind: 'app-bundle', names: ['Terminal.app'] },
    win32: { kind: 'path', names: ['wt.exe', 'cmd.exe'] },
    linux: { kind: 'desktop-entry', names: ['org.gnome.Terminal.desktop', 'xterm.desktop'] },
  },
  // —— 终端 ——
  { id: 'iterm2', label: 'iTerm2', darwin: { kind: 'app-bundle', names: ['iTerm.app'] } },
  { id: 'warp', label: 'Warp', darwin: { kind: 'app-bundle', names: ['Warp.app'] } },
  { id: 'ghostty', label: 'Ghostty', darwin: { kind: 'app-bundle', names: ['Ghostty.app'] } },
  // —— 编辑器 / IDE ——
  {
    id: 'vscode',
    label: 'VS Code',
    darwin: { kind: 'app-bundle', names: ['Visual Studio Code.app'] },
    win32: { kind: 'win-path', rel: 'AppData/Local/Programs/VS Code/Code.exe' },
    linux: { kind: 'desktop-entry', names: ['code.desktop'] },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    darwin: { kind: 'app-bundle', names: ['Cursor.app'] },
    win32: { kind: 'win-path', rel: 'AppData/Local/Programs/cursor/Cursor.exe' },
    linux: { kind: 'desktop-entry', names: ['cursor.desktop', 'cursor-url-handler.desktop'] },
  },
  {
    id: 'zed',
    label: 'Zed',
    darwin: { kind: 'app-bundle', names: ['Zed.app'] },
    linux: { kind: 'path', names: ['zed'] },
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    darwin: { kind: 'app-bundle', names: ['Sublime Text.app'] },
    linux: { kind: 'desktop-entry', names: ['sublime_text.desktop'] },
  },
  {
    id: 'intellij-idea',
    label: 'IntelliJ IDEA',
    darwin: {
      kind: 'app-bundle',
      names: ['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app', 'IntelliJ IDEA CE.app'],
    },
    win32: {
      kind: 'win-path',
      rel: 'AppData/Local/Programs/IntelliJ IDEA Ultimate/bin/idea64.exe',
    },
    linux: {
      kind: 'desktop-entry',
      names: ['jetbrains-idea.desktop', 'jetbrains-idea-ce.desktop'],
    },
  },
  {
    id: 'webstorm',
    label: 'WebStorm',
    darwin: { kind: 'app-bundle', names: ['WebStorm.app'] },
    linux: { kind: 'desktop-entry', names: ['jetbrains-webstorm.desktop'] },
  },
  {
    id: 'pycharm',
    label: 'PyCharm',
    darwin: { kind: 'app-bundle', names: ['PyCharm.app', 'PyCharm Professional.app'] },
    linux: {
      kind: 'desktop-entry',
      names: ['jetbrains-pycharm.desktop', 'jetbrains-pycharm-ce.desktop'],
    },
  },
  {
    id: 'goland',
    label: 'GoLand',
    darwin: { kind: 'app-bundle', names: ['GoLand.app'] },
    linux: { kind: 'desktop-entry', names: ['jetbrains-goland.desktop'] },
  },
  {
    id: 'datagrip',
    label: 'DataGrip',
    darwin: { kind: 'app-bundle', names: ['DataGrip.app'] },
    linux: { kind: 'desktop-entry', names: ['jetbrains-datagrip.desktop'] },
  },
  {
    id: 'xcode',
    label: 'Xcode',
    darwin: { kind: 'app-bundle', names: ['Xcode.app'] },
  },
  {
    id: 'android-studio',
    label: 'Android Studio',
    darwin: { kind: 'app-bundle', names: ['Android Studio.app'] },
  },
];
