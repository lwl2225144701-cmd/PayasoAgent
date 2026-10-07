# 桌面客户端调研（如何把 PayasoAgent 做成一个能点图标就开的应用）

> 状态：**调研完成，未实施**（2026-10-07）。
> 调研方式与数据可信度见 [§7](#7-调研方法与数据可信度)——本节明确标注哪些是核实过的、哪些是推断、哪些没验证。

## 0. 结论先行

**你只缺一件事：不用开终端。** 其余（API、UI、SSE、会话恢复、静态服务）全都跑通了。

| 路线 | 一句话 | 判断 |
|---|---|---|
| **A. Electron 壳**（推荐） | 拉起自带的官方 Node 跑后端 → 开窗口指向 `localhost:4500` | ✅ 技术栈不变（全 TS）、成熟签名/公证/自动更新、**可用 DSH 的实装当模板** |
| B. Tauri v2 + Node sidecar | 系统 WebView + 外置 Node 二进制 | ⚠️ 包体小得多，但**要引入 Rust 工具链**与跨平台三元组矩阵 |
| C. 一键启动脚本（过渡） | 双击 `.command` / `.app` → 跑 CLI → 自动开浏览器 | ✅ **10 分钟、零依赖、今天就能用**；缺图标常驻、自动更新 |
| D. Node SEA 单文件 | 把后端打成单个可执行文件 | ❌ **解决不了"壳"的问题**，且 Node 22 上限制多，见 §3.3 |

**推荐节奏**：先做 C（立刻解痛），再做 A（真客户端）。D 不做，B 只有在"包体 <50MB"成为硬指标时再考虑。

---

## 1. 现状盘点：项目已经具备什么

| 能力 | 状态 | 证据 |
|---|---|---|
| 后端服务（HTTP + SSE + 静态托管 UI） | ✅ | `src/host/index.ts` 同时提供 API、SSE、`serveStatic(web/dist)` |
| 生产形态只需一条命令 | ✅ | `npm run host`（`tsx` 直跑）或 `node bin/payaso.cjs`（读 `dist/`）。**前端已 build 到 `web/dist`，不需要 vite** |
| CLI 入口且自动开浏览器 | ✅ | `bin/payaso.cjs`：`openBrowser` 默认 true，支持 `--port` / `--no-open` |
| 前端 API 同源相对路径 | ✅ | `web/src/api.ts:21` `const API_BASE = ''` → 加载 `http://127.0.0.1:4500` **零前端改动** |
| PWA 桌面入口 | ✅ 已实施（2026-09-11） | `docs/web/pwa-desktop-install.md`，Chrome 独立窗口安装验收通过 |
| 端口/启动可配置 | ✅ | `PORT` 环境变量、`--port`、启动时打印生效配置（`e081b52`） |
| **点图标自动起后端** | ❌ **唯一缺口** | 同上文档 §9 明确写着：触发条件 =「需要点击图标自动启动 Host → 重新评估轻量启动器、Tauri 或 Electron」 |

**关键事实**：PWA 的死穴是**浏览器无法 spawn 本地进程**，这正是 Electron/Tauri 唯一真正补上的东西。

---

## 2. 三条路线对比

| 维度 | A · Electron | B · Tauri v2 | C · 一键脚本 |
|---|---|---|---|
| 后端怎么跑 | 子进程（自带 Node 或 `ELECTRON_RUN_AS_NODE`） | `externalBin` sidecar | 子进程（系统 Node） |
| 壳的技术栈 | 全 JS/TS ✅ | **需要 Rust + Xcode CLT** ⚠️ | Shell / AppleScript |
| 前端改动 | **0**（加载 `localhost:4500`） | 0（同样指向 localhost） | 0 |
| 原生模块（sharp / canvas / koffi） | 两条路可选，见 §3.1 | 需按 `-target-triple` 分平台提供 | 用系统 Node，**0** |
| 壳体积（不含后端） | ~150–200MB（内嵌 Chromium） | ~10–15MB（系统 WebView） | 0 |
| 签名 / 公证 / 自动更新 | `electron-builder` 一键，`electron-updater` 成熟 | `tauri.conf` 内建 | 无（自用不需要） |
| 单实例、托盘、菜单、深链接 | 全部内建 | 全部内建（需写 Rust） | 需自己写 |
| 主要成本 | 包体、内存 | 新工具链 + 交叉编译矩阵 | 几乎没有 |

---

## 3. 逐条论证（含证据）

### 3.1 后端放在哪个 Node 里跑 —— 这是最大的分叉

**硬约束**：Electron 的 V8 / OpenSSL 与官方 Node 不同 → **ABI 不同**。原生模块若按 Node 编译，载入 Electron 会报 `NODE_MODULE_VERSION XYZ != ABC`。官方文档明确要求用 `@electron/rebuild` 重编（**已核实**）。

| 子方案 | 做法 | 代价 |
|---|---|---|
| **A1 · 自带官方 Node**（推荐） | `extraResources` 里放一个官方 `node` 二进制，`spawn(nodeBin, ['dist/host/index.js'])` | +约 100MB；**原生模块完全不用动**（本来就是给 Node 编的） |
| A2 · Electron 自身（DSH 的做法） | `spawn(process.execPath, [...])` + 环境变量 `ELECTRON_RUN_AS_NODE=1` | 0 额外体积；但**所有原生依赖必须按 Electron ABI 重编**（`electron-builder install-app-deps`） |
| A3 · 把后端 require 进 Electron 主进程 | 用 Electron 自带 Node `import('../dist/host/index.js')` | 体积最小；同样吃 A2 的 ABI 问题，且后端崩溃会连带壳一起崩 |

**选 A1 的理由**（对本项目）：

1. 后端本来就是**独立进程**设计（`bin/payaso.cjs` 就在 `node dist/host/index.js`），不需要改一行运行时代码。
2. 本项目有 3 个原生模块：`sharp`（**已做动态加载 + 失败降级**，`src/host/attachments/normalize.ts`）、`@napi-rs/canvas`（35MB `pdfjs-dist` 的可选依赖）、`koffi`。走 A1 一个都不用碰；走 A2 要三个都过 `@electron/rebuild`，失败面大。
3. `node:sqlite` 在 Electron 自带 Node 里**是否可用未经验证**；A1 用官方 Node 则与今天运行环境完全一致（本机 22.22.3 已验证免 flag 可用，仅打 `ExperimentalWarning`）。
4. 崩溃隔离：后端挂了壳还在，可重启或给出提示。

> A2 是 DSH 的实装选择（见 §4），它的理由是自己本来就**另外**带了官方 Node 给 pnpm/插件用，成本已经付了。对我们而言 A1 更划算。

### 3.2 前端接入：**零改动**

`API_BASE = ''`，页面与 API、SSE 全同源。壳里 `loadURL('http://127.0.0.1:4500')` 之后，`fetch` 和 `EventSource` 的行为与今天 Chrome/PWA 里的**完全一致**，不引入 CORS、不需要重打包前端。

> 不要走 `file://` 加载 `web/dist`：那会让前端与 API 跨源，必须重设 API base 或加代理，纯属自找麻烦。

### 3.3 Node SEA 单文件：**不是答案**（已核实）

| 事实 | 出处 |
|---|---|
| 稳定性标记 `Stability: 1.1 - Active development` | Node `doc/api/single-executable-applications.md`（main 分支） |
| 一键生成 `--build-sea` **自 v25.5.0 起** | 同上（`added: v25.5.0`）——**你在 Node 22.22，用不上** |
| Node 22.x 分支仍是 **postject 手工注入**路线 | `node/v22.x` 分支的同一文档 |
| **原生 `.node` 不能从 VFS 直接 `dlopen`**，必须先落临时文件 | main 分支 `#### Native addon limitations` |
| `useVfs` 与 `useSnapshot` / `useCodeCache` 互斥 | 同上 |

SEA 最多解决"后端只有一个 exe"，**窗口、图标、自动更新、签名壳仍然要 Electron/Tauri**。等于白费一道工序，还要自己处理临时目录里的原生模块。**不做。**

（附带收益：如果哪天想发一个独立的 `payaso-server` 单文件二进制给非 Electron 用户，SEA 才有用武之地。）

### 3.4 Tauri 的 Node sidecar（已核实）

- `tauri.conf.json` 的 `bundle.externalBin` 列出二进制，**必须按目标平台带 `-$TARGET_TRIPLE` 后缀**（如 `node-aarch64-apple-darwin`），每个平台各来一份。
- 运行时用 `Command.sidecar('binaries/xxx')`（`@tauri-apps/plugin-shell`），并在 `capabilities/default.json` 授权 `shell:allow-execute`（或 `allow-spawn`）。
- **Tauri 需要 Rust 工具链**；macOS 上还要求 Xcode / Xcode Command Line Tools（官方 prerequisites 文档明列 Rust 与系统依赖两节）。

**结论**：能做，但对你这个"全是 TS、想快速上线"的项目，引入 Rust + 三元组矩阵是明显负担。除非把包体压到 50MB 以下成为硬指标，否则不优先。

### 3.5 生命周期：启动 → 就绪 → 退出（照抄 DSH 实装）

这些是"壳 + 本地服务"真正容易踩坑的地方。**已从 DSH 的 `lib/main.js`（asar 内一手代码）提取出完整做法**：

**① 启动与就绪**

```ts
// DSH 的 DesktopHostProcess.start()（从 asar 提取，已核对）
const entry = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js');
const child = spawn(this.node, ['--expose-internals', entry, runtimeDir, projectDir, primaryRuntime], {...});
child.on('message', (m) => { if (m.type === 'ready') this.readyResolve({ url: m.url, ... }); });
```

它用 **Node 的 IPC（`child.send` / `on('message')`）**传 `ready`，比轮询端口可靠。我们的后端目前没有 IPC，所以**用 HTTP 就绪探针更省事**：

```ts
async function waitForReady(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/workspace`); // 真实存在且返回 JSON 的只读端点
      if (res.ok) return;
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error(`后端 ${timeoutMs}ms 未就绪`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
```

**② 端口被占用**（用户可能已经手动 `npm run host` 过了）

今天的行为是 `Port 4500 is in use` 后启动失败。壳里需要二选一：复用已有实例（直接开窗口）或换端口（`PORT` 环境变量，`src/host/index.ts` 已支持）。**DSH 用的是 profile lock + 进程存活检测**（`process.kill(owner, 0)`），更严谨。

**③ 退出清理（DSH 的分级关停，可直接抄）**

```ts
if (child.connected) child.send({ type: 'shutdown' });
if (!(await exitsWithin(exit, 10_000))) child.kill('SIGTERM');   // 10s 等优雅退出
if (!(await exitsWithin(exit,  5_000))) child.kill('SIGKILL');  // 再 5s 硬杀
if (!(await exitsWithin(exit,  5_000))) throw new Error('did not exit after SIGKILL');
```

**不要**只 `child.kill()`：macOS 上的 shell 工具可能留下孤儿孙进程。

**④ 单实例锁**：`app.requestSingleInstanceLock()`，第二个实例只把已有窗口拉起来。

**⑤ 窗口关闭 vs 应用退出**：关窗时区分 `window-all-closed`（macOS 通常保留 dock 图标，可直接 `app.quit()` 杀后端）与用户点了"退出"。

---

## 4. 同类参考：DSH 的实装拆解（本机一手证据）

你正在用的 DeepSeek Harness 就是这个形态，我直接拆开它的 `.app` 读了实现：

| 组成 | 内容 |
|---|---|
| 壳 | `Electron Framework` + `Squirrel.framework`，包名 `@deepseek-ai/dsh-desktop`，`main: lib/main.js`（486KB） |
| 包描述 | **"Electron desktop shell for a bundled dsh runtime and external plugins"** |
| 自动更新 | `dependencies: { electron-updater: ^6.8.9 }` + `app-update.yml`（`provider: generic`、`channel: nightly`） |
| 目录 | `app.asar`（renderer + lib）+ `app.asar.unpacked`（**原生模块必须解包**：`sharp`、`koffi`、`node-pty`、`sherpa-onnx`…）+ `runtime/` |
| 运行时 | `runtime/versions.json` → **Node 24.18.1** + pnpm 11.7.0 |
| 后端启动 | `spawn(process.execPath, [entry, runtimeDir, ...])` + `ELECTRON_RUN_AS_NODE: '1'` |
| 就绪 | 子进程 IPC 发 `{type:'ready', url}` |
| 关停 | `shutdown` IPC → 10s → `SIGTERM` → 5s → `SIGKILL` → 5s 报错 |
| 体积 | 整包 **999MB**（含 office-skills、pnpm、模型等，不具可比性） |

**两个可直接复用的结论**：

1. `app.asar.unpacked` 是原生模块的**必须**项（asar 内不能 `dlopen`），这与 Node SEA 的限制是同一件事。
2. DSH 的后端走 `ELECTRON_RUN_AS_NODE`（A2），代价是原生模块按 Electron ABI 重编；它**另外**又带了一份官方 Node（`runtime/bin/node`）给 pnpm / 插件用 —— 两份运行时，它自己把 A1 和 A2 都用了。

---

## 5. 推荐方案的落地设计

### 5.1 目录布局

```text
apps/desktop/
├── package.json            # electron + electron-builder + electron-updater
├── src/main.ts             # spawn 后端 / 就绪探针 / 开窗 / 关停
├── src/preload.ts          # （可选）暴露 minimal IPC
└── electron-builder.yml    # mac: dmg, identity, notarize, asarUnpack
```

分发产物里：

```text
PayasoAgent.app/Contents/
├── Resources/
│   ├── app.asar                     # 壳的 lib/ + renderer/（只放壳自己的代码）
│   ├── app.asar.unpacked/           # 若后端有原生模块且被 asar 打包
│   ├── runtime/bin/node             # A1：官方 Node 二进制（~100MB）
│   └── app/                         # A1：dist/ + node_modules(仅生产) + web/dist
└── ...
```

> **后端代码放 `extraResources` 而不是 `app.asar`**：`require`/`import` 里的原生模块和动态路径（我们有 `fs.stat` 读附件、读 spill）在 asar 内要走虚拟文件系统，坑很多。放到真实文件系统最省事。

### 5.2 需要打包的内容（实测）

| 内容 | 体积 |
|---|---|
| `dist/`（编译后的服务端 JS） | **956 KB** |
| `web/dist/`（前端静态资源） | **5.4 MB** |
| 生产 `node_modules` | 约 70–100 MB（`pdfjs-dist` 35M + `pdf-lib` 23M + `pi-ai` 7M + `sharp` 2M 及传递依赖） |
| 官方 Node 二进制 | ~100 MB 量级（未精确实测；本机整套 Node 安装 278MB 含 npm/npx） |
| Electron 壳 | ~150–200 MB |
| **合计（DMG 前）** | **~350–400 MB**；DMG 压缩后约 120–160 MB |

> 可裁剪项：`@img/sharp-wasm32`（只在原生加载失败时用）、按平台只装一个 `@img/*`、pdfjs 的 `@napi-rs/canvas` 是可选依赖（27MB）。

### 5.3 `electron-builder` 关键配置（草稿）

```yaml
appId: com.payaso.agent
productName: PayasoAgent
directories: { output: release }
files:
  - dist/…           # 只放壳自己的产物
extraResources:
  - from: ../dist/       to: app/dist
  - from: ../web/dist/   to: app/web/dist
  - from: ../node_modules to: app/node_modules
  - from: runtime/bin/node to: runtime/bin/node
asar: true
mac:
  target: [dmg, zip]
  category: public.app-category.developer-tools
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
npmRebuild: false   # A1：不按 Electron ABI 重编，原生模块就是给 Node 编的
```

`npmRebuild: false` 是 A1 的关键开关——**不要**让它按 Electron 重编我们给 Node 编的原生模块。

### 5.4 分期

| 期 | 内容 | 估算 |
|---|---|---|
| **0 · 过渡（C）** | `启动 PayasoAgent.command`（或极简 `.app`），双击 → `node bin/payaso.cjs` → 自动开浏览器 | **10 分钟** |
| **1 · 最小壳** | `apps/desktop`：spawn + 就绪探针 + 开窗 `loadURL` + 关停清理 + 单实例；本地跑（不签名、不公证） | 1–2 天 |
| **2 · 可分发** | electron-builder 打 DMG、图标、菜单/托盘、端口冲突处理、开机自启（可选） | 2–3 天 |
| **3 · 对外** | 签名 + 公证 + `electron-updater` 自动更新 + CI（macOS runner） | 1–2 天（含申请账号） |

**期 0 的实现**（今天就能用，成本几乎为零）：

```bash
#!/bin/zsh
# 启动 PayasoAgent.command —— 放桌面，双击即可（chmod +x）
cd "/Users/luweiliang/Downloads/myProject/PayasoAgent" || exit 1
exec node bin/payaso.cjs        # 起 host 并自动打开 http://localhost:4500
```

> 注意：`bin/payaso.cjs` 的 `openBrowser` 默认就是 `true`，所以这条命令自带"起来就开页面"。
> 这也顺带纠正一个误解：**生产形态下 `npm run host` / `node bin/payaso.cjs` 一条命令就是完整的**（API + UI 都在 4500），`npm run dev` 的两进程只在**开发改前端**时才需要。

---

## 6. 分发与签名（**本节未验证**）

> ⚠️ 这一节的调研子任务中途失败（原因见 §7），Apple 官方文档是 JS 渲染的、抓不到正文。以下按通用知识列出，**动手前需要按官方文档二次确认**。

**只在自己机器上用（你目前的场景）**：

- 本地构建的 `.app` **没有 quarantine 属性**，不需要签名与公证即可运行；
- 或做 ad-hoc 签名（`codesign -s -`）防止本地签名失效提示。

**要发给别人（macOS 非 App Store）**：

1. Apple Developer Program 账号（年费）；
2. `Developer ID Application` 证书 + hardened runtime；
3. `notarytool` 提交 zip/dmg 公证 → `stapler staple`；
4. **注意**：应用内嵌的可执行文件（我们放的 `runtime/bin/node`）必须一并签名，且不能带 quarantine 标记，否则公证会失败；
5. `electron-builder` 的 `mac.notarize` 与 `electron-updater`（`provider: generic` 或 GitHub Releases）可覆盖 2–5 步。

**未验证项**：具体 entitlements 名称（是否需要 `allow-unsigned-executable-memory` / `disable-library-validation`）、公证被拒的常见原因、Squirrel 与 electron-updater 在新系统的取舍。

---

## 7. 调研方法与数据可信度

**诚实声明**：本轮调研的三个外部分派子任务**全部中途失败、没有产出**，且两种内置联网工具被环境挡住了：

| 工具 | 结果 | 原因 |
|---|---|---|
| `web_search` | ❌ | DeepSeek 搜索端点返回 **HTTP 402 余额不足**（需在 Settings → Plugins → Web search 调整端点，或给对应账号充值——只有你能改） |
| `web_fetch` | ❌ | 本机 DNS 被深信服代理接管（`nodejs.org → 198.18.1.59`，属保留的 fake-IP 段），工具拒绝非公网 IP |
| 三个 research 子代理 | ❌ 全部失败，无输出 | 推测即因上述两条 |
| **`curl` 直连** | ✅ 可用 | 于是改为**手工抓官方原文**（GitHub raw + npm registry），数据可信度见下 |

**已核实**（本轮实抓，附出处）：

| 事实 | 出处 |
|---|---|
| `electron@44.6.0` / `electron-builder@26.15.3` / `electron-updater@6.8.9` / `@tauri-apps/cli@2.12.1` | `registry.npmjs.org/<pkg>/latest` |
| Node 最新 `v26.10.0`、最新 LTS `v24.21.0 (Krypton)` | `nodejs.org/dist/index.json` |
| SEA 稳定性 1.1、`--build-sea` 自 v25.5.0、原生 addon 不能从 VFS `dlopen` | `raw.githubusercontent.com/nodejs/node/main/doc/api/single-executable-applications.md` |
| Node 22.x 的 SEA 走 postject、有 `assets` 但无 VFS | `raw.githubusercontent.com/nodejs/node/v22.x/doc/api/single-executable-applications.md` |
| Electron 与 Node ABI 不同、需 `@electron/rebuild` | `raw.githubusercontent.com/electron/electron/main/docs/tutorial/using-native-node-modules.md` |
| Tauri `externalBin` + `-target-triple` + `Command.sidecar` + `shell:allow-execute` | `raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/develop/sidecar.mdx` |
| Tauri 需要 Rust、macOS 需 Xcode/CLT | `raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/start/prerequisites.mdx` |
| DSH 的架构、生命周期、体积、运行时版本 | 本机拆包：`.app` 目录 + `app.asar` 头解析 → `package.json` / `lib/main.js` |
| 本项目各事实 | 仓库内文件与本地实测（见 §1、§5.2） |

**推断（合理但未读到实现代码确认）**：

- DSH 主后端确实跑在 `ELECTRON_RUN_AS_NODE` 之下、因此其原生模块按 Electron ABI 构建 —— 由 `runtimeResources().node = process.execPath` + `desktopNodeEnvironment()` 两段代码推得，未验证其构建配置里是否另有 `npmRebuild`。
- DMG/安装包体积为估算量级，未实打过。

**明确未验证**：macOS 签名与公证细则（§6）、Electron 44 内置的 Node 版本号、Tauri 在本项目的实际包体与启动耗时。

---

## 8. 参考资料

- Node SEA：https://nodejs.org/api/single-executable-applications.html
- Electron · Native Node Modules：https://electronjs.org/docs/latest/tutorial/using-native-node-modules
- electron-builder：https://www.electron.build/
- electron-updater：https://www.electron.build/auto-update
- Tauri · Sidecar：https://v2.tauri.app/develop/sidecar/
- Tauri · Prerequisites：https://v2.tauri.app/start/prerequisites/
- PWA 桌面入口（本项目已实施）：[`docs/web/pwa-desktop-install.md`](../web/pwa-desktop-install.md)
