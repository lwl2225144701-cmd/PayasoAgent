// 模块: 桌面壳主进程 —— 只负责「起后端 / 等就绪 / 开窗口 / 干净退场」四件事
//
// 设计铁律：**壳不做业务**。一切交互都走 http://127.0.0.1:4500，与浏览器 / PWA 是
// 同一套代码。这样壳出问题时，用浏览器打开同一个地址就能继续用，不用回头查壳。
//
// 后端跑在「自带的官方 Node」里（A1，见 docs/plans/desktop-client-electron-plan.md）：
// Electron 自身的 Node 与官方 Node ABI 不同，原生模块（sharp / canvas / koffi）要按
// Electron 重编；带一份官方 node 二进制则与今天运行环境完全一致，风险为零。
//
// 打包后的目录布局（electron-builder.yml 的 extraResources 决定）：
//   Contents/Resources/app/          后端整体（dist/ + web/dist/ + node_modules/）
//   Contents/Resources/runtime/bin/node   自带 Node
//   Contents/Resources/app.asar      壳自己的编译产物（本文件）
//
// 关键约束：后端从 process.cwd() 下找 web/dist（见 src/host/routes.ts 的 STATIC_ROOT），
// 所以 cwd 必须是「app 根」（含 web/dist 的那层），不能随便选。

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { createUpdateCoordinator, type UpdateCoordinator } from './update/coordinator.js';
import { IDLE_UPDATE_STATUS, type UpdateStatus } from './update/status.js';
import { activeTasks } from './update/tasks.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 打包后 = Resources/app；开发时 = 仓库根（apps/desktop/dist 的上三级）。 */
const appRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.resolve(here, '..', '..', '..');

/** 后端可执行入口（编译产物，不跑 tsx 源码——否则两条构建链互相打架）。 */
const backendEntry = path.join(appRoot, 'dist', 'host', 'index.js');

/**
 * 后端进程的启动方式。优先 **A1**（自带的官方 Node）；万一打包时漏了这份运行时，
 * 退回 **A2**（让 Electron 自身跑 Node 模式）—— 实测 Electron 44 的 Node 24.21.0
 * 带 `node:sqlite`，且 sharp / canvas 这些 Node-API 模块**无需重编**即可载入。
 * 宁可降级也不能让「装完点不开」。
 */
const backendCommand = (() => {
  if (!app.isPackaged) return { command: process.env.PAYASO_NODE_BIN ?? 'node', env: {} };
  const bundled = path.join(
    process.resourcesPath,
    'runtime',
    'bin',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  if (existsSync(bundled)) return { command: bundled, env: {} };
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
})();

const PORT = Number(process.env.PORT ?? 4500);
const BACKEND_URL = `http://127.0.0.1:${PORT}`;

const READY_TIMEOUT_MS = 30_000;
const SIGTERM_GRACE_MS = 10_000;
const SIGKILL_GRACE_MS = 5_000;
const STDERR_TAIL_BYTES = 65_536;

let backend: ChildProcess | null = null;
/** 后端是不是我们起的：外部已有实例时不要在退出时杀掉别人的进程。 */
let ownsBackend = false;
/** 主窗口引用：原生对话框要拿它当父窗口（有归属才不会跑到窗口后面去）。 */
let mainWindow: BrowserWindow | null = null;
let stderrTail = '';
let quitting = false;
/**
 * 是不是我们自己发起的关停（退出或"装更新前优雅停后端"）。
 *
 * 真事故（v0.4.11 → v0.4.12，用户截图）：点「下载 → 安装」后，安装交接会先
 * `stopBackend()`（后端收到 SIGTERM 优雅退出 → code=0 signal=null），而旧代码的
 * exit 处理器只看 `quitting` / `ownsBackend` —— 安装时 `quitting` 还是 false，
 * 于是把这次**主动关停**当成崩溃，弹「PayasoAgent 后端意外退出」再 app.quit()。
 */
let stoppingIntentionally = false;
/** 自更新协调器（开发版不启用；门禁见 update/coordinator.ts）。 */
let updates: UpdateCoordinator | null = null;
/**
 * 最近一次的更新状态：页面重新加载后要补发（did-finish-load 时 send 一次），
 * 否则刷新一次页面侧边栏条目就消失了。
 */
let lastUpdateStatus: UpdateStatus = IDLE_UPDATE_STATUS;

/** 就绪探针：用真实存在的只读端点，而不是"TCP 通了就算"（端口可能被别的进程占着）。 */
async function backendResponds(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/workspace`, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 查"有没有在跑的任务"（装更新前必须问清楚）。
 *
 * 复用现成端点：`GET /runs`（不鉴权、不查 origin，见 routes/runs-handler.ts）→
 * 过滤 running/stopping（`update/tasks.ts`，与 Host 的 `isCancellable()` 对齐）。
 * 后端零改动。
 */
async function listActiveTasks(): Promise<{ runId: string; task: string }[]> {
  const res = await fetch(`${BACKEND_URL}/runs`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`GET /runs 返回 ${res.status}`);
  return activeTasks(await res.json());
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await backendResponds()) return;
    if (Date.now() > deadline) {
      throw new Error(
        `后端 ${READY_TIMEOUT_MS}ms 内未就绪（${BACKEND_URL}）。\n\n最近的后端日志：\n${stderrTail.slice(-4_000)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function startBackend(): Promise<void> {
  if (!existsSync(backendEntry)) {
    throw new Error(`后端编译产物不存在：${backendEntry}\n请先执行 npm run build:server`);
  }
  // 新进程：上一轮的"主动关停"标记作废，之后的异常退出照常要报
  stoppingIntentionally = false;
  backend = spawn(backendCommand.command, [backendEntry], {
    cwd: appRoot,
    env: { ...process.env, ...backendCommand.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  backend.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });

  backend.on('exit', (code, signal) => {
    backend = null;
    // 主动退出 / 外部实例 / 我们自己发起的关停（退出或装更新前的优雅停）都不算崩溃
    if (quitting || stoppingIntentionally || !ownsBackend) return;
    dialog.showErrorBox(
      'PayasoAgent 后端意外退出',
      `code=${code} signal=${signal}\n\n最近的后端日志：\n${stderrTail.slice(-4_000)}`,
    );
    app.quit();
  });

  await waitForReady();
}

/**
 * 分级关停：先礼后兵。只 child.kill() 会留下孤儿孙进程（后端还会 spawn 用户项目的
 * shell 工具），所以 SIGTERM 宽限 → SIGKILL → 仍未死就报错（DSH 同款做法）。
 */
async function stopBackend(): Promise<void> {
  const child = backend;
  if (!child || !ownsBackend) return;
  // 这次退出是我们自己发起的：exit 处理器别弹「后端意外退出」
  stoppingIntentionally = true;
  backend = null;
  if (child.exitCode !== null || child.signalCode !== null) return; // 已经退了

  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const settlesWithin = (ms: number) =>
    Promise.race([
      done.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
    ]);

  if (process.platform === 'win32') {
    // Windows 没有信号语义：child.kill() 即 TerminateProcess，只掐直接进程、
    // 留孙进程（后端会 spawn 用户项目的 shell 工具）。用 taskkill /T 树杀，
    // 连子孙一起收 —— 等价于 POSIX 的 SIGTERM→SIGKILL 兜底（代价是没有优雅
    // 排水窗口，靠后端 SQLite WAL 抗崩溃截断，见实施手账 §10）。
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 进程可能已自行退出（taskkill 对不存在的 PID 返回非 0）
    }
    if (!(await settlesWithin(SIGKILL_GRACE_MS))) {
      throw new Error('后端进程树在 taskkill /T 之后仍未退出，可能留下僵尸进程');
    }
    return;
  }

  child.kill('SIGTERM');
  if (!(await settlesWithin(SIGTERM_GRACE_MS))) child.kill('SIGKILL');
  if (!(await settlesWithin(SIGKILL_GRACE_MS))) {
    throw new Error('后端进程在 SIGKILL 之后仍未退出，可能留下僵尸进程');
  }
}

/**
 * 顶部条高度（px），必须与前端 `--topbar-height` 一致（web/src/index.css）。
 * Windows 上它是窗口按钮叠加层（WCO）的高度，按钮就叠在顶栏这一条里。
 */
const WINDOW_CHROME_HEIGHT = 58;

/**
 * Windows：给窗口按钮让位的注入脚本 —— 用 WCO API 量出按钮区宽度写进
 * `--wco-reserve`（量不到就用 138px 兜底：三个标题栏按钮 × 46 DIP）。
 */
const WCO_RESERVE_SCRIPT = `(() => {
  let reserve = 138;
  try {
    const rect = navigator.windowControlsOverlay?.getTitlebarAreaRect?.();
    if (rect && rect.width > 0) reserve = Math.max(138, window.innerWidth - rect.x - rect.width);
  } catch {}
  document.documentElement.style.setProperty('--wco-reserve', reserve + 'px');
})();`;

/**
 * Windows：顶栏（`[data-window-drag]`，侧栏那个在 aside 里不会命中）右侧留出
 * 窗口按钮的宽度。由壳注入而不是页面 CSS —— 见 createWindow 里的注释。
 */
const WCO_RESERVE_CSS = `
  #root > :first-child > :not(aside) > [data-window-drag] {
    box-sizing: border-box;
    padding-right: calc(var(--wco-reserve, 138px) + 14px);
  }
`;

/**
 * 顶栏 / 窗口按钮的配色 —— 只认「设置里的主题」（页面报来的解析值），
 * 不认系统外观：一张皮，两处都刷它。
 */
function windowChromePalette(useDarkColors: boolean): { color: string; symbolColor: string } {
  return useDarkColors
    ? { color: '#0f1115', symbolColor: '#e6e8ec' } // 同前端深色底 / 浅色符号
    : { color: '#f5f7fb', symbolColor: '#0f1115' };
}

/** 最近一次从页面收到的主题（模式 + 解析值）。null = 还没收到过（用系统色兜底）。 */
let appliedThemeMode: 'light' | 'dark' | 'system' | null = null;
let appliedTheme: 'light' | 'dark' | null = null;

/**
 * Windows：把窗口按钮叠加层的颜色刷成当前主题色（DSH 同款 `setTitleBarOverlay`）。
 * 主题切换后必须再刷一次，否则按钮那一小块会留着上一套主题的颜色。
 */
function refreshWindowsChrome(): void {
  if (process.platform !== 'win32' || mainWindow === null) return;
  const dark = appliedTheme === null ? nativeTheme.shouldUseDarkColors : appliedTheme === 'dark';
  mainWindow.setTitleBarOverlay(windowChromePalette(dark));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'PayasoAgent',
    backgroundColor: '#0f1115', // 与前端深色主题一致，避免首帧白闪
    // macOS：无标题栏 + 红绿灯内嵌（与 DeepSeek Harness 同款，位置也是抄它的）。
    // hiddenInset 让内容顶到窗口上沿。**拖拽面由前端 data-window-drag 显式声明**
    // （DSH 同款配方，见 web/src/index.css）——实测系统拖拽带拖不动窗口（坑 11），
    // 这里原来的"不需要自己画拖拽条"是错的。
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          // 红绿灯**竖直位置按顶栏内容中线对齐**（真机反馈：从绿色圆圈中间画一条线
          // 过去，要刚好平分右上角那些按钮）：顶栏 58 高、内容居中 → 中线 y=29；
          // 按钮 12px → y = 29 - 6 = 23。
          trafficLightPosition: { x: 16, y: 23 },
        }
      : {}),
    // Windows：不要系统标题栏 —— 它的颜色是 DWM 画的，应用侧**没有开关**
    // （Chromium 只在带 DWM backdrop 的窗口上才设 DWMWA_USE_IMMERSIVE_DARK_MODE，
    // Electron 只在 SetBackgroundMaterial 里碰 DWMWA_CAPTION_COLOR），所以深色
    // 主题下永远是浅色一条。改成 Electron 的窗口按钮叠加层（WCO）：按钮叠在
    // 我们自己的顶栏里，颜色由上面那套 palette 决定 —— DSH 就是这么做 Windows 的
    // （`titleBarStyle:"hidden"` + `titleBarOverlay` + `windowsAppearance` IPC）。
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            height: WINDOW_CHROME_HEIGHT,
            ...windowChromePalette(nativeTheme.shouldUseDarkColors),
          },
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false, // 页面只是普通 Web 页面（同源 localhost），不需要 Node 能力
      // 唯一的能力桥：选目录（原生对话框）。编译产物是 preload.cjs（CommonJS），
      // 因为 sandbox 化的 preload 不能是 ESM，而本包是 "type": "module"。
      preload: path.join(here, 'preload.cjs'),
    },
  });

  mainWindow = win;

  // Windows：系统菜单栏的颜色也是 GetSysColor 画的（跟系统走），深色主题下还是
  // 一条白带 —— 收起来（Alt 仍能调出，快捷键不受影响），标题栏里不放第二套 chrome。
  if (process.platform === 'win32') win.setAutoHideMenuBar(true);

  void win.loadURL(BACKEND_URL);

  // 外部链接一律交给系统浏览器，别在壳里乱开窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Windows：窗口按钮（WCO 叠加层）叠在页面右上角，顶栏必须给它让位 —— 这是
  // **壳的窗口几何**，跟 macOS 红绿灯那条同理，所以由壳注入，不靠页面 CSS：
  // 页面版本一旦和壳不匹配（旧 web/dist），页面里那条规则就没了，胶囊/图标会被
  // 按钮硬切掉（真机截图："运行中被挡住了"）。
  // 选择器认 `[data-window-drag]`（顶栏的稳定标记；侧栏那个同类标记在 aside 里，
  // 不会误伤），宽度由注入脚本用 WCO API 算出来，算不出来兜底 138px（46×3）。
  if (process.platform === 'win32') {
    win.webContents.on('dom-ready', () => {
      void win.webContents.insertCSS(WCO_RESERVE_CSS).catch(() => undefined);
      void win.webContents.executeJavaScript(WCO_RESERVE_SCRIPT, true).catch(() => undefined);
    });
  }

  // macOS 专属：红绿灯浮在窗口左上角、**不占布局**，参考 DSH 的排法（用户给的
  // 参考图）：红绿灯那一行只放折叠按钮，品牌行在它下面。壳把三件事注入给页面：
  //   --sidebar-chrome-height    红绿灯那一行的高度（品牌行据此下移）
  //   --sidebar-lights-inset     收起态顶栏左侧给红绿灯让位的宽度（16..68 + 4px）
  //   [data-sidebar-toggle]      折叠按钮的 top（跟红绿灯同一基线）
  // 页面 CSS 全部走 var(--x, 默认值)：浏览器里没有注入 → 无红绿灯形态；
  // 选择器用 data 属性，避开 CSS Modules 哈希类名。
  if (process.platform === 'darwin') {
    win.webContents.on('did-finish-load', () => {
      win.setTitle('PayasoAgent'); // 兜底：别让页面/宿主改出 "xxx - localhost" 之类的标题
      // 数值来历（别乱改）：
      // - trafficLightPosition = {x:16,y:23} → 红绿灯中心 y = 29 = 顶栏内容中线（58/2），
      //   「从绿点中心画一条线」正好平分右上角按钮；
      // - 展开态折叠按钮（侧栏里）left/top 由页面给，这里只纠正 top=15（29-14）；
      // - 收起态侧栏宽 0、顶栏横跨整窗：--sidebar-lights-inset 是顶栏左侧要给红绿灯
      //   让开的宽度（红绿灯 16..68 + 4px），页面据此算 padding-left。
      // !important 不能省：insertCSS 注入的样式表排在页面样式表**前面**时，同特异度的
      // `[data-sidebar-toggle]` 会输给页面里的 `.collapseBtn{top:10px}`（真机实测：
      // 按钮比红绿灯中线高 5px）。壳的窗口几何必须赢，所以这里显式加权。
      void win.webContents.insertCSS(
        ':root { --sidebar-chrome-height: 58px; --sidebar-lights-inset: 72px; } [data-sidebar-toggle] { top: 15px !important; }',
      );
    });
  } else {
    win.webContents.on('did-finish-load', () => {
      win.setTitle('PayasoAgent');
    });
  }

  // 页面加载完就把两件事做掉：
  //   1. 壳自己盯页面主题（兜底观察者）—— 页面就算是不匹配的旧构建，原生 chrome
  //      也不会停在"系统色"上；
  //   2. 对一下界面资源版本，不一致就说出来（静默拼出新壳 + 旧界面最难查）。
  win.webContents.on('did-finish-load', () => {
    void win.webContents.executeJavaScript(THEME_WATCH_SCRIPT, true).catch(() => undefined);
    void warnIfBackendMismatch(win);
    // 页面刷新后补发：侧边栏的更新条目不能因为刷新就丢了
    win.webContents.send('payaso:updateStatus', lastUpdateStatus);
  });

  win.on('closed', () => {
    if (!quitting) app.quit();
  });
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          // 手动检查更新（DSH 同款菜单位置）。自动检查在启动/focus/唤醒时跑，
          // 这一项是"我不放心，现在就看"的出口；开发版点了会明确说"当前构建不检查更新"。
          {
            label: '检查更新…',
            click: () => void updates?.checkInteractively(),
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: '视图',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }],
      },
      { role: 'windowMenu' },
    ]),
  );
}

/**
 * 原生目录选择（渲染进程 → 这里）。这是「打开工作区」在 mac / Windows 上
 * 都要**快**且**不被遮挡**的解法：
 *
 * - **进程内**：`dialog.showOpenDialog` 是已加载进程里的原生调用，不 spawn 子进程。
 *   旧实现 win32 走 PowerShell 5.1（`powershell.exe` 冷启动 + `Add-Type` 加载
 *   WinForms 程序集，通常 1.5~4 秒），darwin 走 osascript（实测 40~100ms 进程开销），
 *   真机反馈"windows 打开原生目录很慢"就是这么来的。
 * - **有归属**：传 parent 窗口，macOS 挂成窗口 sheet、Windows 是正确模态，
 *   不会像 shell 出去那样跑到应用窗口后面。
 * - **不设文案**：不传 title / buttonLabel —— 两个平台的原生默认就是要的样子
 *   （macOS 原生面板 + New Folder；Windows 中文系统自带的"选择文件夹"）。
 *   也不传 defaultPath：Electron 默认就落在用户 Downloads 目录。
 * - properties 只开 openDirectory；createDirectory 是给 macOS 的"新建文件夹"
 *   （Windows 的现代对话框自带"新建文件夹"，会忽略该属性）。
 */
function registerDirectoryPicker(): void {
  ipcMain.handle('payaso:pickDirectory', async (): Promise<string | null> => {
    const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });
}

/**
 * 页面主题状态 → 原生 chrome 外观（渲染进程 → 这里）。
 *
 * 网页只有一套皮肤由 CSS 决定，但**系统标题栏 / 菜单栏 / 原生控件/滚动条**
 * 是 Chromium 照 `nativeTheme.themeSource` 画的：不设它，就永远跟**系统**
 * 外观走 —— 页面深色 + 浅色窗口边框（真机截图里就是"上面的那一栏是白的"）。
 *
 * DSH 同款开关：它的渲染进程监听 `data-theme-source` 后发
 * `dsh-desktop:native-theme-set`，主进程收下写进 `nativeTheme.themeSource`。
 * 我们照抄这个单向同步，只认自己的主窗口（同 `registerDirectoryPicker`
 * 的归属校验），值域兜底，非法值直接丢。
 */
/**
 * 把更新状态推给页面（侧边栏「设置」上方的条目）。
 * 页面还没加载好时只记账，`did-finish-load` 会把最后一条补发过去。
 */
function pushUpdateStatus(status: UpdateStatus): void {
  lastUpdateStatus = status;
  const win = mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send('payaso:updateStatus', status);
}

/**
 * 页面 → 壳：侧边栏「新版本」条目被点了 → 开始下载。
 * 发送者校验与原生主题那条同款：只认主窗口，不给别的 webContents 开闸。
 * 下载完成后的安装确认仍然走原生对话框（含"有任务在跑"的检查）。
 */
function registerUpdateBridge(): void {
  ipcMain.on('payaso:updateDownload', (event): void => {
    if (mainWindow === null || event.sender !== mainWindow.webContents) return;
    void updates?.downloadNow();
  });
}

function registerNativeTheme(): void {
  ipcMain.on('payaso:nativeThemeSet', (event, source: unknown, resolved: unknown): void => {
    if (mainWindow === null || event.sender !== mainWindow.webContents) return;
    if (source !== 'light' && source !== 'dark' && source !== 'system') return;
    const nextResolved = resolved === 'light' || resolved === 'dark' ? resolved : null;
    if (source === appliedThemeMode && nextResolved === appliedTheme) return; // 去重：页面与壳的观察者都会报
    appliedThemeMode = source;
    appliedTheme = nextResolved;
    nativeTheme.themeSource = source;
    refreshWindowsChrome();
  });
}

/**
 * 壳侧的兜底观察者：直接读页面自己的 `data-theme` / `data-theme-mode`。
 *
 * 为什么不能只靠页面主动上报：**壳与页面可能不是同一次构建**（4500 端口上被
 * 复用的后端带着旧 `web/dist`，壳却把新窗口 chrome 装上去了）—— 旧页面里没有
 * 上报代码，窗口按钮叠加层就会一直停在创建时那套（系统色）颜色，右上角一块白。
 * 页面主题才是唯一真值源，壳自己去看，就不受页面版本影响。
 */
const THEME_WATCH_SCRIPT = `(() => {
  const root = document.documentElement;
  const send = () => {
    const resolved = root.dataset.theme;
    if (resolved !== 'light' && resolved !== 'dark') return;
    const mode = root.dataset.themeMode;
    window.payasoDesktop?.setNativeTheme?.(
      mode === 'light' || mode === 'dark' || mode === 'system' ? mode : resolved,
      resolved,
    );
  };
  new MutationObserver(send).observe(root, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-theme-mode'],
  });
  send();
})();`;

/**
 * 页面资源是不是**本次构建自带的那一份**。
 *
 * 壳复用 4500 上已有后端时（`backendResponds()` 只看通不通，不看版本），可能
 * 拿到别人/旧版构建吐的页面：界面缺功能、样式错位，而且完全没有报错。用页面
 * 引用的哈希资源名跟壳自带 `web/dist/index.html` 对一下，不一致就明确告诉用户。
 */
function pageAssetNames(html: string): string {
  return (html.match(/assets\/[\w.-]+\.(?:js|css)/g) ?? []).sort().join(',');
}

async function warnIfBackendMismatch(win: BrowserWindow): Promise<void> {
  try {
    const ownIndex = path.join(appRoot, 'web', 'dist', 'index.html');
    if (!existsSync(ownIndex)) return;
    const res = await fetch(`${BACKEND_URL}/`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return;
    const served = pageAssetNames(await res.text());
    const own = pageAssetNames(readFileSync(ownIndex, 'utf8'));
    if (served === '' || own === '' || served === own) return;
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'PayasoAgent 界面资源不匹配',
      message: `4500 端口上运行的后端不是客户端自带的这一份（界面资源版本不一致）。`,
      detail:
        `当前界面可能缺功能或样式错位（例如顶栏窗口按钮压住页面元素）。\n\n` +
        `多半是另一个版本的 PayasoAgent 后端还开着（例如之前手动跑过的 npm run host）。` +
        `关掉它再重启客户端即可。`,
      buttons: ['继续', '退出'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice.response === 1) app.quit();
  } catch {
    // 探测失败不影响启动（离线/端口被别的软件占着等），只是不提示。
  }
}

async function boot(): Promise<void> {
  buildMenu();
  registerDirectoryPicker();
  registerUpdateBridge();
  registerNativeTheme();
  // 端口已被占用（用户自己起过 npm run host）→ 复用已有后端，退出时也不要杀它
  if (await backendResponds()) {
    ownsBackend = false;
  } else {
    ownsBackend = true;
    await startBackend();
  }
  createWindow();

  // 自更新：启动自动检查 + 定时轮询（窗口 focus / 睡眠唤醒补查在 startAutoCheck 里接）。
  // 开发版门禁在 coordinator 内部（app.isPackaged && app-update.yml 存在），
  // 所以这里无条件创建也没关系 —— 未启用时它只记一行日志。
  updates = createUpdateCoordinator({
    currentVersion: app.getVersion(),
    window: () => mainWindow,
    onStatus: pushUpdateStatus,
    backend: {
      listActiveTasks,
      stop: stopBackend,
      start: startBackend,
    },
  });
  updates.startAutoCheck();
}

// 单实例：第二次双击只负责把已有窗口拉到前面
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      void boot();
    }
  });

  app
    .whenReady()
    .then(boot)
    .catch((error: unknown) => {
      dialog.showErrorBox(
        'PayasoAgent 启动失败',
        error instanceof Error ? error.message : String(error),
      );
      app.quit();
    });
}

app.on('before-quit', (event) => {
  // 已经没有后端子进程（安装更新前已经优雅停过，或复用了外部后端）→ 直接放手。
  // electron-updater 的 quitAndInstall 也走这条退出路径，别再 preventDefault 拖住它，
  // 否则 Squirrel/NSIS 的替换时机可能被推迟。
  if (quitting || backend === null) return;
  event.preventDefault();
  quitting = true;
  void stopBackend().finally(() => app.quit());
});
