# 桌面客户端 · A 方案（Electron）细化调研

> 状态：**已落地到「可打包、包内后端实跑通过」**（2026-10-07）。实施清单见文末「§9 实施状态」。
> 前置文档：[`desktop-client-plan.md`](desktop-client-plan.md)（三条路线的横向对比）。本文只深挖**推荐的 A 方案**。
> 可信度标注沿用前置文档的约定：**✅ 已核实** / **⚠️ 推断** / **❓ 未验证**。

## 0. 结论

**A 方案可行，而且比听起来简单**：壳只需要 ~150 行主进程代码，**后端与前端一行都不用改**。

| | 结论 |
|---|---|
| 前端 | ✅ **零改动**（`API_BASE=''`，壳加载 `http://127.0.0.1:4500`） |
| 后端 | ✅ **零改动**（本来就是独立进程，`node dist/host/index.js`） |
| 原生模块 | ✅ **不用重编**——三个 `.node` 全是 Node-API（本地符号已验证），见 §2 |
| A1 / A2 的分叉 | **已定 A1**（自带官方 Node，零风险）。同时实测 A2 **也可行**（Electron 44 的 Node 24.21.0 带 `node:sqlite`，`sharp`/`@napi-rs/canvas` 不重编即可载入），所以壳里留了 **A2 兜底**：万一漏打包运行时，自动退回 Electron 自身的 Node —— 装完照样能开 |
| 实测落地 | `electron-builder --mac --dir` 出包成功，**包内后端用包内 Node 实跑通过**（`/workspace`、`/runs`、`/`（UI）全部 200，`sharp` 可载入） |

壳的价值只有三件：**免开终端、自动拉起后端、顺带拿到图标/菜单/更新**。别把壳做成第二个客户端逻辑。

---

## 1. 已核实的硬事实

| # | 事实 | 出处 |
|---|---|---|
| 1 | Electron 最新稳定 **44.6.0** = **Node 24.21.0** / `NODE_MODULE_VERSION` **149** / Chrome **152** | ✅ `releases.electronjs.org/releases.json` |
| 2 | `electron-builder@26.15.3`、`electron-updater@6.8.9`、`bun@1.4.2` | ✅ `registry.npmjs.org/<pkg>/latest` |
| 3 | Node-API：`Stability: 2 - Stable`；原话——**"independent from the underlying JavaScript runtime (for example, V8)"**、**"ABI stable across versions of Node.js"**、**"run on later major versions without recompilation"** | ✅ `nodejs.org/api/n-api.md` |
| 4 | **本项目三个原生模块全是 Node-API**：`sharp-darwin-arm64`、`@napi-rs/canvas` 的 `skia`、`koffi` —— 均导出 `napi_register_module_v1`、**零** legacy(`node_module_register`) 符号 | ✅ 本地 `nm -gU` 逐个符号验证 |
| 5 | DSH 的 sharp 用的就是**普通 Node 平台包** `@img/sharp-darwin-arm64`，且后端跑在 `ELECTRON_RUN_AS_NODE=1` 下 → N-API 模块在 Electron 里实装可用 | ✅ 拆包 + 符号验证 |
| 6 | Electron 官方对原生模块的指引：ABI 不同要重编，推荐 `@electron/rebuild`；"When in doubt, run `@electron/rebuild` first"；prebuild 系模块可能需按 Electron 重编 | ✅ `electron/docs/tutorial/using-native-node-modules.md` |
| 7 | DSH 的关停是分级的：`shutdown` IPC → 10s → `SIGTERM` → 5s → `SIGKILL` → 5s 后报错 | ✅ 拆 `lib/main.js` 一手代码 |
| 8 | DSH 后端就绪走 **IPC**：子进程发 `{type:'ready', url}` | 同上 |
| 9 | `node:sqlite` 在本机 Node 22.22.3 **免 flag 可用**（仅 `ExperimentalWarning`） | ✅ 本地实跑 |
| 10 | `bin/payaso.cjs` 的 `openBrowser` 默认 true，支持 `--port` / `--no-open` | ✅ 读代码 |
| 11 | **编译产物 `dist/` 可用裸 Node 直接跑**：`PAYASO_HOME=/tmp/x node dist/host/index.js` 起得来，`/workspace` 200 JSON、`/runs` 200、`/` 200 HTML（UI 也一并被托管） | ✅ 本地实跑（PORT=4599） |
| 12 | 就绪探针 **`GET /workspace`** 返回 `{"workspace":null}` + `application/json`，**未选 workspace 时也是 JSON** → 探针不会误判 | ✅ 本地实跑 |
| 13 | ⚠️ **当前 `dist/` 是旧构建**（不含 `e081b52` 的启动配置打印）→ **打包前必须 `npm run build:server`**，否则壳里跑的是老代码 | ✅ 本地比对 |

**❓ 未验证**（下面会变成验收项）：

- **Electron 44 的 Node 构建里 `node:sqlite` 是否可用** —— 它的 Node 是 24.21.0，按 Node 版本线应该有，但 Electron 是否默认编译该模块没查到；**这是 A2 的唯一拦路石，用 §2 的 spike 直接验**。
- electron-builder 的 `extraResources` / `asarUnpack` / `mac.notarize` 语义与取值（其文档站是 SPA，本轮抓不到正文）。
- macOS 签名公证细则（前置文档 §6 同样标为未验证）。

---

## 2. 决策点一：A1 自带 Node vs A2 用 Electron 的 Node

这是 A 方案**唯一真正的分叉**，决定要不要带 100MB 二进制、要不要赌 Electron 的内置模块。

| | **A1 · 自带官方 Node** | **A2 · `ELECTRON_RUN_AS_NODE`（DSH 的做法）** |
|---|---|---|
| 做法 | `extraResources` 放 `runtime/bin/node`，`spawn(nodeBin, [entry])` | `spawn(process.execPath, [entry])` + env `ELECTRON_RUN_AS_NODE=1` |
| 额外体积 | **+约 100MB**（DMG 压缩后约 +40MB） | **0** |
| 原生模块 | 与今天完全一致，**0 风险** | ⚠️ 按事实 4+5，**本项目三个都是 Node-API，应可直用**；但事实 6 建议"拿不准就重编"，属经验风险 |
| `node:sqlite` | ✅ 与今天运行环境相同，已验证 | ❓ **未验证**，需 spike |
| Node 版本 | 我们自己定（可锁 22.5+） | 随 Electron 走（今天 24.21；**Electron 升级会顺带换 Node**） |
| 与今天的差异 | 后端看到的 Node 与终端里一致 | 后端看到的是 Electron 的 Node（`process.versions` 等不同） |
| 崩溃隔离 | ✅ 独立进程 | ✅ 独立进程（同为子进程，只是二进制是 Electron 自己） |

**我的建议：先 A1，spike 通过后换 A2。**

A1 现在就能落地且零风险；A2 能省 100MB，值得为它做一次验证（见下）。**不要一上来就赌 A2**——它可能失败在 `node:sqlite`，而这个失败要到跑真实会话时才暴露。

### 2.1 决策 spike（**已跑，结果如下**）

> **实测结果**（Electron 44.6.0，`ELECTRON_RUN_AS_NODE=1`）：
>
> ```text
> ① node:sqlite → function | node 24.21.0
> ② sharp      → function          ← 不重编就能载入（Node-API）
> ③ canvas     → object            ← 同上
> ```
>
> 也就是说 **A2 完全可行**。仍然选 A1 的理由是：A1 与终端里的运行环境完全一致（零意外），
> 而且后端升级不被 Electron 的 Node 版本绑定。代价只是包体大 112MB。
> **实现在壳里做了兜底**：漏打包运行时就自动退回 A2，「装完能开」不依赖任何单点。
>
> **两个网络/环境坑**（踩过，记下来）：
> - 这台机器走深信服代理，**从 GitHub releases 拉 Electron 二进制容易断**（下到 40MB 就失败）。
>   走 npmmirror 镜像稳定可用：`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
>   （`registry.npmmirror.com/-/binary/electron/` 实测 200）；CI 里建议固定这个变量。
> - electron-builder 的产物缓存默认在 `~/Library/Caches/{electron,electron-builder}`，
>   受限环境下可用 `ELECTRON_BUILDER_CACHE=<绝对路径>` + `HOME=<可写目录>` 改道。

```bash
cd /Users/luweiliang/Downloads/myProject/PayasoAgent
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   # GitHub 下不动时才需要

ELECTRON_RUN_AS_NODE=1 npx -y electron@44 -e "
  const { DatabaseSync } = require('node:sqlite');              // ① 后端持久化
  console.log('① sqlite', typeof DatabaseSync, 'node=' + process.versions.node);
  try { console.log('② sharp ', typeof require('sharp')); }        catch (e) { console.log('② sharp  FAIL', e.message.split('\n')[0]); }
  try { console.log('③ canvas', typeof require('@napi-rs/canvas')); } catch (e) { console.log('③ canvas FAIL', e.message.split('\n')[0]); }
"
```

**判读**：

| 结果 | 决定 |
|---|---|
| ①②③ 全 OK | **选 A2**（省约 100MB），`npmRebuild: false` |
| ① FAIL（缺 `node:sqlite`） | **选 A1**（自带官方 Node），零风险 |
| ① OK、②③ 任一 FAIL | 走 A2 但补 `@electron/rebuild`；或干脆 A1 |
| 全 OK 且 `node` 版本 < 22.5 | 不能用（我们的后端硬要求 ≥22.5），回 A1 |

> 注意 `ELECTRON_RUN_AS_NODE=1` 不能省：`electron -e` 不是 Node 的 `-e`，不加这个变量它会去开窗口。
> Spike 里用 `require` 而非 ESM，因为 `-e` 里 CJS 最省事；真落地时用 `import()`。

---

## 3. 决策点二：壳的生命周期实现

壳**不做业务**，只负责四件事：起后端 → 等就绪 → 开窗 → 干净退场。

### 3.1 目录与产物布局

```text
apps/desktop/
├── package.json            # electron / electron-builder / electron-updater
├── src/main.ts             # 本文的全部代码都在这里
├── build/
│   ├── icon.icns
│   └── entitlements.mac.plist     # ❓ 未验证：内容待按官方文档定
└── electron-builder.yml
```

构建产物里（A1 布局）：

```text
PayasoAgent.app/Contents/
├── Frameworks/Electron Framework.framework
├── Resources/
│   ├── app.asar              # 只放壳自己的 lib/（main.ts 编译产物）
│   ├── runtime/bin/node      # A1：官方 Node（A2 则无此目录）
│   └── app/                  # 后端整体放这里（真实文件系统，不进 asar）
│       ├── dist/             #   956 KB  服务端编译产物
│       ├── web/dist/         #   5.4 MB  前端静态资源
│       ├── node_modules/     #   ~70-100MB（仅生产依赖）
│       └── bin/payaso.cjs    #   可选，与手动启动保持同一条路
```

**后端放 `extraResources`（真实文件系统），不要塞进 `app.asar`** —— 我们有 `fs.stat` 读附件、读 spill 路径这类动态文件访问，asar 虚拟文件系统会额外制造一串问题，收益只是省几百 MB 不到的体积。

### 3.2 主进程骨架（~150 行，可直接抄改）

```ts
// apps/desktop/src/main.ts
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 4500);
const BACKEND = `http://127.0.0.1:${PORT}`;

// —— A1 —— 带官方 Node；A2 则改成 process.execPath 并加 ELECTRON_RUN_AS_NODE
const nodeBin = path.join(process.resourcesPath, 'runtime', 'bin', 'node');
const entry = path.join(process.resourcesPath, 'app', 'dist', 'host', 'index.js');
const cwd = path.join(process.resourcesPath, 'app');

let child: ChildProcess | null = null;
let quitting = false;

/** 就绪探针：用真实存在的只读端点，而不是"TCP 通了就算" */
async function waitForReady(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BACKEND}/workspace`);   // GET，返回 JSON
      if (res.ok) return;
    } catch { /* 后端还没开始接客 */ }
    if (Date.now() > deadline) throw new Error(`后端 ${timeoutMs}ms 内未就绪`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function startBackend(): Promise<void> {
  child = spawn(nodeBin, ['--', entry], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT) },
  });
  child.stderr?.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-65_536); });
  child.on('exit', (code, signal) => {
    child = null;
    if (quitting) return;
    dialog.showErrorBox('后端意外退出', `code=${code} signal=${signal}\n\n${stderrTail.slice(-4000)}`);
    app.quit();
  });
  await waitForReady();
}

/** 分级关停（照抄 DSH）：先礼后兵，避免留下孤儿孙进程 */
async function stopBackend(): Promise<void> {
  if (!child) return;
  const exited = new Promise((r) => child.once('exit', r));
  const exitsWithin = (ms: number) => Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
  child.kill('SIGTERM');
  if (!(await exitsWithin(10_000))) child.kill('SIGKILL');
  await exitsWithin(5_000);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280, height: 860,
    title: 'PayasoAgent',
    webPreferences: { contextIsolation: true, nodeIntegration: false },  // 同源加载，不需要 preload
  });
  void win.loadURL(BACKEND);          // ← 零改动的核心：与浏览器/PWA 完全一致
  win.on('closed', () => { if (!quitting) app.quit(); });
}

// 单实例：第二个实例只负责把窗口拉起来
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu());        // ⚠️ 未验证：菜单/托盘为期2 内容
  await startBackend();
  createWindow();
}).catch((e) => { dialog.showErrorBox('启动失败', String(e)); app.quit(); });

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void stopBackend().then(() => app.quit());
});
```

**几个容易踩的坑（都从 DSH 的实现里读出来的）**：

| 坑 | 做法 |
|---|---|
| 只 `child.kill()` → **留下孤儿**（后端还 spawn 了 shell 工具） | 分级：`SIGTERM` → 10s → `SIGKILL` → 5s 仍未死则报错 |
| 用"端口通了"当就绪 | 端口可能被**别的进程**占着；用 `GET /workspace` 确认是**我们的**后端 |
| **端口已被占用**（用户自己 `npm run host` 过了） | 今天后端直接报 `Port 4500 is in use` 启动失败。壳里要分支：① 探测到已有实例 → 复用（直接开窗）；② 换端口（`PORT` 环境变量，`src/host/index.ts` 已支持）。DSH 用 profile lock + `process.kill(owner,0)` 做存活探测，更严谨 |
| 关窗 vs 退出 | `closed` 里判断是否真要退出；macOS 上 `window-all-closed` 常见做法是保留 dock 图标，但我们的后端要随之杀，所以选"关窗即退"更省事 |
| stderr 没人看 | 留一个 64KB 滚动缓冲，后端挂了弹给用户，否则**用户只会看到一个闪退窗口** |

### 3.3 关于健康检查的一个事实

后端目前**没有 `/health` 端点**（启动横幅里列的可用只读端点是 `/workspace`、`/runtime/capabilities`、`/runs`）。探针用 `/workspace` 即可。若期 2 想更严谨，可以在 `src/host/routes.ts` 加一个轻量 `GET /health`——**这是唯一一处建议的后端改动，非必需**。

---

## 4. 决策点三：打包配置（草稿，关键项 ❓ 未验证）

```yaml
# apps/desktop/electron-builder.yml
appId: com.payaso.agent
productName: PayasoAgent
directories: { output: release }

files:                       # 只放壳自己的产物
  - dist/**/*
  - "!**/node_modules/**"

extraResources:
  # 后端整体走真实文件系统（scripts/stage-backend.mjs 生成在 .stage/app）
  #
  # ⚠️ 这里是全篇最容易踩的坑：electron-builder 的 createFilter **硬编码丢弃根级
  # node_modules**（源码原话 "filter the root node_modules"），但允许嵌套的。
  # 所以来源必须是 `.stage`（而不是 `.stage/app`），让产物里变成 app/node_modules
  # 这条嵌套路径，才会被完整复制。踩过：不改的话包里只有 6.9MB，后端一启动就
  # Cannot find module。
  - from: .stage
    to: .
    filter:
      - "**/*"
      - "**/node_modules{,/**/*}"
  - from: runtime/bin/node
    to: runtime/bin/node   # A2 则删掉这一行

npmRebuild: false            # A1/A2 关键：别按 Electron ABI 重编（事实 4：全是 Node-API）

mac:
  target: [dmg, zip]         # zip 供 electron-updater 用
  category: public.app-category.developer-tools
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  # notarize: ...            # ❓ 未验证：electron-builder 的 notarize 取值与 Apple 凭据方式

# A2 时若个别模块仍报 NODE_MODULE_VERSION 不匹配，才打开：
# npmRebuild: true   +   electronRebuild
```

**❓ 未验证（实施时第一条要核对的）**：`extraResources` 的 `from/to` 语义、`asarUnpack` 与 `files` 排除的组合、`mac.notarize` 的字段形式。electron-builder 当前稳定是 **v26**（v27 尚未发布），**注意别照抄网上 v20 时代的配置**。

**体积预估**（基于本地实测数据）：

| | 体积 |
|---|---|
| Electron 壳 | ~150–200 MB |
| 后端（`dist` 956K + `web/dist` 5.4M + 生产 `node_modules` ~70–100M） | ~80–110 MB |
| 官方 Node（A1 才有） | ~100 MB |
| **合计** | **A1 ~330–410 MB / A2 ~230–310 MB**（未打包 DMG） |

> 可裁剪：`@img/sharp-wasm32`、按平台只留一个 `@img/*`、pdfjs 的 `@napi-rs/canvas`（27MB，可选依赖）。

---

## 4.5 怎么开发、怎么构建

**不引入 Electron Forge / electron-vite**（它们会把项目套进 webpack/vite 的第二套构建链）。
壳只有 `main.ts` 一个文件，用现成的 `tsc` 就够：

```jsonc
// apps/desktop/package.json（要点）
{
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p .",
    "dev": "npm run build && cross-env-shell ... electron .",   // 开发：直接起壳
    "dist:mac": "npm run build && electron-builder --mac --dir", // --dir 只出 .app 不打 dmg，迭代快
    "dist:dmg": "npm run build && electron-builder --mac dmg zip"
  },
  "devDependencies": {
    "electron": "^44.6.0",
    "electron-builder": "^26.15.3",
    "typescript": "^5.5.0"
  },
  "dependencies": {
    "electron-updater": "^6.8.9"
  }
}
```

**开发循环里最关键的一条**：壳在开发期也应该指向**已经构建好的后端**（`../dist` + `../web/dist`），
不要让壳去跑 `tsx` 源码——否则你同时要管两条构建链，热更新也回不来。前端改完照旧
`npm run build:web`，壳里刷新窗口（Cmd+R）即可。

**⚠️ 打包前必须先构建后端**：`dist/` 是 `npm run build:server` 的产物，**会过期**。
实测当前 `dist/` 就落后于 `src/`（不含 `e081b52` 的启动配置打印）。建议打包脚本固定成：

```jsonc
"dist:mac": "npm --prefix .. run build:server && npm --prefix .. run build:web && electron-builder --mac"
```

——即每次打包都**重新编译服务端 + 重新构建前端**，别赌 `dist/` 是新的。

**根 `package.json` 建议加的入口**（不破坏现有脚本）：

```jsonc
"desktop": "npm --prefix apps/desktop run dev",
"desktop:dist": "npm --prefix apps/desktop run dist:mac"
```


---

## 5. 决策点四：签名与更新（分级，细则 ❓ 未验证）

| 阶段 | 要做什么 | 成本 |
|---|---|---|
| **期 1（本地自用）** | 什么都不用。本地构建的 `.app` 没有 quarantine 属性，双击就能跑 | 0 |
| **期 2（发给同事）** | Apple Developer 账号 + `Developer ID Application` 证书 + hardened runtime + `notarytool` 公证 + `stapler` | 账号年费；electron-builder 可接 `mac.notarize` |
| **期 3（自动更新）** | `electron-updater` + `app-update.yml`（`provider: generic` 或 GitHub Releases） | 0 额外成本，需 https 下载源 |

**⚠️ 特别提醒（针对我们的形态）**：应用内嵌了一个 `node` 二进制（A1）。按通用做法，**内嵌的可执行文件必须随应用一起签名且不能带 quarantine 标记**，否则公证会被拒。这一点本轮未拿到 Apple 官方文档原文，实施前必须核对。

DSH 的实装可直接参照：`app-update.yml` 用 `provider: generic` + `channel: nightly`，依赖 `electron-updater@^6.8.9`（与 npm 当前最新版一致）。

---

## 6. 验收清单

**Spike（动手前，~10 分钟）**

- [ ] `ELECTRON_RUN_AS_NODE` 下 `node:sqlite` 可用？（决定 A1/A2）
- [ ] `sharp` 不重编直接载入 Electron？（决定 `npmRebuild` 取值）
- [ ] 端口占用时后端的确切报错（决定壳的复用分支怎么写）

**期 1（最小可用）**

- [ ] 壳启动 → 后端就绪 → 窗口出现，**全程不需要开终端**
- [ ] 页面行为与浏览器一致（SSE 流式、会话恢复、附件、上下文环）
- [ ] 关窗 → 进程树干净（`lsof -i :4500` 为空、无残留 node）
- [ ] 后端被外部 kill → 弹窗而非静默闪退
- [ ] 二次双击 → 聚焦已有窗口（单实例）
- [ ] 手动 `npm run host` 已占用 4500 时的表现（复用 or 换端口）

**期 2（可分发）**

- [ ] DMG 双击安装 → 首启不报"已损坏"
- [ ] 图标/菜单/名称正确，无 dev 内容（vite/tsx 字样）
- [ ] 断网首启能起（不需要 npm install）
- [ ] `electron-updater` 指向的源可下载

**回归**

- [ ] `npm run test:all` 全绿（壳是新增目录，不应影响既有 113 套件）

---

## 7. 风险与未验证项汇总

| 风险 | 影响 | 规避 |
|---|---|---|
| Electron 内置 `node:sqlite` 不可用 | 仅 A2 受影响 | §2 spike；失败则 A1 |
| electron-builder 配置字段（v26）理解偏差 | 打包失败或产物缺文件 | 实施首日以官方 v26 文档为准逐字段核对（文档站是 SPA，需浏览器查阅） |
| macOS 内嵌二进制签名/公证 | 对外分发被拒 | 期 1 不涉及；期 2 前补官方文档核对（前置文档 §6 已标未验证） |
| 后端升级后依赖 Electron 的 Node 版本（A2） | Electron 升级 → Node 变 → 依赖可能失效 | 用 A1，或对 A2 加一条 CI 断言（`process.versions.node >= 22.5`） |
| 壳做成"第二个客户端"，逻辑与 Web 重复维护 | 长期成本 | 铁律：**壳只负责进程与窗口**，一切业务走 `localhost:4500` |

---

## 8. 参考资料

- Electron · Native Node Modules：https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- Node-API（ABI 稳定性原话）：https://nodejs.org/api/n-api.html
- Electron 版本矩阵（Node/Chrome/modules）：https://releases.electronjs.org/
- electron-builder：https://www.electron.build/
- electron-updater：https://www.electron.build/auto-update.html
- DSH 实装证据：本机 `/Applications/DeepSeek Harness.app` 拆包（`app.asar` 头 → `package.json` / `lib/main.js`、`runtime/versions.json`）
- 横向路线对比：[`desktop-client-plan.md`](desktop-client-plan.md)
- 本项目 PWA 桌面入口（已实施）：[`../web/pwa-desktop-install.md`](../web/pwa-desktop-install.md)

## 9. 实施状态

已落地在 [`apps/desktop/`](../../apps/desktop/)（2026-10-07），**包内后端实跑通过**。

| 项 | 状态 |
|---|---|
| `src/main.ts` 壳主进程（约 230 行：起后端 / 就绪探针 / 分级关停 / 单实例 / 端口占用复用 / 外链走系统浏览器） | ✅ |
| **A1** 自带官方 Node（`scripts/fetch-node.mjs`，v22.22.3，只解 `bin/node`） | ✅ |
| **A2 兜底**（漏打包运行时 → 自动用 Electron 自身的 Node） | ✅ |
| 后端 staging（`scripts/stage-backend.mjs`：**重新构建** + 只装生产依赖） | ✅ 97.3 MB |
| 应用图标（`scripts/make-icon.mjs`，从 `web/public/icon-512.png` 派生；二进制不进 git） | ✅ |
| `electron-builder.yml`（`npmRebuild: false`、icon、entitlements、dmg/zip） | ✅ |
| 根脚本 `desktop:setup` / `desktop` / `desktop:dist` / `desktop:dmg` | ✅ |
| `electron-builder --mac --dir` 出包 | ✅ |

**实测体积**

| | 体积 |
|---|---|
| Electron 壳（`Contents/Frameworks`） | 288 MB |
| 后端整体（`dist` 1.1M + `web/dist` 5.7M + 生产 `node_modules` **131M**） | 138 MB |
| 自带 Node（`runtime/bin/node` v22.22.3） | 112 MB |
| `app.asar`（壳自身，只是 main.js） | 12 KB |
| **合计** | **539 MB**（DMG 压缩后会小很多，未实打） |

**包内后端实跑验收**（用包里的 Node 跑包里的后端）：

```text
[context] 生效配置（env 可覆盖）
  投影 on  · 保留最近 2 轮 / 20 条 · 成批 10 条
GET /workspace → 200 {"workspace":null}
GET /          → 200 text/html        ← UI 正常被托管
GET /runs      → 200
sharp: function                       ← 生产依赖可载入
```

**还没做**（如实）：

- ❌ **GUI 端到端未验**：壳窗口需要图形会话，沙箱里只能验到"包内后端能跑"。
  **需要你在真机双击一次**：`apps/desktop/release/mac-arm64/PayasoAgent.app`
- ❌ `dist:dmg` 未实打（DMG 生成、压缩后体积均未验证）
- ❌ 签名 / 公证 / 自动更新（期 2、期 3；`entitlements.mac.plist` 内容仍标注未验证）
- ❌ Windows / Linux（`fetch-node.mjs` 目前只支持 darwin/linux）
- ❌ 后端崩溃弹窗、端口占用复用这两个分支**代码在但未造境验证**
