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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';

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

/** 就绪探针：用真实存在的只读端点，而不是"TCP 通了就算"（端口可能被别的进程占着）。 */
async function backendResponds(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/workspace`, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
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
    // 主动退出 / 外部实例都不算崩溃
    if (quitting || !ownsBackend) return;
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
          trafficLightPosition: { x: 16, y: 18 },
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

  void win.loadURL(BACKEND_URL);

  // 外部链接一律交给系统浏览器，别在壳里乱开窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 标题栏藏掉之后，前端侧栏顶部必须给红绿灯让位（它们浮在左上角）。
  // 选择器避开 CSS Modules 的哈希类名，直接认语义标签 aside；侧栏自身是
  // height:100vh + 全局 border-box，加 padding 只压缩内容高度、不会撑出窗口。
  win.webContents.on('did-finish-load', () => {
    win.setTitle('PayasoAgent'); // 兜底：别让页面/宿主改出 "xxx - localhost" 之类的标题
    void win.webContents.insertCSS(
      '#root > :first-child > aside { box-sizing: border-box; padding-top: 40px; }',
    );
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
 * 页面主题模式 → 原生 chrome 外观（渲染进程 → 这里）。
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
function registerNativeTheme(): void {
  ipcMain.on('payaso:nativeThemeSet', (event, source: unknown): void => {
    if (mainWindow === null || event.sender !== mainWindow.webContents) return;
    if (source === 'light' || source === 'dark' || source === 'system') {
      nativeTheme.themeSource = source;
    }
  });
}

async function boot(): Promise<void> {
  buildMenu();
  registerDirectoryPicker();
  registerNativeTheme();
  // 端口已被占用（用户自己起过 npm run host）→ 复用已有后端，退出时也不要杀它
  if (await backendResponds()) {
    ownsBackend = false;
  } else {
    ownsBackend = true;
    await startBackend();
  }
  createWindow();
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
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void stopBackend().finally(() => app.quit());
});
