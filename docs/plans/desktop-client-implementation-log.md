# 桌面客户端落地记录（实施过程、验证步骤、踩坑）

> 状态：`e815b7b` 已推送，**装完了、包内后端实跑通过**；GUI 端到端与 DMG 都只能真机/终端验（沙箱限制）。
>
> **这份文档与另两份的分工**（别混）：
>
> | 文档 | 回答什么 |
> |---|---|
> | [`desktop-client-plan.md`](desktop-client-plan.md) | 为什么做、三条路线怎么选（横向对比） |
> | [`desktop-client-electron-plan.md`](desktop-client-electron-plan.md) | A 方案的技术设计：A1/A2、生命周期、打包配置、为什么 |
> | **本文** | **怎么做出来的、怎么验证是对的、踩了哪些坑**（实施手账） |
>
> 写这份的理由：本次实施最值钱的不是代码，而是**验证手段**和**四个坑的证据**——
> 这些不记下来，下次交付别人（或半年后的自己）只能从头踩。

## 1. 落地的清单（一次做对的三件事）

全部在 [`apps/desktop/`](../../apps/desktop/)，一共 11 个进 git 的源文件：

| 文件 | 行数 | 作用 |
|---|---:|---|
| `src/main.ts` | 261 | 壳主进程：起后端 → 等就绪 → 开窗 → 干净退场 |
| `scripts/fetch-node.mjs` | 97 | 取官方 Node 运行时到 `runtime/bin/node`（A1 的载荷） |
| `scripts/stage-backend.mjs` | 78 | 组装后端整体到 `.stage/app`（**重新构建**+只装生产依赖） |
| `scripts/make-icon.mjs` | 61 | 从 `web/public/icon-512.png` 派生 `build/icon.icns` |
| `scripts/sync-version.mjs` | ~60 | 把发布版本号写进 `package.json` **和** `package-lock.json`（否则 `npm ci` 报不同步） |
| `electron-builder.yml` | 59 | 打包配置（`npmRebuild:false`、extraResources、entitlements） |
| `package.json` / `package-lock.json` | 27 | 壳自己的依赖与版本锁 |
| `tsconfig.json` / `.gitignore` / `build/entitlements.mac.plist` | — | 编译/忽略/签名占位 |
| `README.md` | 53 | 使用说明（命令表 + 铁律 + 已知边界） |

根仓库 4 处改动：`package.json` 加 4 个 `desktop:*` 脚本、本文档、README 索引登记。

## 2. 可复现的验证步骤

**这是本文最重要的一节**——每一步都有判定标准，别只信"看起来能跑"。

### 2.1 一次装好构建环境

```bash
npm run desktop:setup     # 取官方 Node + 生成图标 + 组装后端整体
```

期望末尾打印三段：`OK .../runtime/bin/node (v22.22.3)`、`OK .../build/icon.icns`、
`OK 后端整体已就绪`（并列出 dist / web/dist / node_modules 三项体积）。

### 2.2 A2 兜底是否成立（决定"漏打包 Node 会不会翻车"）

```bash
E="apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_RUN_AS_NODE=1 "$E" -e "
  const { DatabaseSync } = require('node:sqlite');
  console.log('① sqlite', typeof DatabaseSync, process.versions.node);
  try { console.log('② sharp ', typeof require('sharp')); }        catch (e) { console.log('② sharp FAIL', e.message.split('\n')[0]); }
  try { console.log('③ canvas', typeof require('@napi-rs/canvas')); } catch (e) { console.log('③ canvas FAIL', e.message.split('\n')[0]); }
"
```

**实测结果**（全部通过，所以兜底是真的）：`① function 24.21.0`、`② function`、`③ object`。

### 2.3 编译产物能否脱壳跑（不需要 Electron）

```bash
cd apps/desktop && npx tsc -p . --noEmit && echo OK     # 类型
npm --prefix ../.. run build:server                     # 后端编译产物
PAYASO_HOME=/tmp/payaso-home PORT=4599 node ../../dist/host/index.js &
curl -s -w ' [%{http_code}]\n' http://127.0.0.1:4599/workspace   # 期望 200 JSON
```

### 2.4 打包

```bash
npm run desktop:dist      # electron-builder --mac --dir → release/mac-arm64/PayasoAgent.app
```

判定：**看包内体积，不要看退出码**。正常应该 ≈539MB；
如果 `Resources/app` 只有 6.9MB，就是踩了坑 1（见 §3）——后端会一启动就
`Cannot find module`。

### 2.5 包内后端实跑（不需要开 GUI，最关键的一步）

```bash
cd apps/desktop/release/mac-arm64/PayasoAgent.app/Contents/Resources/app
PAYASO_HOME=/tmp/payaso-home PORT=4598 ../runtime/bin/node dist/host/index.js &
sleep 8
curl -s    http://127.0.0.1:4598/workspace     # 期望 {"workspace":null} 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4598/   # 期望 200（UI被托管）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4598/runs  # 期望 200
../runtime/bin/node -e "console.log('sharp:', typeof require('./node_modules/sharp'))"
```

**必须全部 200 且 sharp 是 function**，才算这一轮交付及格。本次实测即如此，
且启动横幅打出了 `[context] 生效配置` —— 顺带证明后端是**新构建**的（不是旧 `dist/`）。

### 2.6 真机 GUI（唯一没验的）

双击 `apps/desktop/release/mac-arm64/PayasoAgent.app`。要看三件事：

1. 窗口出现且加载出界面（不是白屏/报错框）；
2. 退出后 `lsof -ti tcp:4500` 为空（没有残留后端进程）；
3. 已开着一个 `npm run host` 时启动 → **复用**且退出不杀它的进程。

## 3. 六个坑（都留了证据，别再踩）

### 坑 1 · electron-builder 会丢**根级** `node_modules`（最阴的一个）

**现象**：`extraResources` 写了 `from: .stage/app, to: app`，打包"成功"，
但 `Resources/app` 只有 6.9MB，后端一启动 `Cannot find module`。

**根因**（读了源码，不是猜的）：`app-builder-lib/out/util/filter.js` 的 `createFilter`：

```js
// filter the root node_modules, but not a subnode_modules (like /appDir/others/foo/node_modules/blah)
if (relative === "node_modules") { return false; }
else if (relative.endsWith("/node_modules")) { relative += "/"; }
```

**根级** `node_modules` 硬编码抛弃，**嵌套**的放行。而 `getMainFileMatchers` 里那段
`!**/node_modules/**` 只在 `from === appDir` 时才加，对本场景无赦免。

**解法**：拷贝来源上提一层，让产物变成嵌套路径：

```yaml
extraResources:
  - from: .stage            # ← 不是 .stage/app
    to: .
    filter:
      - "**/*"
      - "**/node_modules{,/**/*}"
```

### 坑 2 · 受限环境下 Electron 二进制落不了缓存

**现象**：`Electron failed to install correctly` / `EPERM: operation not permitted, mkdir
'/Users/luweiliang/Library/Caches/electron/<hash>'`。

**根因**：`@electron/get` 的 `defaultCacheRoot = envPaths('electron').cache`（即
`~/Library/Caches/electron`），而该目录在我方沙箱不可写。

**解法**：electron-builder 认 `ELECTRON_BUILDER_CACHE`（**必须是绝对路径**，见
`app-builder-lib/out/util/electronGet.js` 的 `getCacheDirectory({allowEnvVarOverride:true})`），
而 `@electron/get` 那部分跟着 `os.homedir()` 走，所以两个一起：

```bash
HOME=<可写目录> ELECTRON_BUILDER_CACHE=<可写绝对路径> electron-builder --mac --dir
```

> 号外：用户在自己终端里跑没有这个问题——这是沙箱特有的。

### 坑 3 · GitHub releases 拉 Electron 二进制会断

在同网络下从 GitHub 下 Electron zip **下到 40MB 就失败**两次。
走 npmmirror 稳定（`registry.npmmirror.com/-/binary/electron/44.6.0/` 实测 200）：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

**CI 里也建议固定这个变量。**

### 坑 4 · `dist/` 会过期，而且过期得不显眼

**现象**：曾出现"研报说后端零改动"，但 `dist/host/index.js` 里根本没有后来加的
启动配置打印（`e081b52`）。tar 依赖的话，交付的会是旧后端。

**解法**：`stage-backend.mjs` 里**第一步就重新跑** `build:server` + `build:web`，
不提供"跳过构建"的口子。文档 §2.5 用启动横幅反向确认后端是新的。

> 顺带：`npm run host`（生产）天生就会用到 `dist/`，这也是为什么这条会反复咬人。

### 坑 5 · DMG 只能在真机打（`hdiutil` 被沙箱禁）

**现象**：`--mac dmg zip` 时 zip 成功、dmg 失败，报：

```text
hdiutil: create failed - 操作不被允许
plistlib.InvalidFileException: Invalid file     ← dmgbuild 解析 hdiutil 输出的包装错
```

**根因**：`hdiutil create` 要挂载/卸载磁盘镜像，**沙箱不允许**；`dmgbuild` 把错误文本当
plist 解析，于是抛出那个没有信息量的 `InvalidFileException`（连重试 3 次）。

**结论**：DMG 这一步**必须由用户在终端跑**，Agent 侧只能验到 zip。

```bash
npm run desktop:dmg     # → release/PayasoAgent-0.1.0-arm64-mac.dmg + .zip
```

**已验证可用的替代**：`PayasoAgent-0.1.0-arm64-mac.zip`（193MB，含完整 `PayasoAgent.app`，
`unzip -l` 可见 `Contents/MacOS/PayasoAgent`）—— 这个正是 `electron-updater` 更新用的格式，
直接解压也能用。

### 坑 6 · 窗口看起来「不像原生应用」：标题栏要按 DSH 的配方来

**现象**：`.app` 装好后窗口顶上是一条普通 macOS 标题栏（写着应用名），而 DeepSeek Harness
是**无标题栏**设计——内容顶到上沿、红绿灯浮在侧栏左上角。用户原话「我看 deepseek harness
就很完美」。

**根因**：壳里 `new BrowserWindow` 只写了最朴素的选项，没做窗口外壳。

**解法**（配方是从 DSH 自己的 `lib/main.js` 拆出来的，不是照文档拍的）：

```ts
titleBarStyle: 'hiddenInset',        // 隐藏标题栏，但保留系统拖拽热区
trafficLightPosition: { x: 16, y: 18 }, // 红绿灯位置，和 DSH 一模一样
```

**配套的两件小事**（缺一就会丑）：

1. **侧栏顶部让位**：红绿灯浮在左上，会压住侧栏 logo。壳在 `did-finish-load` 注入
   `#root > :first-child > aside { padding-top: 40px }` —— 选择器**避开 CSS Modules
   的哈希类名**，只认语义标签 `aside`；侧栏本身是 `height:100vh` + 全局 `border-box`，
   加 padding 只压缩内容高度，不会把布局撑出窗口。
2. **标题兜底**：`win.setTitle('PayasoAgent')`。用户截图里出现过 "PayasoAgent - localhost"
   ——查遍 `web/src` 与打包产物，**没有任何地方写过标题**（`document.title` 全仓零命中），
   所以那是浏览器/宿主视图的标题，不是我们 app 的；但兜一层防外部改写。

> **未验证**：`hiddenInset` 的拖拽热区、以及侧栏折叠到 64px 时红绿灯（宽约 52px）会不会
> 略微压到主区 —— 都需要真机看一眼。

## 4. 本次会话都改了哪些（别丢）

除了桌面客户端，同一轮还修了四个东西，都有各自独立的理由：

| 提交 | 改了什么 | 怎么发现的 |
|---|---|---|
| `e3aa16e` | 投影边界改成**成批推进**（`PAYASO_PROJECT_BATCH` 默认 10） | 真实 run `1538194e` 命中率在第 21 条工具结果时从 89% 塌到 20%；用请求体掉档反推出推进 2 次 vs 51 次 |
| `103de41` | **零图片会话崩溃**（读 `slots[-1].rawBytes`） | run `afd5f28a` 失败，复现脚本 3 行；来自 P0 的旧坑 |
| `b2082f9` | **缓存分桶缺失不再当成未命中**，没有可信数据就**不出数** | 14 次调用有 6 次不返回 `cacheReadTokens`；旧算法报 27%，按上报的 8 次算是 45% |
| `e081b52` | 启动时打印**生效的上下文配置** | 做 A/B 时最怕 env 没传进去却当成已生效 |

以及本次客户端的两个提交：`7da431e`（调研）＋ `e815b7b`（落地）。

**缓存那条线的结论**（防反复）：纯追加也会 miss（前缀缓存不可能这样）→ 主因在提供方
（火山 Ark 跨后端路由），**别再为这个指标烧 run**。详见 `desktop-client-electron-plan.md`
的「六之三」。

## 5. 下一步（按优先级）

| # | 事项 | 谁做 | 备注 |
|---|---|---|---|
| 1 | **双击 .app 验 GUI** | 你 | §2.6 三条判定标准 |
| 2 | **推个 tag 试一次 CI**（`git tag v0.2.0 && git push origin v0.2.0`） | 你 | CI workflow 已写好（`.github/workflows/release.yml`），GitHub runner 有 hdiutil，能真出 DMG |
| 3 | 崩溃弹窗 + 端口占用复用分支 | 我 | 代码在，没造境 |
| 4 | `entitlements` 与公证细则，并配 `CSC_*` / `APPLE_*` secrets | 我期 2 | CI 已留好凭据入口，配了就自动签+公证 |
| 5 | 自动更新（`electron-updater` + `latest-mac.yml`） | 期 3 | zip 已在产，缺发布源与更新元数据 |
| 6 | Windows / Linux | — | `fetch-node.mjs` 只支持 darwin/linux |

## 6. 发布链路：CI 出 DMG

**为什么要有 CI 这一段**：用户问「别人都是下载一个 dmg，凭什么要我跑命令」——
问得对。发布产物本就不该在开发机上随手构建，加上 `hdiutil` 在沙箱里直接被拒
（坑 5），所以在 GitHub 的 macOS runner 上打，产出挂到 Release，才是「下载一个 dmg」
的完整体验。

**`.github/workflows/release.yml` 全貌**（12 步，`runs-on: macos-latest`，与 `ci.yml` 一致）：

| 步 | 做什么 | 为什么 |
|---|---|---|
| checkout / setup-node（`.nvmrc`） | 固定工具链 | 与 ci.yml 同源 |
| `npm ci`（root / web / apps/desktop） | 三处依赖都装 | 壳自己是独立 package，root 的 ci 不带它 |
| tsc / biome / `test:all` | **发布门禁** | 别让带病代码进安装包 |
| Resolve release version | 三选一：手动填 → tag 去 `v` → 包内版本 | 见下 |
| `sync-version.mjs` | 版本写进 **package.json + package-lock.json** | 只改前者会让 `npm ci` 报不同步 |
| `desktop:setup` | 取 Node 运行时 + 图标 + 组装后端 | 复用本地同一套脚本，不另外造 |
| `desktop:dmg` | 出 DMG + zip + blockmap | hdiutil 在 runner 上可用 |
| `upload-artifact` | 产物留档 | 手动触发时也能拿到 |
| `softprops/action-gh-release` | **仅 tag 触发**时创建 Release 并挂文件 | 手动触发只出 artifact，不误发版本 |

**版本号三选一**（优先级从高到低）：`workflow_dispatch` 填的 → tag 去掉 `v` 前缀 →
`package.json` 里的。推 `v0.2.0` 就得到 `PayasoAgent-0.2.0-arm64-mac.dmg`。

**签名/公证**：workflow 已把 `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_*` 放进 env，
**配了 secrets 就自动签+公证，没配就跳过**（electron-builder 自动探测），
不会因为没证书而让 CI 失败。CI 打的 DMG 默认**未签名**，分发时 Gatekeeper 会警告。

**怎么触发**：

```bash
git tag v0.2.0 && git push origin v0.2.0   # 发版
# 或者：Actions 页面 → Release (macOS DMG) → Run workflow（只构建，不发版）
```

> ⚠️ **这条 workflow 尚未实跑过一次**：GitHub runner 上的表现（耗时、hdiutil 是否正常、
> `npm ci --prefix apps/desktop` 在干净环境是否顺利）都需要第一次 tag 才知道。
