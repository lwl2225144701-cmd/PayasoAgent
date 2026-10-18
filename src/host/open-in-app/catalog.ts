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
// - win-gui：Windows 上证明「这个 GUI 装过」——App Paths、PATH 上的 exe、
//   PATH 上的 .cmd 垫片（Cursor / VS Code 的 CLI 会指向真正的 exe）、常见安装目录、
//   有限深度搜索、开始菜单快捷方式。自定义盘符（D:\cursor 这种）靠后三条，不靠写死路径。
// - win-registry：reg.exe query <key>（Uninstall 键存在即装）
// - desktop-entry：XDG 数据目录 applications/ 下存在 <name>.desktop

export type LocateSpec =
  | { kind: 'app-bundle'; names: string[] }
  | { kind: 'path'; names: string[] }
  | { kind: 'win-path'; rel: string }
  | {
      kind: 'win-gui';
      /** 真正的 GUI 可执行文件名（App Paths + PATH）。 */
      exeNames: string[];
      /** CLI 垫片文件名。读脚本里的 `"%~dp0..\..\app.exe"`，不把 .cmd 本身当启动目标。 */
      shimNames?: string[];
      /** 相对「用户 Programs / Program Files / Program Files (x86)」的固定路径。 */
      relPaths?: string[];
      /**
       * 有限深度搜索根。可用 %LOCALAPPDATA% / %ProgramFiles% / %ProgramFiles(x86)% 前缀，
       * 避免把整个用户目录扫一遍。
       */
      searchRoots?: string[];
      /** 开始菜单 .lnk 显示名（精确，或「前缀 + 空格」）。 */
      shortcutHints?: string[];
    }
  | { kind: 'win-registry'; key: string }
  | { kind: 'desktop-entry'; names: string[] };

/**
 * 应用可打开的目标类别（"这个后缀能用哪些应用打开"的应用侧事实）。
 * 'any' = 不挑（访达：任何文件/文件夹都能定位并打开）；
 * 'folder' = 只对文件夹有意义（终端；IDE 也能把文件夹当项目打开）。
 */
export type OpenableKind =
  | 'folder'
  | 'pdf'
  | 'image'
  | 'word'
  | 'sheet'
  | 'slides'
  | 'text'
  | 'any';

export interface AppCatalogEntry {
  /** 稳定 id（URL 与 localStorage 选择用）。 */
  id: string;
  /** 显示名（原样渲染，不做 i18n——应用名是专有名词）。 */
  label: string;
  /** 能打开的目标类别（端点按目标路径过滤列表用；见 openable.ts）。 */
  opens: OpenableKind[];
  darwin?: LocateSpec;
  win32?: LocateSpec;
  linux?: LocateSpec;
}

export const APP_CATALOG: readonly AppCatalogEntry[] = [
  // —— 系统默认 ——
  {
    id: 'finder',
    label: '访达',
    opens: ['any'],
    darwin: { kind: 'app-bundle', names: ['Finder.app'] },
  },
  {
    id: 'explorer',
    label: '文件资源管理器',
    opens: ['any'],
    win32: { kind: 'win-gui', exeNames: ['explorer.exe'] },
  },
  {
    id: 'terminal',
    label: '终端',
    opens: ['folder'],
    darwin: { kind: 'app-bundle', names: ['Terminal.app'] },
    win32: { kind: 'path', names: ['wt.exe', 'cmd.exe'] },
    linux: { kind: 'desktop-entry', names: ['org.gnome.Terminal.desktop', 'xterm.desktop'] },
  },
  // —— 终端 ——
  {
    id: 'iterm2',
    label: 'iTerm2',
    opens: ['folder'],
    darwin: { kind: 'app-bundle', names: ['iTerm.app'] },
  },
  {
    id: 'warp',
    label: 'Warp',
    opens: ['folder'],
    darwin: { kind: 'app-bundle', names: ['Warp.app'] },
  },
  {
    id: 'ghostty',
    label: 'Ghostty',
    opens: ['folder'],
    darwin: { kind: 'app-bundle', names: ['Ghostty.app'] },
  },
  // —— 编辑器 / IDE ——
  {
    id: 'vscode',
    label: 'VS Code',
    opens: ['text', 'folder'],
    darwin: { kind: 'app-bundle', names: ['Visual Studio Code.app'] },
    win32: {
      kind: 'win-gui',
      exeNames: ['Code.exe'],
      shimNames: ['code.cmd', 'code.bat'],
      relPaths: ['Microsoft VS Code/Code.exe', 'VS Code/Code.exe'],
      shortcutHints: ['Visual Studio Code'],
    },
    linux: { kind: 'desktop-entry', names: ['code.desktop'] },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    opens: ['text', 'folder'],
    darwin: { kind: 'app-bundle', names: ['Cursor.app'] },
    win32: {
      kind: 'win-gui',
      exeNames: ['Cursor.exe'],
      shimNames: ['cursor.cmd', 'cursor.bat'],
      relPaths: ['cursor/Cursor.exe', 'Cursor/Cursor.exe'],
      shortcutHints: ['Cursor'],
    },
    linux: { kind: 'desktop-entry', names: ['cursor.desktop', 'cursor-url-handler.desktop'] },
  },
  {
    id: 'zed',
    label: 'Zed',
    opens: ['text', 'folder'],
    darwin: { kind: 'app-bundle', names: ['Zed.app'] },
    linux: { kind: 'path', names: ['zed'] },
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    opens: ['text', 'folder'],
    darwin: { kind: 'app-bundle', names: ['Sublime Text.app'] },
    linux: { kind: 'desktop-entry', names: ['sublime_text.desktop'] },
  },
  {
    id: 'intellij-idea',
    label: 'IntelliJ IDEA',
    opens: ['text', 'folder'],
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
    opens: ['text', 'folder'],
    darwin: { kind: 'app-bundle', names: ['WebStorm.app'] },
    linux: { kind: 'desktop-entry', names: ['jetbrains-webstorm.desktop'] },
  },
  {
    id: 'pycharm',
    label: 'PyCharm',
    opens: ['text', 'folder'],
    darwin: { kind: 'app-bundle', names: ['PyCharm.app', 'PyCharm Professional.app'] },
    win32: {
      kind: 'win-gui',
      exeNames: ['pycharm64.exe'],
      shimNames: ['pycharm.cmd', 'pycharm.bat'],
      searchRoots: [
        '%LOCALAPPDATA%/JetBrains/Toolbox/apps/PyCharm',
        '%ProgramFiles%/JetBrains',
        '%ProgramFiles(x86)%/JetBrains',
      ],
      shortcutHints: ['PyCharm'],
    },
    linux: {
      kind: 'desktop-entry',
      names: ['jetbrains-pycharm.desktop', 'jetbrains-pycharm-ce.desktop'],
    },
  },
  {
    id: 'goland',
    label: 'GoLand',
    opens: ['text', 'folder'],
    darwin: { kind: 'app-bundle', names: ['GoLand.app'] },
    linux: { kind: 'desktop-entry', names: ['jetbrains-goland.desktop'] },
  },
  {
    id: 'datagrip',
    label: 'DataGrip',
    opens: ['text', 'folder'],
    darwin: { kind: 'app-bundle', names: ['DataGrip.app'] },
    linux: { kind: 'desktop-entry', names: ['jetbrains-datagrip.desktop'] },
  },
  {
    id: 'xcode',
    label: 'Xcode',
    opens: ['text', 'folder'],
    darwin: { kind: 'app-bundle', names: ['Xcode.app'] },
  },
  {
    id: 'android-studio',
    label: 'Android Studio',
    opens: ['text', 'folder'],
    darwin: { kind: 'app-bundle', names: ['Android Studio.app'] },
  },
  // —— 浏览器（pdf/图片/文本都能渲染）——
  {
    id: 'safari',
    label: 'Safari',
    opens: ['pdf', 'image', 'text'],
    darwin: { kind: 'app-bundle', names: ['Safari.app'] },
  },
  {
    id: 'chrome',
    label: 'Chrome',
    opens: ['pdf', 'image', 'text'],
    darwin: { kind: 'app-bundle', names: ['Google Chrome.app'] },
    win32: { kind: 'win-path', rel: 'AppData/Local/Google/Chrome/Application/chrome.exe' },
    linux: { kind: 'desktop-entry', names: ['google-chrome.desktop'] },
  },
  {
    id: 'firefox',
    label: 'Firefox',
    opens: ['pdf', 'image', 'text'],
    darwin: { kind: 'app-bundle', names: ['Firefox.app'] },
    linux: { kind: 'desktop-entry', names: ['firefox.desktop'] },
  },
  {
    id: 'edge',
    label: 'Edge',
    opens: ['pdf', 'image', 'text'],
    darwin: { kind: 'app-bundle', names: ['Microsoft Edge.app'] },
    win32: { kind: 'win-path', rel: 'AppData/Local/Microsoft/Edge/Application/msedge.exe' },
  },
  // —— 系统查看器 ——
  {
    id: 'preview',
    label: '预览',
    opens: ['pdf', 'image'],
    darwin: { kind: 'app-bundle', names: ['Preview.app'] },
  },
  {
    id: 'textedit',
    label: '文本编辑',
    opens: ['text'],
    darwin: { kind: 'app-bundle', names: ['TextEdit.app'] },
  },
  // —— Office 三件套 + WPS（docx/xlsx/pptx 的主场）——
  {
    id: 'word',
    label: 'Microsoft Word',
    opens: ['word'],
    darwin: { kind: 'app-bundle', names: ['Microsoft Word.app'] },
  },
  {
    id: 'excel',
    label: 'Microsoft Excel',
    opens: ['sheet'],
    darwin: { kind: 'app-bundle', names: ['Microsoft Excel.app'] },
  },
  {
    id: 'powerpoint',
    label: 'Microsoft PowerPoint',
    opens: ['slides'],
    darwin: { kind: 'app-bundle', names: ['Microsoft PowerPoint.app'] },
  },
  {
    id: 'wps',
    label: 'WPS Office',
    opens: ['word', 'sheet', 'slides'],
    darwin: { kind: 'app-bundle', names: ['WPS Office.app', 'wpsoffice.app'] },
  },
];
