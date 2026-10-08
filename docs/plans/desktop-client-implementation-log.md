# 桌面客户端落地记录（实施过程、验证步骤、踩坑）

> 状态：DMG 发版链路已通（v0.2.1 起带定制安装窗，v0.2.2 起带 ad-hoc 签名）；
> **当前进展见 §0**（做成什么、缺什么、谁动手，一眼看完）。
>
> **这份文档与另两份的分工**（别混）：
>
> | 文档 | 回答什么 |
> |---|---|
> | [`desktop-client-plan.md`](desktop-client-plan.md) | 为什么做、三条路线怎么选（横向对比） |
> | [`desktop-client-electron-plan.md`](desktop-client-electron-plan.md) | A 方案的技术设计：A1/A2、生命周期、打包配置、为什么 |
> | **本文** | **怎么做出来的、怎么验证是对的、踩了哪些坑**（实施手账） |
>
> 写这份的理由：本次实施最值钱的不是代码，而是**验证手段**和**六个坑的证据**——
> 这些不记下来，下次交付别人（或半年后的自己）只能从头踩。

## 0. 当前进展（截至 2026-10-08）

**一句话**：**全链路收官** —— GUI 真机验证通过、退出零残留、DMG 发版链路自 v0.2.2 起稳定
出包（定制安装窗 + ad-hoc 签名）；剩下的是锦上添花（见 ②、③）。

### ① 做完且已验证（有实测证据）

| 项 | 证据 |
|---|---|
| 壳主进程：起后端 → 就绪探针 → 开窗 → 分级关停 | 代码 + `tsc` 0 错误 |
| 后端整体可打包（只装生产依赖） | staging **97.3MB**、107 个包（开发态是 312MB） |
| 自带官方 Node（A1） | `runtime/bin/node` **v22.22.3**，实跑正常 |
| **包内后端端到端实跑** | 用包里的 Node 跑包里的后端：`/workspace`、`/runs`、`/`（UI）**全 200**，`sharp` 可载入，启动横幅带新配置打印（证明后端是新构建的） |
| A2 兜底成立 | Electron 44 的 Node **24.21.0** 有 `node:sqlite`，`sharp`/`canvas` 不重编即可载入 |
| 窗口外壳 DSH 配方已进包 | 包内 `main.js` 已核验：`hiddenInset` + `trafficLightPosition:{x:16,y:18}` + 侧栏让位 CSS + `setTitle` 四处齐全 |
| 代码质量 | 113 套件全绿、biome 干净、`docs-index` 4/4 |
| 顺带修的四个（各有独立理由） | 投影成批推进（前缀改写 14 → **1**）、零图片会话崩溃、缓存分桶缺失 ≠ 未命中、启动打印生效配置 |
| **真机 GUI 端到端 + 退出清理** | 用户实测：窗口正常、用完退出后 `lsof -ti tcp:4500` **空**、无残留进程（壳进程在分级关停 10~15s 窗口期后自清，非泄漏） |
| Gatekeeper「已损坏」根治：afterPack ad-hoc 签名 | 本地 `Signature=adhoc` + `codesign --verify --deep --strict` 通过；真机弹窗从「已损坏」降级为「无法验证」（用户实测），右键→打开一次永久通行 |
| DMG 发版链路 | v0.2.0 → v0.2.2 三个坑全修（坑 7 lint 门禁 / 坑 8 空 `CSC_LINK` / 坑 9 未签名）+ 安装窗定制，Release 页稳定出 210MB DMG + zip + blockmap |

### ② 做完但**没验证**（下一步要动的）

| 项 | 缺什么 | 谁做 |
|---|---|---|
| 窗口外壳视觉细节 | `hiddenInset` 的拖拽热区、侧栏折叠到 64px 时红绿灯（约 52px 宽）会不会略压主区 —— 顺手看一眼即可 | **你**（可选） |
| 崩溃弹窗 / 端口占用复用分支 | 代码在，没造境 | 我（等反馈） |

### ③ 没做

签名 / 公证（**配方已备好，见 §9** —— 只差 Apple Developer 账号（$99/年）+ 5 个
secrets，管道全自动；不花钱的 Homebrew cask 通道已落地）、自动更新（期 3，
缺 `latest-mac.yml` 与发布源）、Windows 签名（SignPath 开源免费待申请；未签名
NSIS + zip **已落地**，见 §10）、Linux、下载门面页
（DSH 四层做法已扒清，方案与证据见 §7，本次只记录不实施）。

### ④ 立即可做的两件小事（✅ 均已完成，2026-10-08）

```bash
# 1) 验 GUI —— 已验：窗口正常、退出后 4500 空、无残留
# 2) 出 DMG —— 已出：Release 页 v0.2.2（定制安装窗 + ad-hoc 签名）
open https://github.com/lwl2225144701-cmd/PayasoAgent/releases
```

> 产物现状：Release 页挂 v0.2.2 起的 `.dmg`（210MB）+ `.zip`（216MB）+ blockmap；
> 本地 `apps/desktop/release/mac-arm64/` 仍有编译产物可直接 `open`。

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

## 3. 十个坑（都留了证据，别再踩）

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

### 坑 7 · CI 的 `biome check .` 是**全仓**的，本地只 `--write` 改动文件必翻车

**现象**：CI 第 56–79 次连红 24 次，`v0.2.0` 的 Release 也死 —— 但本地一直"biome 干净"。

**真相**：CI 的 lint 步是 `npx biome check .`（全仓 402 文件），而本地习惯只对改动文件跑
`npx biome check --write <files>`。error 在仓库里**静默累积到 107 个**（format 67、
organizeImports 26、真 lint 14），挂的正是 `Lint & format check (Biome)` 这一步
（Release step 6 / CI step 7）。定位手法：Actions 日志要登录才看得到，但
`/actions/runs/<id>/annotations_partial` 接口匿名可取，注解自带 `#step:N:C` 步号。

**修复**（`4b2fa82`，73 文件）：自动修 93 个；手工修 14 个 —— 控制字符正则 3 处是**有意**
检测（`biome-ignore` 注明理由）、`escape` 遮蔽全局改名 `escapeText`、`forEach` 回调不再
返回值、`workspaceName` 保留为触发器依赖（不删）、拖放容器静态元素事件两处、
流程图 SVG 补 `<title>`。改完全仓对齐 CI 五步：tsc 0 错、biome exit 0、113 套件全绿、
build 过、`npm pack` 201 文件。

**教训**：**动仓库前先跑一次 `npx biome check .`（与 CI 同参）**；只对改动文件 `--write`
过的"干净"不算数 —— lint error 会跨提交累积，直到某天全仓检查一把清算。

### 坑 8 · secrets 没配 ≠ 环境变量没设：空串 `CSC_LINK` 让打包必炸

**现象**：Release 第二次跑进到 `Package DMG & ZIP` 死：`⨯ …/apps/desktop not a file`，
上一行还是 "empty password will be used for code signing" —— 明摆着进了签名流程。

**真相**：workflow 里 `CSC_LINK: ${{ secrets.CSC_LINK }}`，secret 没配时 GitHub Actions
展开成**空字符串**照样设进环境。electron-builder 的 `getCscLink` 注释自己写着
"allow to specify as empty string"，`chooseNotNull` 不判空 → 空串被当成"有证书" →
`importCertificate('')` 里 `resolveCscLinkPath('', cwd)` = `path.resolve(cwd, '')` =
**当前目录本身** → `stat().isFile()` 为假 → `<目录> not a file`。

**复现与修复都本地做了**：`CSC_LINK="" npx electron-builder --mac --dir` 一行不差复现
CI 报错（连日志顺序都一致）；`env -u CSC_LINK` 后干净走到
"skipped macOS application code signing"。

**修复**：打包步先把空的凭据变量全部 `unset`，没证书时再
`CSC_IDENTITY_AUTO_DISCOVERY=false`（明确不签名，不赌 runner 钥匙串里有什么）。
顺手给 `dist:*` 加 `--publish never`：tag 存在时 electron-builder 会"隐式发布"
（v27 移除的旧行为），而发布是 softprops 那步的活，不让它抢。

**教训**：**"secret 为空"和"env 未设"是两回事**；转发 secrets 给"空即禁用"的工具时
必须兜底 unset。识别这类 bug 的线索：报错路径是个**目录**，还说它 "not a file"。

### 坑 9 · 未签名的 app 在 Apple Silicon 上是「已损坏」，不是「未验证开发者」

**现象**：用户双击装好的 app，macOS 弹 **“PayasoAgent”已损坏，无法打开。你应该将它移到废纸篓。**
用户懵了："以前装 DMG 拖完就能用，这个怎么装不上？"

**真相**：Apple Silicon 要求每个可执行映像至少有 **ad-hoc 签名**。CI 没配苹果证书，
electron-builder 直接 `skipped macOS application code signing` —— 而打包过程改掉了
Electron 的 Resources，原有签名封条失效 → Gatekeeper 对"下载过（quarantine）+ 签名无效"
判的就是「已损坏」，**连右键→打开都不给走**（那是「未验证开发者」弹窗才有的通道）。
别人家 DMG 拖完就好，是签了 Developer ID 且做了公证。

**用户侧立刻解锁**（对任何"已损坏"的 app 都有效）：

```bash
xattr -cr /Applications/PayasoAgent.app    # 清掉下载隔离标记，再双击就能开
```

**根治**（已做，v0.2.2 起）：`scripts/after-pack.cjs`（`afterPack` 钩子）在 dmg/zip 制作前
给 .app 补 `codesign --force --deep --sign -`，签完自检 `codesign --verify --deep --strict`
（本地实测 `Signature=adhoc`、verify 通过）。弹窗降级为「无法验证开发者」，右键→打开
可通行；配了真证书（`CSC_*`）钩子自动让位。

**彻底零弹窗**：Apple Developer Program（$99/年）→ Developer ID 签名 + 公证，secrets
配进 CI 即自动生效（入口已留）。没这一步，首开永远多一步"右键→打开"。

**教训**：macOS 的"已损坏"≠文件坏了，先 `codesign -dv` 看签名；**分发 mac 软件，
签名不是可选项** —— ad-hoc 是底线，公证是及格线。

### 坑 10 · Windows 上 `spawnSync('npm', …)` 必炸：npm 是 .cmd 垫片

**现象**：v0.3.0 首个 Windows job 死在 `Prepare desktop payload`（step 8）——
`desktop:setup` 链里 `stage-backend.mjs` 调 npm 的地方失败退出。

**真相**：Windows 的 `npm` 是 `npm.cmd` 批处理垫片；Node（CVE-2024-27980 安全修复后）
**拒绝直接 spawn `.cmd` / `.bat`**（EINVAL / ENOENT），必须 `shell: true` 经 cmd.exe
调起。macOS / Linux 上 `npm` 是真可执行文件，**本地永远复现不了**。

**修复**：`stage-backend.mjs` 的 `run()` 加 `shell: process.platform === 'win32'`
（POSIX 保持直接 spawn，不留 shell 注入口）。同链的 `curl` / `tar` 是真 .exe 不受
影响（`node.exe` 的 zip 解压已用同源 bsdtar 实测通过）。

**教训**：**跨平台脚本里"调 npm"必须走 shell 或用 `npm_execpath`**。识别特征：
"CI 的 Windows 步骤挂、本地 mac 怎么跑都对"——这种"本地不可复现"优先怀疑
`.cmd` 垫片与路径分隔符，别反复怀疑业务逻辑。

## 4. 本次会话都改了哪些（别丢）

除了桌面客户端，同一轮还修了四个东西，都有各自独立的理由：

| 提交 | 改了什么 | 怎么发现的 |
|---|---|---|
| `e3aa16e` | 投影边界改成**成批推进**（`PAYASO_PROJECT_BATCH` 默认 10） | 真实 run `1538194e` 命中率在第 21 条工具结果时从 89% 塌到 20%；用请求体掉档反推出推进 2 次 vs 51 次 |
| `103de41` | **零图片会话崩溃**（读 `slots[-1].rawBytes`） | run `afd5f28a` 失败，复现脚本 3 行；来自 P0 的旧坑 |
| `b2082f9` | **缓存分桶缺失不再当成未命中**，没有可信数据就**不出数** | 14 次调用有 6 次不返回 `cacheReadTokens`；旧算法报 27%，按上报的 8 次算是 45% |
| `e081b52` | 启动时打印**生效的上下文配置** | 做 A/B 时最怕 env 没传进去却当成已生效 |
| `4b2fa82` | **全仓 biome 转绿**（107 个 error 累积），解开卡死 CI / Release 的 lint 步 | `v0.2.0` 的 Release 挂在 lint 步，抓注解定位（坑 7） |

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
| 6 | Windows / Linux | — | Windows **已落地**（NSIS + zip，§10）；Linux 待做 |

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

**签名/公证**：workflow 把 `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_*` 从 secrets 传入，
**没配 secrets 时先把空变量 `unset` 再打包**（否则空串会被 electron-builder 当证书，
把当前目录当证书文件而炸 —— 坑 8）。没证书时打的包由 `afterPack` 钩子补 **ad-hoc 签名**
（坑 9 的根治）；配了 secrets 就自动签 + 公证，钩子自觉让位。

**怎么触发**：

```bash
git tag v0.2.0 && git push origin v0.2.0   # 发版
# 或者：Actions 页面 → Release (macOS DMG) → Run workflow（只构建，不发版）
```

> ✅ **实跑记录**（2026-10-08）：workflow 跑了三次 —— 前两次各踩一个坑（第一次 lint
> 门禁坑 7，第二次空 `CSC_LINK` 坑 8），都已修；**第三次跑绿**，Release 页挂上
> `PayasoAgent-0.2.0-arm64.dmg`（210MB）+ `.zip`（216MB）+ blockmap。

## 7. 分发门面（调研结论，暂不实施）：DSH 落地页是怎么做的

用户拿 DSH 的下载页（`deepseek.com/harness`，"现在，开箱即用" + 下载 macOS 版）来问
"这种方式怎么做的"。逐层扒了页面源码与下载响应头，做法是**四层解耦**：

| 层 | 做法 | 证据（实扒） |
|---|---|---|
| ① 门面页 | `deepseek.com/harness` 只是官网一个**静态路由**（Next.js）：文案 + 截图 + 按钮，纯展示零后端 | 页面源码 34 处 `/_next/` |
| ② 稳定下载 URL | 按钮写死 `download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg` —— **"latest" 烧进文件名**，发新版 = 覆盖同名对象，页面/URL 零维护 | 按钮 href 原文 |
| ③ 对象存储扛流量 | 腾讯云 COS（`server: tencent-cos`）：`application/x-apple-diskimage`、369MB、支持 Range 断点续传 | `curl -I` 响应头 |
| ④ 应用内自动更新 | electron-updater + blockmap 增量；落地页只管"获客"，留存靠应用内更新 | app.asar 内 provider 逻辑 |

下拉箭头就是跳 `/download/` 静态页，列 mac/win 的稳定链接，同款套路。

**将来要做时的等价物**（本次不做）：

1. `release.yml` 加 2 行：给 Release 补传**稳定名副本** `PayasoAgent-latest-arm64.dmg`
2. 一个纯静态落地页（hero + 窗口截图 + 按钮 + sha256 表），GitHub Pages 免费托管
3. 按钮永远指 `https://github.com/lwl2225144701-cmd/PayasoAgent/releases/latest/download/PayasoAgent-latest-arm64.dmg`
   —— `releases/latest/download/` 语义自动指向最新 Release，发版页面零改动

> 我们没有独立下载域名/CDN，GitHub Releases 就是现成的"③ 层"；差的只是 ① 门面和
> 稳定名副本。等 GUI 验证后有了一张窗口截图，这页半小时能落地。

## 8. DMG 安装窗样式（定制背景 + 布局）

用户看腻了 macOS 默认的灰底虚线箭头，问"能不能做成单独窗口，加个背景动画啥的"。
结论分两半：

- **能**：DMG 打开时的 Finder 窗口可以整体定制 —— 背景图、图标布局、窗口大小、
  图标尺寸（`dmg:` 配置的 `background` / `contents` / `iconSize`），大厂 DMG 都这么做。
- **不能**：**背景动画做不了**。那是个 Finder 窗口，背景只吃静态图（GIF 也不播）。
  真要动画得自写安装器 app，违背 mac 拖拽安装习惯，不值。

**做出来的**：`build/dmg-background.png`（660x400，深蓝渐变 + 两侧图标位光晕 +
白色箭头 + "拖入「应用程序」即可完成安装"），布局 app(180,190) → 箭头 →
`/Applications` 链接(480,190)，图标 120px。

**源码里挖出来的两个约束**（schema 文档会误导，以 `dmg-builder/out/dmgUtil.js` 为准）：

1. 有背景图时**窗口尺寸 = 图片像素尺寸**（`sips -g pixelWidth`），配置里的
   `window.width/height` 在这条分支被忽略 → 背景图只能按 1x 画；retina 下 Finder
   放大显示，所以生成时 2x 超采样缩图保边缘。
2. `contents` 第一条**省略 `path` = 打包出的 .app**（`dmg.js`："path is required,
   when omitted, appPath is used"）；x/y 是图标**中心**、从窗口顶部往下量。

> 视觉效果要开 DMG 才能验（本地 `hdiutil` 被沙箱禁，坑 5）——由下一次 CI 构建产出。

## 9. 零弹窗（拖拽即用）的完整配方：Developer ID 签名 + 公证

用户要的是"拖进 Applications、双击直接开"的体验（现在首次还要右键授权一次）。
**macOS 对浏览器下载的 app 只认两样东西：Developer ID 签名 + 公证（notarization），
二者缺一就有弹窗，无任何免票通道**（ad-hoc 只能把「已损坏」降级成「无法验证」，坑 9；
"无法验证开发者"也一样要授权）。别人家 DMG 拖完就好 = 这两样都做了。

**门票**：Apple Developer Program，**$99/年**（个人或公司均可）。

**管道已全部就绪**（无需再写代码）：

- release.yml 已传 `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`，空值会 unset（坑 8）
- electron-builder v26 公证**纯环境变量驱动**（源码 `notarizeIfProvided` 已核实）：
  凭据齐了自动公证，`notarize: false` 是唯一显式开关（语义是"禁用"）
- `afterPack` ad-hoc 钩子检测到 `CSC_LINK` 即自动让位（after-pack.cjs）
- 真证书一到，签名 → 公证 → 出 DMG/zip 全自动，产物即"拖拽即用"

**要你做的 5 步**（拿到账号后约半小时）：

1. 注册 [Apple Developer Program](https://developer.apple.com/programs/)（$99/年）
2. 建证书：Xcode → Settings → Accounts → Manage Certificates → **Developer ID
   Application**（注意不是 "Apple Development"）；或开发者网站创建
3. 导出 `.p12`，转 base64：`base64 -i cert.p12 | pbcopy`
4. [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → 用户与访问 →
   App 专用密码，生成一个
5. GitHub 仓库 Settings → Secrets and variables → Actions，填 5 个：

| Secret | 值 |
|---|---|
| `CSC_LINK` | 第 3 步的 base64 |
| `CSC_KEY_PASSWORD` | p12 导出时设的密码 |
| `APPLE_ID` | 开发者账号邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 第 4 步的专用密码 |
| `APPLE_TEAM_ID` | Membership 页的 Team ID |

然后 `git tag v0.x.y && git push origin v0.x.y`，出来的 DMG 拖拽即用、零弹窗。

**备选（不花钱的"装完即用"）—— 已落地**：Homebrew cask。机制：brew 用 curl 下载，
**不带浏览器的 `com.apple.quarantine` 隔离标记**，Gatekeeper 无从弹窗，装完直接能开。
配方在 [`Casks/payasoagent.rb`](../../Casks/payasoagent.rb)，`release.yml` 每次发版
自动 bump 版本与 DMG 的 sha256。用法（一次 tap 永久生效）：

```bash
brew tap lwl2225144701-cmd/payasoagent https://github.com/lwl2225144701-cmd/PayasoAgent.git
brew install --cask payasoagent
```

## 10. Windows 线（2026-10-08 开工）：NSIS + zip，未签名先发

用户问"windows 有这么麻烦不"——**不麻烦**。Windows 没有 mac 那种「已损坏打不开」的
绝症，未签名也能跑（SmartScreen 蓝屏点"更多信息 → 仍要运行"即可）：

| | macOS | Windows |
|---|---|---|
| 不签名 | 「已损坏」**打不开**（坑 9） | 能跑，SmartScreen 提示可一键跳过 |
| 零弹窗 | Developer ID + 公证（$99/年） | SignPath **开源免费**（[官方实锤](https://signpath.io/solutions/open-source-community)）；或 Azure Trusted Signing ~$10/月 |

**本次落地**（发版即用，v0.3.0 起出 Windows 产物）：

1. `fetch-node.mjs`：win32 支持官方 zip + `node.exe`（tar 解 zip，Windows 10+
   自带 bsdtar）；`mv` 命令 Windows 没有 → 换 `renameSync`
2. `main.ts`：`node.exe` 路径 + **`taskkill /T /F` 树杀** —— Windows 无信号语义
   （`child.kill()` 即 TerminateProcess、只掐直接进程留孙进程），树杀连子孙一起收，
   等价 POSIX 的 SIGTERM→SIGKILL 兜底；代价是没有优雅排水窗口，靠 SQLite WAL 抗截断
3. `build/icon.ico` 静态提交（Pillow 从 `icon-512.png` 生成 16~256 七档）；
   `make-icon.mjs` 非 darwin **静默跳过**（exit 0 —— 原来 exit 1 会让 Windows CI
   的 `desktop:setup` 整个挂掉）
4. `electron-builder.yml`：`win:` nsis + zip；Node 运行时改**平台段**下发
   （平台段与全局是合并关系，`fileMatcher.js` 两段都收）；产物命名
   `PayasoAgent-x.y.z-setup.exe` / `PayasoAgent-x.y.z-x64.zip`
5. `release.yml` 新增 `build-windows`（windows-latest + Git Bash）：质量门禁留
   mac job（shell 沙箱套件是 darwin 能力），win 只出包；`WIN_CSC_*` 空值同样
   unset（坑 8 的空串陷阱 Windows 同款）
6. `.gitattributes` 统一 LF —— Windows checkout 转 CRLF 会连环炸 biome 与打包

**后续**：向 SignPath 的 Open Source 计划申请免费签名（需仓库公开、项目活跃），
批下来接 GitHub Actions，SmartScreen 提示即消。

**已知边界**：后端 shell 载体在 Windows 上走 WSL bash / PowerShell / cmd
（`shell-host.ts` 本就有 win32 分支与 ACL 沙箱），但用户项目里的 POSIX 脚本仍需
WSL / Git Bash；退出无优雅排水（taskkill 树杀），在途 run 靠 WAL 抗截断。
