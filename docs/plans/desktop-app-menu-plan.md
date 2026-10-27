# 桌面壳「应用」菜单 · 技术方案（Windows）

> 状态：**方案已定，未实施**（2026-10-24）
> 范围：`web/src`（自绘菜单）+ `apps/desktop/src`（preload / main IPC）
> 参照：DeepSeek Harness 的「应用」菜单（关于 / 检查更新… / 退出）

---

## 0. 结论

| 项 | 结论 |
|---|---|
| 形态 | 自绘「应用」下拉菜单，只出现在 **Windows** 桌面壳；macOS 保持系统菜单栏不动 |
| 菜单项 | `关于 PayasoAgent` / `检查更新…` / `退出`；**不做「编辑」菜单** |
| 关于 | 自绘弹窗（复用 `Modal`），展示版本与运行时；不用原生 messageBox |
| 检查更新 | 直接调用现有 `updates.checkInteractively()`，检查结果仍由壳用原生对话框反馈 |
| 新增 IPC | `payaso:checkForUpdates`、`payaso:quitApp`、`payaso:getAppInfo`（均校验发送者） |
| 新依赖 | 无 |

---

## 1. 背景：为什么 Windows 上找不到「检查更新」

`apps/desktop/src/main.ts` 里其实已经用原生 `Menu` 建了应用菜单（`buildMenu()`，含"检查更新…"），
但 Windows 窗口是：

```ts
titleBarStyle: 'hidden'
titleBarOverlay: { height: 50, ... }
```

即**无边框窗口**。实测（2026-10-24，Electron 44.6.0 / Windows 11 23H2）：

```
GetMenu(hwnd)   = 0        // 窗口上没有挂任何 HMENU
WS_CAPTION      = true
WS_THICKFRAME   = true
WS_SYSMENU      = false
```

即使把 `setAutoHideMenuBar(false)`（`PAYASO_SHOW_MENU=1` 临时开关）打开，窗口顶部依然没有菜单栏，
`Alt` 也调不出来——**Electron 不会把菜单栏挂到无边框窗口上**。macOS 不受影响，因为应用菜单在屏幕
顶部的系统菜单栏，与窗口形态无关。

因此 Windows 上「检查更新…」这条原生菜单项**不可达**，只剩自动检查（启动 / 窗口聚焦 / 系统唤醒）
与发现新版本后的侧边栏 chip。

---

## 2. 目标与非目标

### 2.1 目标

- Windows 壳内提供显式「应用」菜单入口，可手动检查更新、查看关于、退出；
- 视觉与现有顶栏/侧栏一致，不破坏自绘标题栏与 WCO 窗口按钮布局；
- macOS 行为**零变化**（继续使用系统菜单栏）；
- 浏览器直开（`npm run dev` 的 5173）时不渲染、不报错。

### 2.2 非目标

- 不做「编辑」（撤销/复制/粘贴）菜单：Windows 下 `Ctrl+C/V` 本来可用，价值低；
- 不改更新流程本体（检查/下载/安装状态机保持现状）；
- 不改 macOS 的 `buildMenu()`；
- 不引入第三方 UI 库或菜单组件。

---

## 3. 现状约定（实现时必须沿用）

| 关注点 | 既有做法 |
|---|---|
| 组件组织 | `web/src/components/<Name>/index.tsx` + `X.module.css`（CSS Modules） |
| 浮层 | `createPortal(..., portalRoot())`；`role="menu"` / `<button role="menuitem">`（参考 `web/src/preview/OpenInAppMenu.tsx`） |
| 定位 | `useLayoutEffect` 读 `anchor.getBoundingClientRect()`，视口内钳制 |
| 关闭 | `useClickOutside(ref, enabled, close, ignoreRef)` + `useEscapeKey(enabled, close)`（`web/src/hooks/`） |
| 模态 | `web/src/components/Modal`（自带 backdrop / Esc / 点外部关闭 / portal） |
| 拖拽区 | 顶栏 `data-window-drag`；交互元素由 `index.css` 的伞形 `no-drag` 规则放行（`button`、`role="menu"`、`role="menuitem"` 已在白名单） |
| 桥 | `preload.cts` contextBridge 暴露 `window.payasoDesktop`；页面侧再包容错模块，方法全可选、`try/catch`、浏览器降级（参考 `web/src/update-status.ts`） |
| 类型 | 桥的权威声明在 `web/src/vite-env.d.ts` |
| 主进程 IPC | `ipcMain.handle/on` + **发送者校验**（`event.sender !== mainWindow.webContents` 一律忽略），见 `registerUpdateBridge()` |
| 更新流程 | `updates.checkInteractively()` 已含 检查 → 原生对话框（已是最新 / vX 可更新）→ 下载 → 安装 |
| i18n | 文案全部进 `web/src/i18n/messages/*.ts`；`tests/frontend-i18n-coverage.test.ts` 扫描"i18n 目录外不得有用户可见中文" |

---

## 4. 交互设计（UX）

### 4.1 位置

**窗口级一行（DSH 同款）**：「应用」`fixed` 在窗口最顶部、横跨整个窗口，品牌行（🦌 Payaso）
在它下面：

```
┌──────────────────────────────────┐
│ 应用                             │ ← fixed 横跨整窗（高 36px）
│ 🦌 Payaso                 [折叠] │ ← 侧边栏顶部由壳注入变量留出上一行
│ ＋ 新会话                        │
└──────────────────────────────────┘
```

实现要点：

- `AppMenu variant="window"` → `position: fixed; top: 0; width: 100%; height: 36px`，
  带一条玻璃底（`--color-header-glass` + 细分隔线），这才是"菜单栏行"而不是浮在空处的按钮；
- **窗口按钮（WCO）也移到这一行右端**：`titleBarOverlay.height` 从 50 改为 36
  （[main.ts](apps/desktop/src/main.ts)）。于是下面主区顶栏不再需要让出整条按钮区 ——
  以前右上角为此空出 152px（真机反馈"位置没放对"的那张图），现在右缘间隙只剩 14px；
- 壳注入的 `WCO_RESERVE_CSS` 从"给 `[data-shell-bar]` 加 padding-right"改为只给
  `[data-app-menu-bar]`（第一行）让位；`--wco-reserve` 仍由 WCO API 实测写入；
- 侧边栏 `headerArea` 的 `padding-top` 复用 `--sidebar-chrome-height`（Windows 36px）
  → 品牌行自动下移；macOS 那一行仍是系统红绿灯（50px），浏览器为 0；
- **主区 `.main` 也要下移**（`padding-top: var(--window-menu-bar-height, 0px)`）——
  只下移侧边栏会让主区顶栏仍从 y=0 开始、被菜单行压住，右侧控件就和 logo 行错行
  （真机反馈"同一个水平就好"）；
- **预览 dock 同样要下移**：它是 `.main` 的**兄弟**节点，拿不到 `.main` 的 padding-top，
  所以 `.dock` 自己也要写同一段（真机反馈"这里打开的也要修复"）；
- macOS 不注入 `--window-menu-bar-height` → 主区/dock 都不下移，布局零变化；
- 容器 `pointer-events: none`、只有按钮 `auto` → 不遮挡下面顶栏的拖拽面与控件；
- 「应用」按钮**顶对齐 + 32px 高**（`align-items: flex-start`），与右侧原生 caption 按钮
  同规格 —— 垂直居中会显得比右边低一截（真机反馈"往上挪，与右侧对齐"）；
- 仅在 `platform === 'win32'` 渲染；macOS / 浏览器不渲染且不留空白；
- **侧栏收起时**（宽 0、顶栏横跨整窗）改由 `ShellBar` 左侧的 `inline` 变体兜底，
  由 `App.tsx` 按 `sidebarCollapsed` 二选一渲染。

### 4.2 菜单项与状态

| 项 | 行为 | 状态联动 |
|---|---|---|
| 关于 PayasoAgent | 打开自绘「关于」弹窗 | 常可点 |
| 检查更新… | 调 `checkForUpdates()`；结果由壳弹原生对话框 | `checking` 时文案变"正在检查更新…"并禁用；`downloading` / `installing` 时禁用 |
| —— 分隔线 —— | | |
| 退出 | `quitApp()`（走 `before-quit`，先优雅停后端） | 常可点 |

### 4.3 关于弹窗

参考 DSH：小卡片 + 标题 + 版本 + 确定按钮。

```
┌──────────────────────────────┐
│ PayasoAgent               ×  │
│                              │
│ 版本 0.4.20                  │
│ Electron 44.6.0 · Node 24.x  │
│                              │
│ [          确定           ]  │
└──────────────────────────────┘
```

复用 `Modal`（描述文案、`role="dialog"`、Esc/点遮罩关闭已有）。

### 4.4 关闭与键盘

- 点外部（`useClickOutside`，忽略触发按钮）、Esc、选择任一项后关闭；
- 触发按钮 `aria-haspopup="menu"` / `aria-expanded`；菜单 `role="menu"`，项 `role="menuitem"`。

---

## 5. 技术方案

### 5.1 新增文件

```
web/src/app-menu.ts                      # 桥的容错包装（照 update-status.ts）
web/src/components/AppMenu/index.tsx     # 按钮 + 菜单 + 关于弹窗
web/src/components/AppMenu/AppMenu.module.css
```

### 5.2 修改文件

| 文件 | 改动 |
|---|---|
| `web/src/App.tsx` | 顶层渲染 `{!sidebarCollapsed && <AppMenu variant="window" />}`（窗口级一行） |
| `web/src/components/ShellBar/index.tsx` | 侧栏**收起**时在顶栏左侧渲染 `<AppMenu />`（inline 兜底，与 window 变体互斥） |
| `web/src/vite-env.d.ts` | `PayasoDesktopBridge` 增 `platform` / `checkForUpdates` / `quitApp` / `getAppInfo` |
| `web/src/i18n/messages/shell.ts` | 新增 `shell.menu.*`、`shell.about.*`（zh/en） |
| `apps/desktop/src/preload.cts` | 暴露 4 个方法/字段 |
| `apps/desktop/src/main.ts` | `registerUpdateBridge()` 内新增 3 个 IPC handler（含发送者校验） |

### 5.3 IPC 契约

| 通道 | 形式 | 语义 | 返回 |
|---|---|---|---|
| `payaso:checkForUpdates` | `invoke` | `updates?.checkInteractively()` | void |
| `payaso:quitApp` | `send` | `app.quit()`（触发 `before-quit` 优雅停后端） | — |
| `payaso:getAppInfo` | `invoke` | 版本信息 | `{ version, electron, node } \| null` |

安全：三处都只接受主窗口 `webContents`；不新增任何"执行命令 / 打开任意路径"的能力。

### 5.4 数据流

```
[应用] → [检查更新…]
   → app-menu.ts: checkForUpdates()
   → preload: ipcRenderer.invoke('payaso:checkForUpdates')
   → main: updates.checkInteractively()
   → flow.check(true) → 原生对话框（已是最新 / vX 可更新）→ 下载 → 安装
   → coordinator.onStatus → pushUpdateStatus('payaso:updateStatus')
   → 页面 UpdateStatusRow（侧边栏 chip）与菜单项状态同步
```

### 5.5 平台差异

| 平台 | 表现 |
|---|---|
| Windows 打包壳 | 渲染「应用」菜单 |
| macOS | **不渲染**（`platform !== 'win32'`），继续用系统菜单栏的「关于 / 检查更新… / 退出」 |
| 浏览器（5173 / 4500 直开） | 无桥 → 不渲染 |

### 5.6 i18n 新增 key（zh-CN / en-US）

```
shell.menu.app            应用 / App
shell.menu.about          关于 PayasoAgent / About PayasoAgent
shell.menu.checkUpdate    检查更新… / Check for updates…
shell.menu.checking       正在检查更新… / Checking for updates…
shell.menu.quit           退出 / Quit
shell.about.title         关于 PayasoAgent / About PayasoAgent
shell.about.version       版本 {version} / Version {version}
shell.about.runtime       Electron {electron} · Node {node} / 同左
shell.about.close         确定 / OK
```

---

## 6. 实施步骤
1. `app-menu.ts`（桥包装 + `canShowAppMenu()`）；
2. `AppMenu` 组件 + 样式（菜单与关于弹窗）；
3. `ShellBar` 挂载；
4. `preload.cts` / `vite-env.d.ts` 补方法与类型；
5. `main.ts` 补 3 个 IPC handler；
6. `shell.ts` 补 i18n；
7. 验证：`npx tsc --noEmit` → `npm run lint` → `npx tsx tests/frontend-i18n-coverage.test.ts` → `npm run build`；
8. 打包：`npm run desktop:win`（TEMP 指到项目内 + 镜像，见 `LOCAL_SETUP.md`）；
9. 部署验收：复制 `win-unpacked` 到仓库外（如 `D:\PayasoAgentApp`）再运行。

---

## 7. 验收清单

| 场景 | 期望 |
|---|---|
| dev 壳（`npm run desktop`） | 顶栏出现「应用」；点开有三项 |
| 点「检查更新…」（dev） | 原生提示"当前构建不检查更新"（现有门禁） |
| 打包壳（仓库外副本） | 点「检查更新…」→ "已是最新版 0.4.20" |
| 本地假 feed（0.4.21） | 弹出 v0.4.21 可更新对话框；下载时侧边栏百分比同步 |
| 「关于」 | 弹窗显示 PayasoAgent / 版本 / Electron+Node；确定可关 |
| 「退出」 | 应用退出；后端被优雅停止（无残留 node） |
| 浏览器 5173 | 菜单不渲染、控制台无报错 |
| 交互 | Esc / 点外部关闭；菜单打开时窗口可正常拖拽其他区域 |
| 回归 | macOS 原生菜单不受影响（代码路径未改） |

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 菜单点击被拖拽区吞掉 | `button` / `role="menu"` 已在全局 no-drag 白名单；必要时显式加 `-webkit-app-region: no-drag` |
| Windows 窗口按钮（WCO）遮挡 | 菜单在左侧；壳已给右侧注入让位 padding，互不影响 |
| 老壳 + 新页面 | 桥方法全部可选，缺失时整块不渲染（同 `update-status.ts`） |
| 菜单与侧边栏状态不一致 | 两边都消费 `subscribeUpdateStatus` + `normalizeUpdateStatus`，单一状态源 |
| 打包产物在仓库内跑不起来 | 验收一律用仓库外副本（环境文件沙箱，见 `LOCAL_SETUP.md` §5） |

---

## 9. 决策记录

| 日期 | 决策 | 说明 |
|---|---|---|
| 2026-10-24 | 采用自绘菜单（方案 B） | 原生菜单在 Windows 无边框窗口不可用（实测 `GetMenu=0`） |
| 2026-10-24 | macOS 不改 | 系统菜单栏已可用，且用户确认现状良好 |
| 2026-10-24 | 不做「编辑」菜单 | Windows 下复制/粘贴快捷键不受影响，收益低 |
| 2026-10-24 | 「关于」用自绘弹窗 | 与 DSH 观感一致；不用原生 messageBox |
| 2026-10-24 | 菜单做**窗口级一行**，窗口按钮上移该行右端，且**主区/预览 dock 同步下移**，最后**「应用」顶对齐** | 七轮返工：① ShellBar（x≈540）→ ② 品牌行 logo 右侧（x=117）→ ③ 侧边栏内独立一行（x=10）→ ④ fixed 横跨整窗但按钮仍在第二行（右缘空 152px）→ ⑤ WCO 上移第一行（间隙降到 14px）→ ⑥ 补主区与 dock 下移（三者同一水平线）→ ⑦ 「应用」由 28px 垂直居中改为 32px 顶对齐（原生 caption 按钮规格），消除"比右侧低一截" |

---

## 10. 实施结果（2026-10-24 已落地）

| 项 | 结果 |
|---|---|
| 新增文件 | `web/src/app-menu.ts`、`web/src/components/AppMenu/{index.tsx,AppMenu.module.css}` |
| 修改文件 | `App.tsx`、`ShellBar/index.tsx`、`vite-env.d.ts`、`i18n/messages/shell.ts`、`apps/desktop/src/preload.cts`、`apps/desktop/src/main.ts` |
| 新增 IPC | `payaso:checkForUpdates` / `payaso:quitApp` / `payaso:getAppInfo`（均校验发送者） |
| 校验 | `tsc --noEmit` ✓ · `biome check` ✓ · i18n 覆盖 11/11 PASS ✓ · `desktop:win` 打包 ✓（setup.exe 173MB / zip 235MB / latest.yml） |
| 真机验收 | 打包副本 `D:\PayasoAgentApp` 启动正常；「应用」位于左上角；菜单三项正常；关于弹窗显示 PayasoAgent / v0.4.20 / Electron 44.6.0 · Node 24.21.0 |
| 位置修正记录 | 七轮迭代：① ShellBar（x≈540）→ ② 品牌行 logo 右侧（x=117）→ ③ 侧边栏内独立一行（x=10）→ ④ fixed 横跨整窗（x=14）→ ⑤ 窗口按钮上移第一行（右缘间隙 152px→14px）→ ⑥ 主区顶栏 + 预览 dock 同步下移（四元素同一水平线）→ ⑦ 「应用」顶对齐 32px（与原生 caption 按钮同规格） |
| 真机验收 | 打包副本 `D:\PayasoAgentApp`：「应用」y=0–32 顶对齐；主区顶栏 / 侧栏 logo / 预览 dock 头部 y=36–86 同一水平线；右侧控件贴右缘（间隙 14px）；关于弹窗显示 PayasoAgent / v0.4.20 / Electron 44.6.0 · Node 24.21.0 |
| 与 DSH 的剩余差异 | DSH 第一行中间还放会话标题 + 运行状态；我们的标题/状态仍在主区域顶栏（第二行）。要完全一致需把 ShellBar 内容上移，属布局重构，暂不做 |

## 11. 工作量

实际约 **半天**（含一次位置返工）。
