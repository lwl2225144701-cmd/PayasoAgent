// 模块: 页面主题 → 桌面壳原生 chrome 的单向同步契约。
// 用法: npx tsx tests/frontend-native-theme.test.ts（无浏览器；window/document 打桩）
//
// 背景（真机 bug）：网页皮肤由 CSS 决定，但**系统标题栏 / 菜单栏 / 原生控件**
// 是 Chromium 照 `nativeTheme.themeSource` 画的。壳不设它 → 永远跟系统外观走，
// 于是 Windows 上出现「页面深色 + 标题栏/菜单栏浅色」（真机截图"上面的那一栏
// 是白的"）。DSH 同款配方：渲染进程监听主题属性后发 IPC，主进程写 themeSource。
//
// 契约（三层都要锁）：
//   1. `applyThemeMode` 每次应用主题都把**模式**（不是解析后的值）报给桥 ——
//      报 'system' 才能让 OS 自己决定，报解析值等于把用户的"跟随系统"钉死。
//   2. 浏览器形态（没有 `window.payasoDesktop`）与桥抛异常都不能影响主题应用。
//   3. 壳侧通道名 + 归属校验 + 值域兜底：preload 发的和 main 收的必须是同一个
//      字符串，且 main 只认自己的主窗口。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { applyThemeMode, readThemeMode } from '../web/src/theme';

type ThemeCall = string;

/** 打桩出来的浏览器环境：document + window（matchMedia / localStorage / 能力桥）。 */
function stubBrowser(options: {
  bridge?: ThemeCall[] | 'throw' | 'absent' | 'legacy';
  systemDark?: boolean;
}) {
  const bridgeCalls: ThemeCall[] = [];
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  const themeColorMeta = {
    value: '',
    setAttribute(_name: string, value: string): void {
      themeColorMeta.value = value;
    },
  };

  const bridge =
    options.bridge === 'absent'
      ? undefined
      : options.bridge === 'legacy'
        ? // 老壳：桥里只有 pickDirectory（本次改动之前安装的版本）
          { pickDirectory: async (): Promise<string | null> => null }
        : {
            setNativeTheme: (mode: string, resolved: string): void => {
              if (options.bridge === 'throw') throw new Error('bridge rejected');
              bridgeCalls.push(`${mode}:${resolved}`);
            },
          };

  const documentStub = {
    documentElement: { dataset, style },
    querySelector: (selector: string) =>
      selector === 'meta[name="theme-color"]' ? themeColorMeta : null,
  };
  const localStorageStub = new Map<string, string>();
  const windowStub = {
    matchMedia: () => ({ matches: options.systemDark === true }),
    localStorage: {
      getItem: (key: string) => localStorageStub.get(key) ?? null,
      setItem: (key: string, value: string) => void localStorageStub.set(key, value),
    },
    payasoDesktop: bridge,
  };

  (globalThis as { document?: unknown }).document = documentStub;
  (globalThis as { window?: unknown }).window = windowStub;
  return { bridgeCalls, dataset, style, themeColorMeta };
}

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

test('dark 模式：报给桥的是 dark，且 data-theme / colorScheme 同步', () => {
  const env = stubBrowser({ bridge: [] });
  const resolved = applyThemeMode('dark');
  assert.equal(resolved, 'dark');
  // 报的是「模式:解析值」—— 壳用前者设 themeSource、后者刷窗口按钮叠加层
  assert.deepEqual(env.bridgeCalls, ['dark:dark']);
  assert.equal(env.dataset.theme, 'dark');
  assert.equal(env.dataset.themeMode, 'dark');
  assert.equal(env.style.colorScheme, 'dark');
  assert.equal(env.themeColorMeta.value, '#0f1115');
});

test('light 模式：报给桥的是 light（原生 chrome 要跟着变浅）', () => {
  const env = stubBrowser({ bridge: [] });
  applyThemeMode('light');
  assert.deepEqual(env.bridgeCalls, ['light:light']);
  assert.equal(env.dataset.theme, 'light');
  assert.equal(env.style.colorScheme, 'light');
  assert.equal(env.themeColorMeta.value, '#f5f7fb');
});

test('system 模式：报的是 system 本身 + 解析值，而不是只报解析后的 dark', () => {
  const env = stubBrowser({ bridge: [], systemDark: true });
  applyThemeMode('system');
  assert.deepEqual(env.bridgeCalls, ['system:dark']);
  // 页面按系统解析成 dark，但壳必须收到 system —— OS 才能自己决定原生外观。
  assert.equal(env.dataset.theme, 'dark');
  assert.equal(env.dataset.themeMode, 'system');
});

test('浏览器形态（无桥）不崩，主题照旧应用', () => {
  const env = stubBrowser({ bridge: 'absent' });
  assert.doesNotThrow(() => applyThemeMode('dark'));
  assert.deepEqual(env.bridgeCalls, []);
  assert.equal(env.dataset.theme, 'dark');
});

test('桥抛异常不影响主题应用', () => {
  const env = stubBrowser({ bridge: 'throw' });
  assert.doesNotThrow(() => applyThemeMode('dark'));
  assert.equal(env.dataset.theme, 'dark');
  assert.equal(env.style.colorScheme, 'dark');
});

test('老壳（桥里没有 setNativeTheme）不崩 —— 新网页 + 旧壳也要能用', () => {
  const env = stubBrowser({ bridge: 'legacy' });
  assert.doesNotThrow(() => applyThemeMode('dark'));
  assert.deepEqual(env.bridgeCalls, []);
  assert.equal(env.dataset.theme, 'dark');
});

test('默认主题是 dark（未存过 localStorage 时）', () => {
  stubBrowser({ bridge: [] });
  assert.equal(readThemeMode(), 'dark');
});

test('启动路径 applyThemeMode(readThemeMode()) 也会报一次给桥', () => {
  const env = stubBrowser({ bridge: [] });
  applyThemeMode(readThemeMode());
  assert.deepEqual(env.bridgeCalls, ['dark:dark']);
});

test('壳侧源码契约：preload 发的通道 == main 收的通道，且写进 nativeTheme.themeSource', () => {
  const preload = fs.readFileSync(path.join('apps', 'desktop', 'src', 'preload.cts'), 'utf8');
  const main = fs.readFileSync(path.join('apps', 'desktop', 'src', 'main.ts'), 'utf8');
  const channel = /ipcRenderer\.send\('([^']+)', mode, resolved\)/.exec(preload)?.[1];
  assert.ok(channel, 'preload 必须用 ipcRenderer.send 报主题模式');
  assert.equal(channel, 'payaso:nativeThemeSet');
  assert.ok(
    main.includes(`ipcMain.on('${channel}'`),
    `main.ts 必须监听同一个通道（${channel}）—— 通道名两端不一致就静默失效`,
  );
  assert.ok(
    main.includes('nativeTheme.themeSource = source'),
    'main.ts 必须把收到的模式写进 nativeTheme.themeSource',
  );
  // 归属校验：只认自己的主窗口（别的 webContents 不能改壳的外观）
  assert.ok(
    /event\.sender !== mainWindow\.webContents/.test(main),
    'main.ts 必须校验 event.sender 是主窗口，否则任意渲染进程都能改外观',
  );
  // 值域兜底：非法值不能进 themeSource
  assert.ok(
    /source !== 'light' && source !== 'dark' && source !== 'system'\) return;/.test(main),
    'main.ts 必须丢掉非法模式值',
  );
  // 解析值也要兜底（叠加层颜色按它刷）
  assert.ok(/resolved === 'light' \|\| resolved === 'dark' \? resolved : null/.test(main));
});

test('壳自己盯页面主题（页面版本不匹配时也能自愈）', () => {
  const main = fs.readFileSync(path.join('apps', 'desktop', 'src', 'main.ts'), 'utf8');
  assert.ok(/const THEME_WATCH_SCRIPT = /.test(main), '壳必须内置页面主题观察脚本');
  assert.ok(
    /attributeFilter: \['data-theme', 'data-theme-mode'\]/.test(main),
    '观察 data-theme/data-theme-mode',
  );
  assert.ok(
    /did-finish-load[\s\S]{0,400}executeJavaScript\(THEME_WATCH_SCRIPT/.test(main),
    '页面加载完就要注入观察脚本 —— 旧页面不会主动上报，只能壳自己去看',
  );
});

test('壳注入的观察脚本：只认页面的 data-theme，属性一变就重报', () => {
  const main = fs.readFileSync(path.join('apps', 'desktop', 'src', 'main.ts'), 'utf8');
  const script = /const THEME_WATCH_SCRIPT = `([\s\S]*?)`;/.exec(main)?.[1];
  assert.ok(script, '要能取到注入脚本本体');

  const calls: string[] = [];
  // 用对象持有回调：TS 看不到 class 构造函数里的赋值，直接 let 会被窄化成 null
  const observer = { fire: null as (() => void) | null };
  class FakeObserver {
    constructor(cb: () => void) {
      observer.fire = cb;
    }
    observe(): void {
      /* 不关心观察参数，触发由测试手动调 */
    }
  }
  const root = { dataset: {} as Record<string, string> };
  const win = {
    payasoDesktop: {
      setNativeTheme: (mode: string, resolved: string) => calls.push(`${mode}:${resolved}`),
    },
  };
  const doc = { documentElement: root };
  new Function('window', 'document', 'MutationObserver', script)(win, doc, FakeObserver);

  // 装上去时页面还没写 data-theme → 不许瞎报
  assert.deepEqual(calls, []);

  // 页面自己应用主题（旧页面也一样会写这两个属性）→ 壳听到
  root.dataset.theme = 'dark';
  root.dataset.themeMode = 'dark';
  observer.fire?.();
  assert.deepEqual(calls, ['dark:dark']);

  // 只有 data-theme 变了（例如跟随系统时系统切浅色）→ 也要重报
  root.dataset.theme = 'light';
  observer.fire?.();
  assert.deepEqual(calls, ['dark:dark', 'dark:light']);
});

test('界面资源版本不一致要喊出来（复用旧后端 = 新壳配旧页面）', () => {
  const main = fs.readFileSync(path.join('apps', 'desktop', 'src', 'main.ts'), 'utf8');
  assert.ok(/function pageAssetNames\(/.test(main), '必须能提取资源指纹');
  assert.ok(
    /function warnIfBackendMismatch\(/.test(main),
    '必须校验 4500 上那份界面的资源指纹（backendResponds 只看通不通，不看版本）',
  );
  assert.ok(/web', 'dist', 'index\.html'/.test(main), '要跟壳自带的 web/dist/index.html 比');
  assert.ok(/showMessageBox\(win, \{/.test(main), '不一致要弹窗说明，不能静默');
  assert.ok(
    /did-finish-load[\s\S]{0,500}warnIfBackendMismatch\(win\)/.test(main),
    '启动时就要检查',
  );
});

test('桥的类型声明在 vite-env.d.ts 里（tsc 才认 window.payasoDesktop.setNativeTheme）', () => {
  const dts = fs.readFileSync(path.join('web', 'src', 'vite-env.d.ts'), 'utf8');
  assert.ok(
    /setNativeTheme: \(mode: 'light' \| 'dark' \| 'system', resolved: 'light' \| 'dark'\) => void;/.test(
      dts,
    ),
    '桥要声明「模式 + 解析值」两个参数',
  );
});

test('Windows 壳源码契约：没有系统标题栏，窗口按钮叠加层跟随主题', () => {
  const main = fs.readFileSync(path.join('apps', 'desktop', 'src', 'main.ts'), 'utf8');
  // 系统 caption/菜单栏是 DWM + GetSysColor 画的，改不了颜色 → 只能不要它们
  assert.ok(
    /process\.platform === 'win32'[\s\S]{0,400}titleBarStyle: 'hidden' as const/.test(main),
    'win32 必须用 titleBarStyle:hidden（系统标题栏没有主题开关）',
  );
  assert.ok(
    /titleBarOverlay: \{/.test(main),
    'win32 必须开窗口按钮叠加层，否则没有最小化/关闭按钮',
  );
  assert.ok(
    /function refreshWindowsChrome\(\)[\s\S]{0,400}setTitleBarOverlay/.test(main),
    '主题切换后必须重刷叠加层颜色，否则按钮那一块留着上一套主题',
  );
  assert.ok(
    /nativeTheme\.themeSource = source;[\s\S]{0,160}refreshWindowsChrome\(\)/.test(main),
    'themeSource 与叠加层颜色必须一起刷（一套真值源）',
  );
  assert.ok(
    /process\.platform === 'win32'\) win\.setAutoHideMenuBar\(true\)/.test(main),
    'win32 必须收起系统菜单栏（它也是 GetSysColor 画的浅色带）',
  );
  // 顶栏高度必须与前端 --topbar-height 一致，否则按钮叠不到顶栏里
  const css = fs.readFileSync(path.join('web', 'src', 'index.css'), 'utf8');
  const topbar = Number(/--topbar-height:\s*(\d+)px/.exec(css)?.[1]);
  const chromeHeight = Number(/WINDOW_CHROME_HEIGHT = (\d+)/.exec(main)?.[1]);
  assert.equal(
    chromeHeight,
    topbar,
    `WINDOW_CHROME_HEIGHT(${chromeHeight}) 必须等于 --topbar-height(${topbar})`,
  );
});

test('窗口按钮让位由壳注入（页面版本不匹配也不会被压住）', () => {
  const main = fs.readFileSync(path.join('apps', 'desktop', 'src', 'main.ts'), 'utf8');
  // 宽度：WCO API 量，量不到兜底 138px（46×3）
  assert.ok(/const WCO_RESERVE_SCRIPT = /.test(main), '壳必须内置 WCO 量宽脚本');
  assert.ok(
    /getTitlebarAreaRect[\s\S]{0,200}Math\.max\(138,/.test(main),
    '必须用 getTitlebarAreaRect 量出按钮区宽度，并有 138px 兜底',
  );
  assert.ok(/--wco-reserve/.test(main), '量出来的宽度要落到 CSS 变量上');
  // 选择器：认顶栏的 data-window-drag，且排除侧栏（aside 里也有一个同名标记）
  assert.ok(
    /#root > :first-child > :not\(aside\) > \[data-window-drag\] \{[\s\S]{0,160}var\(--wco-reserve, 138px\)/.test(
      main,
    ),
    '注入的 CSS 必须只命中主栏顶栏，并用 var(--wco-reserve, 138px) 兜底',
  );
  assert.ok(
    /process\.platform === 'win32'[\s\S]{0,300}insertCSS\(WCO_RESERVE_CSS\)/.test(main),
    'win32 才注入让位 CSS',
  );
  // 页面侧不该再有第二份让位逻辑（一套真值源：壳的窗口几何归壳）
  const shellCss = fs.readFileSync(
    path.join('web', 'src', 'components', 'ShellBar', 'ShellBar.module.css'),
    'utf8',
  );
  assert.ok(!/titlebar-area/.test(shellCss), '页面 CSS 不该再留一份让位规则');
  const mainTsx = fs.readFileSync(path.join('web', 'src', 'main.tsx'), 'utf8');
  assert.ok(!/shellPlatform/.test(mainTsx), '页面不该再依赖 data-shell-platform');
});

// ── 窗口左上角：红绿灯那一行放折叠按钮，品牌行在它下面（v0.4.15）─────────────
//
// 真机反馈：用户发 DSH 的参考图 —— 红绿灯那一行只有折叠/展开按钮，品牌
// （🦌 Payaso）在红绿灯**下面**一行。红绿灯是 macOS 画的、不占布局，所以壳必须把
// 那几行的高度/基线注入给页面，页面 CSS 只读 var（浏览器形态回落到无红绿灯的默认值）。

test('壳：macOS 注入 chrome 行高 / 折叠按钮基线', () => {
  const main = fs.readFileSync(path.join('apps', 'desktop', 'src', 'main.ts'), 'utf8');
  assert.ok(/--sidebar-chrome-height: 58px/.test(main), '要注入红绿灯那一行的高度');
  assert.ok(
    /\[data-sidebar-toggle\] \{ top: 10px; \}/.test(main),
    '展开态折叠按钮要跟红绿灯同一基线（红绿灯中心 y=24 - 按钮半高 14 = 10）',
  );
  assert.ok(
    !/aside \{ box-sizing: border-box; padding-top: 40px; \}/.test(main),
    '旧的整条 padding-top 让位不能再出现',
  );
});

test('页面：品牌行在 chrome 行下面；收起后只剩展开按钮', () => {
  const css = fs.readFileSync(
    path.join('web', 'src', 'components', 'Sidebar', 'Sidebar.module.css'),
    'utf8',
  );
  assert.ok(
    /padding-top: var\(--sidebar-chrome-height, 0px\)/.test(css),
    '品牌行靠 chrome 行高下移（浏览器里 0 → 贴顶）',
  );
  assert.ok(
    /width: var\(--sidebar-collapsed-width, 64px\)/.test(css),
    '收起宽度回退 64px（真·收起：只剩左上角控件）',
  );
  assert.ok(/\.collapsed \.brandRow \{\s*display: none;/.test(css), '收起后品牌行隐藏');
  // 真机反馈：「收起来的时候，这个分割线可以去掉吗」+「真的收起来的感觉」：
  // 窄栏不能像一块面板 —— 背景/分割线/高光全去掉，跟主内容连成一片。
  assert.ok(/\.collapsed \{[^}]*background: none;/.test(css), '收起后不再有面板底色');
  assert.ok(/\.collapsed \{[^}]*border-right-color: transparent;/.test(css), '收起后不画右分割线');
  assert.ok(/\.collapsed \{[^}]*box-shadow: none;/.test(css), '收起后去掉 inset 高光内线');
  // 收起后按钮排到红绿灯下面（红绿灯占 16..68，窄栏 64 放不下同一行）
  assert.ok(
    /\.collapsed \.collapseBtn \{[^}]*top: calc\(var\(--sidebar-chrome-height, 0px\) \+ 10px\)/.test(
      css,
    ),
    '收起后展开按钮排在红绿灯下面',
  );
  const jsx = fs.readFileSync(
    path.join('web', 'src', 'components', 'Sidebar', 'index.tsx'),
    'utf8',
  );
  assert.ok(/data-sidebar-toggle/.test(jsx), '折叠按钮要带稳定 data 属性（壳靠它定位）');
  assert.ok(/styles\.brandRow/.test(jsx), '品牌行必须在（红绿灯下面）');
});

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${(err as Error).message}`);
      failed++;
    }
  }
  console.log(`\nfrontend-native-theme 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

void main();
