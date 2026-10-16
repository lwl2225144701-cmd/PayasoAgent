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
            setNativeTheme: (mode: string): void => {
              if (options.bridge === 'throw') throw new Error('bridge rejected');
              bridgeCalls.push(mode);
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
  assert.deepEqual(env.bridgeCalls, ['dark']);
  assert.equal(env.dataset.theme, 'dark');
  assert.equal(env.dataset.themeMode, 'dark');
  assert.equal(env.style.colorScheme, 'dark');
  assert.equal(env.themeColorMeta.value, '#0f1115');
});

test('light 模式：报给桥的是 light（原生 chrome 要跟着变浅）', () => {
  const env = stubBrowser({ bridge: [] });
  applyThemeMode('light');
  assert.deepEqual(env.bridgeCalls, ['light']);
  assert.equal(env.dataset.theme, 'light');
  assert.equal(env.style.colorScheme, 'light');
  assert.equal(env.themeColorMeta.value, '#f5f7fb');
});

test('system 模式：报的是 system 本身，而不是解析后的 dark', () => {
  const env = stubBrowser({ bridge: [], systemDark: true });
  applyThemeMode('system');
  assert.deepEqual(env.bridgeCalls, ['system']);
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
  assert.deepEqual(env.bridgeCalls, ['dark']);
});

test('壳侧源码契约：preload 发的通道 == main 收的通道，且写进 nativeTheme.themeSource', () => {
  const preload = fs.readFileSync(path.join('apps', 'desktop', 'src', 'preload.cts'), 'utf8');
  const main = fs.readFileSync(path.join('apps', 'desktop', 'src', 'main.ts'), 'utf8');
  const channel = /ipcRenderer\.send\('([^']+)', mode\)/.exec(preload)?.[1];
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
  assert.ok(/source === 'light' \|\| source === 'dark' \|\| source === 'system'/.test(main));
});

test('桥的类型声明在 vite-env.d.ts 里（tsc 才认 window.payasoDesktop.setNativeTheme）', () => {
  const dts = fs.readFileSync(path.join('web', 'src', 'vite-env.d.ts'), 'utf8');
  assert.ok(/setNativeTheme: \(mode: 'light' \| 'dark' \| 'system'\) => void;/.test(dts));
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

test('前端按壳平台给窗口按钮让位（WCO 的 env(titlebar-area-*)）', () => {
  const mainTsx = fs.readFileSync(path.join('web', 'src', 'main.tsx'), 'utf8');
  assert.ok(
    /dataset\.shellPlatform = window\.payasoDesktop\?\.platform \?\? 'web'/.test(mainTsx),
    '首帧前必须把壳平台写进 <html data-shell-platform>',
  );
  const shellCss = fs.readFileSync(
    path.join('web', 'src', 'components', 'ShellBar', 'ShellBar.module.css'),
    'utf8',
  );
  assert.ok(
    /:root\[data-shell-platform=["']win32["']\] \.bar \{[\s\S]{0,260}env\(titlebar-area-width/.test(
      shellCss,
    ),
    'Windows 下顶栏必须用 titlebar-area-* 让出窗口按钮的宽度',
  );
  const preload = fs.readFileSync(path.join('apps', 'desktop', 'src', 'preload.cts'), 'utf8');
  assert.ok(/platform: process\.platform/.test(preload), 'preload 必须暴露 platform');
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
