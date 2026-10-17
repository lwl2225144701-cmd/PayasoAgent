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
| 窗口外壳视觉细节 | ~~`hiddenInset` 的拖拽热区~~（拖不动是坑 11，已修：`data-window-drag` 显式声明）；剩侧栏折叠到 64px 时红绿灯（约 52px 宽）会不会略压主区 —— 顺手看一眼即可 | **你**（可选） |
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

> 2026-10-18 凌晨 补：**v0.4.14 —— 顶栏按参考图对齐（红绿灯 / 折叠按钮 / 标题 / 右侧控件同一行）**。
>
> **真机反馈**（用户截图 + 参考图）：「这里没调整呢。参考这种设计」。
>
> 根因：侧栏头部靠**壳注入的 `padding-top: 40px`** 整条往下让开红绿灯 —— 于是头部
> （logo + 折叠按钮）比红绿灯低 40px，和右上角那组控件不在一条线上；收起后只剩一个
> logo（展开按钮不明显），左上角显得突兀。
>
> 修法（壳注入两个 CSS 变量，页面按它们排；**头部与主内容顶栏同高 58px**）：
> - `--sidebar-chrome-inset: 72px`：头部左侧给红绿灯让位 → 红绿灯 / 折叠按钮 / 标题 /
>   右侧控件落在同一基线；
> - `--sidebar-collapsed-width: 104px`：收起态栏宽要放得下红绿灯 + 展开按钮；收起后
>   显示明确的「展开侧栏」图标，不再只剩 logo；
> - 浏览器里没有注入 → 走 `16px` / `64px` 默认值（无红绿灯，布局照旧）。
>
> **验证**：契约锁 2 例（frontend-native-theme 15 → 17）；headless Chrome 用**与真实
> 位置一致**的假红绿灯（left 16 / top 18 / 12px 圆点，间距 21px）渲染了展开 + 收起
> 两张截图核对（截图在 `.payaso/logs/layout-topbar-*.png`）。
>
> 已知代价：新壳配**旧页面**（版本不匹配那种边界）时旧页面没有新的顶部内边距，
> logo 会贴到红绿灯上 —— 启动时的资源版本比对会弹提示，正常版本内不受影响。

> 2026-10-17 夜半 补：**v0.4.13 —— 更新弹窗改成「静默亮条目」+ 条目挪到设置右边**。
>
> **真机反馈（用户截图，当前 v0.4.10）**：「这个弹窗不用这么频繁，搞得就是强制别人更新一下。
> 检测到有新版本之后，设置右边显示新版本下载就好。」
>
> 根因：v0.4.12 之前「发现新版本 0.4.12（当前 0.4.10）」是 `dialog.showMessageBox`
> 弹的，而自动检查在 **窗口 focus / 唤醒 / 定时器** 每次都触发 → 只要没装，每次 focus
> 都重弹一次，观感就是逼人更新。
>
> 修法（两处）：
> 1. **去掉「发现新版本」对话框**：检查命中新版本时只 `pendingVersion = version` +
>    `emitStatus(available)`，等用户点侧边栏条目（`downloadNow`）才下载；
>    「已是最新版」仍只在菜单手点检查时提示，安装确认（下载完成后问是否重启）保留一次。
> 2. **条目位置按用户要求**：侧边栏底部「设置」同一行的**右侧**（设置位置不动），
>    有新版本时显示 `⬇ 新版本`，下载中显示 `⬇ 42%`（百分比只出现一次）。
>
> 验证：契约锁 1 例（desktop-update 26 → 27：源码里不许再出现「发现新版本」文案、
> `download(version)` 只允许出现在 `downloadNow` 里）；headless Chrome + mock 桥把
> 两种状态渲染成截图核对；130 套件全绿、tsc/biome 干净。
>
> 注意（给还在 0.4.10/0.4.11 的机器）：旧版本的弹窗逻辑改不了，装 0.4.13 这次仍会
> 弹一次（含可能弹一次「后端意外退出」，v0.4.12 已修）；装完之后才是静默流程。
>
> **v0.4.13 产物现状（2026-10-17 夜半，run #27，6m36s，两平台都成功）**：tag
> `v0.4.13` → `b2670b0`；七件资产齐全，feed 均 `version: 0.4.13`（mac zip
> 227110988 B / dmg 220886805 B；Windows setup.exe 181081970 B）；cask 自动 bump
> （bot 提交 `33c9ba4`，sha256 `627a04d2f23f…6d9a8db6`）。
>
> **发布产物本体复检（Range 抠包，没下 200MB）**：`app.asar` 1214772 B / 211 条目 /
> 16 依赖（含 electron-updater）；`coordinator.js` **已无「发现新版本」文案**、
> 有 `pendingVersion`/`downloadNow`；`main.js`/`preload.cjs` 的 ipc 桥都在；再把页面包
> `app/web/dist/assets/index-Cea-aoj-.js`（558083 B）抠出来确认「新版本」「正在下载」
> 文案与 `shell.update.*` key 都在 —— 发出去的壳和页面都是 v0.4.13 版。
>
> 已知未做：顶栏「红绿灯行」的重排（用户发的参考图那一块）还没动 —— 需要用户先确认
> 具体要哪种（只对齐折叠按钮 / 折叠按钮挪到红绿灯同一行 / 连窗口材质一起）。

> 2026-10-17 深夜 补：**v0.4.12 —— 装更新时的误报弹窗 + 下载进度可见**（两条真机反馈）。
>
> **现象 1（误报）**：自更新装完后弹「PayasoAgent 后端意外退出 / code=0 signal=null」。
> 根因：安装交接先 `stopBackend()`（后端收到 SIGTERM 优雅退出 → code 0 signal null），
> 而 exit 处理器只看 `quitting` / `ownsBackend` —— 装更新时 `quitting` 还是 false，
> 于是把**我们自己发起的关停**当成崩溃。修法：加 `stoppingIntentionally` 标记
> （`stopBackend()` 置位、`startBackend()` 复位），exit 处理器跳过它；真崩溃仍然报。
>
> **现象 2（看不到进度）**：「点检查更新，下载的时候整个界面没有一个地方能看到下载进度」。
> 修法：**页内**在侧边栏「设置」上方加一条更新条目（不是额外窗口）——
> - 发现新版本：`⬇ 新版本 v0.4.12`（可点，点了开始下载）；
> - 下载中：`⬇ 正在下载 v0.4.12 … 42%` + 底部细进度条（百分比按 download-progress 实时更新）；
> - 链路：coordinator `onStatus` → `main.ts` `webContents.send('payaso:updateStatus')`
>   → preload 桥 `onUpdateStatus` → `web/src/update-status.ts` 归一化（非法值退化成 idle，
>   百分比夹紧）→ `UpdateStatusRow` 渲染；页面刷新后 `did-finish-load` 补发最后一条状态。
> - 浏览器里没有桥 → 条目永不出现；老壳没有新方法 → 同样安静降级（桥方法全可选）。
> - Dock / 任务栏进度条保留作兜底（条目所在的侧边栏折叠时也还有地方看）。
> - 「发现新版本」的原生提示框**保留**（用户已知的行为不动），条目是常驻的第二入口：
>   点了「稍后」之后仍可从侧边栏再下。
>
> 验证：契约锁 3 例（desktop-update 23 → 26：状态构造与夹紧、`isUpdateStatus`、页面侧
> 归一化、coordinator 三个推送点、ipc 通道与 preload 对齐、侧边栏条目与 i18n key）；
> **headless Chrome + mock 桥把 available / downloading 两种状态都渲染成截图核对过**
> （不是猜样式）；本地打包自检 asar 211 条目 / 16 依赖通过；130 套件全绿、tsc/biome 干净。
>
> **v0.4.12 产物现状（2026-10-17 深夜，run #26，6m56s，两平台都成功）**：tag `v0.4.12`
> → `6ed9028`；七件资产齐全，feed 均 `version: 0.4.12`（mac zip 227111128 B / dmg
> 220887005 B）；cask 自动 bump（bot 提交 `e4e3f98`，sha256 `7af1b0ddbcab…20ec4b`）。
>
> **发布产物本体复检（HTTP Range，没下 200MB）**：从 Release 的 mac zip 里抠出
> `app.asar`（1214994 B / **211 条目** / 16 依赖含 electron-updater）逐个核：
> `coordinator.js` 有 `availableStatus/downloadingStatus/downloadNow`、`main.js` 有
> `payaso:updateStatus` / `payaso:updateDownload` / `stoppingIntentionally`、
> `preload.cjs` 两个桥方法都在；再把 extraResources 里的页面包
> `app/web/dist/assets/index-D4Q89OFu.js`（558479 B）抠出来 —— 「新版本 v」「正在下载 v」
> 文案与 `shell.update.downloading` key 都在。**发出去的壳和页面都是 v0.4.12 版**。
>
> 已知小限制（未挡发布）：页面**刷新**的那一瞬间，主进程在 `did-finish-load` 发的最后一条
> 状态可能早于 React 订阅（`ipcRenderer.on` 未注册就丢了），表现为「available 条目刷一下
> 消失」，下次检查/窗口 focus 会补回来。下版改成 preload 里缓存最后一条、订阅时补发。

> 2026-10-17 夜 补：**v0.4.11 —— 后台检查更新失败不该弹窗**（v0.4.10 真机截图）。
>
> **现象**：用户装好 v0.4.10 正常用（顺带证明「装完起不来」已修），但合盖唤醒后弹了一个
> 原生对话框：「检查更新失败：网络不可用 / `net::ERR_NETWORK_IO_SUSPENDED`」。
>
> **是不是我们弹的？是。** 链路：`powerMonitor.on('resume')` / 窗口 focus / 定时器都会
> 触发**后台**检查（`runCheck(false)`）→ 唤醒瞬间 macOS 挂起网络 I/O → electron-updater
> 抛 `net::ERR_NETWORK_IO_SUSPENDED` → 旧代码 `catch` 里**无条件** `reportFailure`
> （内部就是 `dialog.showMessageBox`）→ 用户什么都没点却被弹窗。
>
> **修法（两处）**：
> 1. `runCheck` 的 catch 分叉：`interactive`（菜单手点）才 `reportFailure`；后台只
>    `log(...)` 并走原有指数退避重试 —— **后台失败永远不打扰用户**；
> 2. 唤醒补查推迟 `RESUME_CHECK_DELAY_MS = 5_000`（唤醒瞬间查必失败），重复唤醒只留
>    一个待跑，`dispose` 清定时器。
>
> 契约锁 1 例（`tests/desktop-update.test.ts` 19 → 20）：后台失败不许走 reportFailure、
> 唤醒补查必须有延迟常量与定时器清理；`isNetworkFailure` 补上这条真机错误串。
>
> **v0.4.11 产物现状（2026-10-17 夜，run #25，6m28s，两平台都成功）**：tag
> `v0.4.11` → `383b860`；七件资产齐全，feed 均 `version: 0.4.11`（mac zip
> 227108063 B / dmg 220887640 B）；cask 自动 bump（bot 提交 `7e21b39`，
> sha256 `fb3339254543…05621d`）。
>
> **发布包本体复检（这次没下 200MB）**：用 HTTP Range 从 Release 的 mac zip 里
> 直接抠 `app.asar`（zip 是 store 不压缩 → 只取中央目录 + 目标条目）→ 按 asar 格式
> 取出 `dist/update/coordinator.js`（12609 B）→ 三条都在：`RESUME_CHECK_DELAY_MS =
> 5_000`、`check failed (auto`、`if (interactive) await reportFailure('check', error)`；
> asar 仍是 210 条目 / 16 依赖（含 electron-updater）。**发出去的就是修复版代码**。
>
> 自更新的真机 E2E 还是第一次：mac 侧 Squirrel.Mac 对**签名**有要求（我们是 ad-hoc
> 签名），所以「检查→下载→重启安装」若在安装步报错属预期风险 —— 代码里已有回滚
> （失败会重新拉起后端，壳不会晾死），兜底是手动装 dmg / `brew upgrade --cask payasoagent`。

> 2026-10-17 晚 补：**v0.4.8 / v0.4.9 装完起不来 —— 发布包漏打运行时依赖**（用户实装复现）。
>
> **现象**：安装 v0.4.9 后一启动就弹 Electron 主进程错误框：
> `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'electron-updater' imported from`
> `/Applications/PayasoAgent.app/Contents/Resources/app.asar/dist/update/coordinator.js`，
> 点「好」壳直接退出。
>
> **根因**（我引入的；v0.4.8 起就有）：`electron-builder.yml` 的 `files:` 里有一条
> `- "!node_modules/**"`。`files` 里的 `!` 模式会被 electron-builder 当作**生产依赖也
> 一并排除**的规则交给 node_modules 复制器（`app-builder-lib/out/fileMatcher.js`
> `getNodeModuleFileMatcher` 只收 exclude；devDependencies 本来就不会进包），于是
> `electron-updater` 及其 15 个依赖（fs-extra / builder-util-runtime / js-yaml / semver…）
> 全被排除。实测坏包 `app.asar`：**6 个条目、0 个 node_modules**；而 `main.js` 静态
> `import` 了协调器 → 模块加载期就抛，连窗口都到不了。**v0.4.8 同配置、同样坏**，
> 只是之前没人在真机上装过。
>
> **修法**（两道防线，铁律：**打包成功 ≠ 能启动**）：
> 1. 删掉那条排除（`files` 只留 `dist/**/*` + `!**/*.map`）—— 包内实测 **16 个依赖**，
>    `app.asar` 从 0.04 MB → 1.15 MB；
> 2. 新增 `apps/desktop/scripts/verify-package.mjs`：**按产物体检**而不是按配置猜 ——
>    ① `dist/` 每个文件都在 asar 里；② `dist/` 里所有裸 import（含 `electron-updater`）
>    在 asar 的 `node_modules` 里真实存在；③ `--require-feed` 时 `app-update.yml` 必须在
>    且 provider 是 github。三个打包入口（`dist:mac` / `dist:dmg` / `dist:win`）都串上它，
>    dmg/win 带 `--require-feed` —— **CI 两个平台在打包后就卡，坏包既不会上传也不会发 Release**。
>
> **验证证据（本地实测，非推测）**：
> - 修好的包：`verify-package.mjs` 通过（16 个依赖，含 electron-updater）；
> - 用户装的坏包：同一脚本对着 `/Applications/PayasoAgent.app` 跑，**精确报红**
>   「asar 里缺少依赖 electron-updater（被 dist/update/coordinator.js 引用）」；
> - 用 Electron 自己的二进制在 asar 内解析：
>   `createRequire('…/app.asar/dist/main.js').resolve('electron-updater')` →
>   命中包内 `node_modules/electron-updater/out/main.js`；
> - 真跑打包好的 .app（`PORT=4599` 隔离）：主进程走到 Chromium 初始化，
>   **JS / 模块错误 0 条**（`grep ERR_MODULE_NOT_FOUND` = 0）；再往下被本机沙箱挡住
>   （Chromium 自带沙箱 `sandbox initialization failed: Operation not permitted`，与包无关）。
> - 契约锁 2 例（`tests/desktop-update.test.ts` 17 → 19）：**`files` 段不得排除
>   node_modules**、**每个 dist 入口必须串 verify-package**（并锁 electron-updater 在
>   `dependencies` 而不是 devDependencies）。
>
> **给用户的动作**：v0.4.8 / v0.4.9 无法自更新（壳起不来），只能重新下载安装；
> 修复版 = `v0.4.10`。坏版本已从 Releases 清掉（同 v0.4.7 的手法：删 tag）。
>
> **v0.4.10 产物现状（2026-10-17 晚，run #24，6m23s，两平台都成功）**：
> `git ls-remote` tag `v0.4.10` → `864b5d0`（在 main 上）；七件资产齐全（`curl -sIL`
> 逐个验过）：mac `arm64.dmg` 220886941 B + `arm64-mac.zip` 227107663 B（blockmap
> 236874 B）；Windows `setup.exe` 181078781 B + `x64.zip`；两个 feed 都是
> `version: 0.4.10`。cask 自动 bump（bot 提交 `1ef3134`，sha256
> `3c1818ac6ef5…fcf3bed783`）。
>
> **发布产物本体复检**（关键是这条 —— 不是只看"文件在不在"）：把 Release 里的 mac
> zip 实下来（227107663 B，与 feed 的 size 一致）→ 解出 `Contents/Resources/app.asar`
> （**1206610 B / 210 个条目**）→ `node scripts/verify-package.mjs --app …/PayasoAgent.app
> --require-feed` → **通过**：16 个依赖含 electron-updater、`app-update.yml`
> provider=github。Windows 侧同款门禁在 CI 里跑（`dist:win` 自带 `--require-feed`），
> job 成功即已过 —— 两个平台都拿到了"发出去的包能加载依赖"的实证。
>
> 清坏版本复核：`git ls-remote --tags` 只剩 `v0.4.10`；`/releases/tag/v0.4.8`、
> `/releases/tag/v0.4.9` 均 **404**；`v0.4.10` 页面与 DMG 仍 200。
>
> 2026-10-17 补：**统一发布（原子发布）＋ Windows「打开终端」真机 bug**。
>
> **③ 事故与修复（v0.4.9 第一次跑）：两个 job 3~4 秒就失败**，run 总时长 12s，
> 两个 job 的注解都是
> `The specified node version file at …/.nvmrc does not exist`。
> 一度以为是 `.nvmrc` 被删了 —— 不是：远端 `raw.githubusercontent.com/…/v0.4.9/.nvmrc`
> 返回 200、`HEAD` 树里也在。真因是**我上面 ① 重组 workflow 的副作用**：我用"按
> 步骤名重建"的方式生成新文件，而两个 build job 的第一条是**没有 `- name:` 的**
> `- uses: actions/checkout@v4`（`publish` 里那条是我手写的所以留下了）—— 在没有
> 源码的工作区里 `setup-node` 读 `node-version-file` 自然失败。
> 修法：把 checkout 补回两个 job（`2018785`），并加两道契约锁（`tests/desktop-update.test.ts`
> 现在 17 例）：**每个 job 第一步必须是 `actions/checkout`**；**建 Release 的动作只
> 允许出现在 `publish` job，且其 `needs` 必须同时依赖两个平台**。
> 处理方式：`v0.4.9` tag 重新指向修复提交（`git push origin --delete v0.4.9` +
> `git tag -f v0.4.9 2018785` + 推）重新触发流水线；此时 v0.4.9 尚无任何 Release，
> 所以不存在需要清理的残留。
> 教训：**workflow 这种"没有类型检查的关键脚本"，改完必须用能识别无 name 步骤的
> 方式核对**（这次就是靠"每 job 首步必须 checkout"的套件锁把它钉住）。
>
> **① 统一发布 → 当天撤回，改回"各自发布"**（用户决策，2026-10-17 晚）：原子发布
> 的第一版（`publish` job `needs` 两个平台）确实能挡住"只有 Windows 的半成品"，
> 但实测代价太高——v0.4.9 跑了两次都没出 Release（第一次我漏了 checkout 3 秒挂；
> 第二次 6m40s 失败，且**成功那个平台的资产也一并被扣住看不见**），发布节奏被
> 拖死。用户明确："何在一起这么难发布，那就分开"。
> **现状 = 回滚到 v0.4.8 那个已验证的版本**（`git checkout f4e2c18 -- .github/workflows/release.yml`，
> 与该版本逐字节一致）：两个 job **各自发布自己的平台资产**，互不依赖、互不阻塞；
> 重试 = Actions 里 "Re-run failed jobs"。保留的改进：每平台自己的 feed 门禁
> （解包目录用 glob）、`latest*.yml` 进上传清单、发布/tag 触发条件。
> 明确接受的代价：**可能再次出现只含单平台的 release**（v0.4.7 那种）—— 分开走的
> 必然结果，靠"重跑失败的那一半"收尾。
> 契约锁（`tests/desktop-update.test.ts` 17 例）相应改成：**每个 job 第一步必须是
> `actions/checkout`**（v0.4.9 首败的真因）、**每个 job 自己发、只发本平台文件、
> 只认本平台 feed、不含跨平台 download-artifact**（分开走的定义）。
>
> **原始方案（未采用）**：Windows 与 macOS 同一版本的完整发布，不接受
> "只有 Windows"的半成品 —— v0.4.7 就是这么来的）。`.github/workflows/release.yml`
> 曾计划重组为三个 job（已撤回，保留作记录）：
> - `build-macos-dmg` / `build-windows`：只**产出 artifact**（feed 门禁移回上传
>   **之前**：这一版坏了连 artifact 都不产出），各自产出 `outputs.version`；
> - `publish`：`needs: [build-macos-dmg, build-windows]` → 下载两边 artifact →
>   **Verify unified asset set**（两个安装包 + 两个 feed 都在，且 `latest-mac.yml`
>   / `latest.yml` 的 `version` 都等于 tag 版本）→ 建 Release → bump cask。
>   任一平台失败 → 这个 job 根本不跑 → **不存在半成品 Release**，cask 也不会指向
>   缺平台的版本；cask 的 `sed -i` 也从 BSD 写法改成 GNU（新 job 跑在 ubuntu）。
>
> **② Windows「打开终端」真机 bug**：点开工作区/目录的"终端"后弹出一个黑窗口加
> 一行 `[出现错误 2147942405 (0x80070005) (启动"D:\Iragent"时)]`。根因：catalog 把
> Windows 终端解析成 `wt.exe`，而启动代码是 `spawn(exe, [target], {cwd: target})`
> → 实际执行 `wt.exe D:\Iragent`，**Windows Terminal 把裸路径当成"要启动的程序"**
> 于是报 E_ACCESSDENIED。修法（`src/host/open-in-app/invocation.ts`，纯函数）：
> `wt.exe` → `['-d', dir]`；`cmd.exe` → 不带参（落点由 cwd 决定）；其余应用参数仍
> 是目标本身。顺带修掉一个隐患：原来文件目标会把 **cwd 设成文件路径**（不是目录，
> 进程起不来）→ 现在 cwd 一律取"目录目标本身 / 文件目标的父目录"。
> 套件 14 例锁死这些推导（含真机那条 `wt.exe` 不许收到裸目录路径）；写测试时还
> 暴露了实现里的平台依赖：用宿主默认的 `path.basename` 解析 `D:\...` 在 macOS 上
> 认不出来 → 改为按目标平台选 `path.win32`/`path.posix`（否则"能跑但测不了"）。

> 产物现状（2026-10-16，**v0.4.8 已发布**）：tag `v0.4.8` → `b16604d`，**六件齐全
> 且 feed 在 Release 里**（`curl -sIL`）：mac `arm64.dmg` 210.4 MiB（220579607 B）
> + `arm64-mac.zip` 216.3 MiB（226847447 B）；Windows `setup.exe` 172.5 MiB
> （180881230 B）+ `x64.zip` 234.6 MiB（246028604 B）；**`latest-mac.yml` 517 B +
> `latest.yml` 351 B**。cask 自动 bump 到 0.4.8（bot 提交 `54a371a`），sha256
> `ca4aa55bbd50…cf4`（与 DMG 一致）→ mac job 连 cask 步骤都跑完了。
>
> feed 内容（真产物，非推测）：
> ```yaml
> # latest-mac.yml（mac：zip 与 dmg 两条都在，path 指 zip —— 更新走 zip）
> version: 0.4.8
> files: [ {url: PayasoAgent-0.4.8-arm64-mac.zip, sha512, size: 226847447},
>          {url: PayasoAgent-0.4.8-arm64.dmg,      sha512, size: 220579607} ]
> path: PayasoAgent-0.4.8-arm64-mac.zip
> # latest.yml（Windows：NSIS 安装器；无 blockMapSize 属正常 —— 那是 web 安装器字段，
> # 缺它只是退化成整包下载）
> version: 0.4.8
> files: [ {url: PayasoAgent-0.4.8-setup.exe, sha512, size: 180881230} ]
> path: PayasoAgent-0.4.8-setup.exe
> ```
>
> 与 v0.4.7 的关系：**v0.4.7 是半成品**（见下），本版是它的修复重发。
>
> 产物现状（2026-10-16，**v0.4.7 半成品：只有 Windows**）：tag `v0.4.7` → `b0e87c7`。
> Windows 侧完好且**带 feed**：`setup.exe` 172.5 MiB（180880879 B）+ `x64.zip`
> 234.6 MiB（246028613 B）+ `latest.yml` 351 B；**mac 侧一小时后仍无任何资产**，
> cask 因此停在 0.4.6（brew 没被指向坏版本，这点是设计使然：cask 步骤在 mac job 里、
> 排在门禁之后）。判断：mac job 挂在**打包阶段**（DMG 目标；本机复现过那个 DMG
> 步骤失败：`hdiutil: create failed - 操作不被允许`，本机沙箱不给 hdiutil，CI 上是
> 同类依赖的抖动），而我把 feed 门禁放在「上传前」，于是"打包挂了"被放大成"一个
> 资产都没有"。读不到 CI 日志（GitHub API 对本出口 IP 限流 403、机器上无 `gh`；
> main 上 `ci.yml` 是 passing，故 tsc/biome/test:all 不是原因）。处置：门禁挪到发布
> 之后 + 目录名 glob + 失败打印现场（`b16604d`）。
>
> **已按用户要求删除**（"不要分开发"）：`git push origin --delete v0.4.7`（本仓库
> 的既定手法，不需要 token）→ 复核结果：`/releases/tag/v0.4.7` **404**、
> `setup.exe` / `x64.zip` / `latest.yml` 三个资产全 **404**、`releases.atom` 里
> 不再列 0.4.7；历史链接里可能还残留 `expanded_assets/v0.4.7` 这个片段的缓存
> （200），但里面的资产已经拿不到。并已改成**原子发布**（见上面 2026-10-17 那段），
> 从机制上不再产生这种半成品。

> ### 期 3 落地：检查更新 / 自更新（2026-10-16，v0.4.7）
>
> 方案见 [`auto-update-调研报告.md`](./auto-update-调研报告.md) §5；**链路 A 全做，
> 链路 B（服务端强制更新策略）不做** —— 本仓库没有策略服务，硬造一个只会多一套
> 没人维护的设施。
>
> 交付：
> - `apps/desktop/src/update/policy.ts`（纯逻辑）：版本解析/比较（预发布版恒小于
>   同号正式版）、`isNewerVersion` 门禁、指数退避 + ±20% jitter、网络类错误识别
>   与人话文案；
> - `apps/desktop/src/update/tasks.ts`：`GET /runs` 里"在跑"任务的判定（与 Host
>   `isCancellable()` 逐状态对齐，套件锁死两份一致）；
> - `apps/desktop/src/update/coordinator.ts`：autoUpdater 包装 ——
>   `autoDownload=false` / `autoInstallOnAppQuit=false` / `allowDowngrade=false`、
>   挂 `error` 监听（不挂会让 EventEmitter 直接抛）、检查单飞、任务栏进度、
>   开发版门禁（`app.isPackaged && app-update.yml` 存在）；
> - `main.ts`：菜单「检查更新…」、boot 里 `startAutoCheck()`（启动 +20s 首查、
>   10min 轮询、窗口 focus / 睡眠唤醒补查）、`listActiveTasks()` 直接
>   `fetch(/runs)`（后端零改动）、`before-quit` 在后端已停时不 preventDefault
>   （别拖住 quitAndInstall 的替换）；
> - `electron-builder.yml`：`publish: github`（owner/repo/releaseType: release）
>   → 生成包内 `Resources/app-update.yml` 与输出目录的 `latest-mac.yml`；
> - `release.yml`：两个 job 都新增 **Verify updater feed** 硬门禁（缺
>   `app-update.yml` 或 `latest*.yml` 直接失败），并把 `latest*.yml` 加进
>   artifact 与 Release 上传清单。
>
> 本地实证（`electron-builder --mac zip`，`--config.electronDist=node_modules/electron/dist`
> 绕开 Electron 下载）：
> ```
> Resources/app-update.yml: provider: github / owner / repo / releaseType: release /
>                           updaterCacheDirName: '@payasodesktop-updater'
> latest-mac.yml:           version / files[url,sha512,size] / path / releaseDate
> ```
> `latest-mac.yml` 不带 `blockMapSize` 属正常：那个字段只有 **NSIS**（Windows 差分
> 下载）用（`electron-updater/out/NsisUpdater.js`）；mac 侧靠整包 zip。
>
> 本地打包当场抓到一个配置错误：`updaterCacheDirName` 在 electron-builder 26 里
> **不是根级属性**（schema 直接拒），且即使放进 publish 也会被忽略 ——
> appInfo 从包名派生（`@payaso/desktop` → `@payasodesktop-updater`）。已删配置 + 注释。
>
> 验证节奏（重要）：**自更新要两个版本才验得完** —— v0.4.7 / v0.4.8 都自带 updater
> 与 feed，装 0.4.7 再等 0.4.8 出来才看得到"发现新版本"（0.4.7 自己查只会说"已是最新版"）。
> CI 侧已验完（v0.4.8 的六件产物 + 两个 feed 都在 Release 里，内容核对过：见下面
> 产物现状）。**剩下的只有真机**：菜单「检查更新…」→ 无更新提示 / 有更新 → 下载
> （任务栏进度）→ 安装确认（有任务时警告并列出会打断什么）→ 重启后版本号变化；
> 未公证的 mac 包首次安装仍需"右键 → 打开"。
>
> 已知取舍：更新 UI 用原生对话框（DSH 是独立 HTML 窗口 + 强制更新全屏窗）；没有
> 遥测/journal；`update-tasks: lock` 准入锁未做（确认到停后端只有几百毫秒）；
> 未签名包的自更新在 macOS 上依赖 Squirrel 替换 .app（DSH nightly 同款做法）。

> 产物现状（2026-10-16，**v0.4.6 已发布**）：tag `v0.4.6` → `a086d82`（窗口按钮
> 让位改由壳注入，见下），四件套实测：mac `arm64.dmg` 210.4 MiB（220585425 B）
> + `arm64-mac.zip` 216.3 MiB（226840464 B）；Windows `setup.exe` 172.5 MiB
> （180875041 B）+ `x64.zip` 234.6 MiB（246022217 B）。cask 自动 bump 到 0.4.6
> （bot 提交 `d916e23`），sha256 `bf03b4401853…b95`（与 DMG 一致）。
>
> 真机现象（v0.4.5）：顶栏右侧的状态胶囊「运行中」被窗口按钮**硬切掉** —— 截图
> 里胶囊的右圆角断在叠加层边界上。让位原本挂在**页面侧**（需要页面 CSS 里那条
> `:root[data-shell-platform="win32"] .bar` + `<html data-shell-platform>` 两样都在），
> 而页面是不是壳自带那一版，我远距离无法分辨（复用了 4500 上旧后端、或 preload
> 没拿到 platform，都会让这条静默失效）。结论：**窗口几何不该由页面负责**。
>
> 改成壳注入（与 macOS 红绿灯那条让位同源）：
> - `dom-ready` 注 `WCO_RESERVE_SCRIPT`：用 `navigator.windowControlsOverlay
>   .getTitlebarAreaRect()` 量按钮区宽度写进 `--wco-reserve`（量不到兜底 138px = 46×3）
> - `dom-ready` 注 `WCO_RESERVE_CSS`：只命中主栏顶栏
>   `#root > :first-child > :not(aside) > [data-window-drag]`（侧栏那个同名标记在
>   `aside` 里，不会误伤），`padding-right: calc(var(--wco-reserve, 138px) + 14px)`
> - 删掉页面侧那一份（ShellBar 的规则、`main.tsx` 的 dataset、preload/vite-env 的
>   `platform`）—— 一套真值源
>
> 验证：真 Chromium（Chrome headless 注入同一份 CSS/脚本）实测 `barPaddingRight
> = 152px`（138+14）、侧栏 `logoPaddingRight = 0px`；仓库级门禁 biome 0 / tsc 0 /
> 桌面壳 tsc 0 / 129 套件全绿。
>
> **这一版要在 Windows 上验的**：① 「运行中」胶囊完整显示、不再被按钮切；
> ② 预览胶囊 / 侧栏开关也都完整；③ 拖拽、双击最大化、三个按钮照旧可用。

> 产物现状（2026-10-16，**v0.4.5 已发布**）：tag `v0.4.5` → `bc3c363`（并进 main 的
> 合并提交 `29eaa8a`），唯一改动是设置页「Shell 隔离」文案定稿（见下）。
> 四件套实测：mac `arm64.dmg` 210.4 MiB（220607519 B）+ `arm64-mac.zip`
> 216.3 MiB（226840147 B）；Windows `setup.exe` 172.5 MiB（180874698 B）+
> `x64.zip` 234.6 MiB（246021931 B）。cask 自动 bump 到 0.4.5（bot 提交
> `5421141`），sha256 `14f73c988939…710`（与 DMG 一致）。
>
> 定稿文案（一行，不放 hover、不展示实现细节 —— 设置页不是文档）：
> `full` =「读写与网络边界由操作系统沙箱强制执行」；`partial`（Windows ACL）
> =「仅写入受限；读取与网络不受限」；`none` =「无系统级沙箱，shell 默认拒绝」。
> 中间那一版 v0.4.4（`6b4c80e`，把 full 短句压缩 + 细节挂 hover）已被本版取代，
> 体积记录：dmg 220601214 / zip 226840305 / exe 180874674 / x64 246022053，
> cask sha256 `c2ce929671b4…d04`。

> 产物现状（2026-10-16，**v0.4.3 已发布**）：tag `v0.4.3` → `a39b16c`
> （壳自己盯页面主题 + 界面资源版本校验，见下一段），四件套实测：mac
> `arm64.dmg` 210.4 MiB（220600526 B）+ `arm64-mac.zip` 216.3 MiB（226840486 B）；
> Windows `setup.exe` 172.5 MiB（180874949 B）+ `x64.zip` 234.6 MiB（246022288 B）。
> cask 自动 bump 到 0.4.3（bot 提交 `92d73ee`），sha256
> `e62beeed60db…07e`（与 DMG 一致）。
>
> **这一版要在 Windows 上验的**：① 右上角那块白消失（应跟顶栏同色，深色主题下
> 是深色；三个窗口按钮符号色对比正常）；② 顶栏右侧的预览胶囊/侧栏开关重新出现
> （不再被窗口按钮压住）；③ 深色/浅色/跟随系统三种设置下顶栏与按钮都跟着变；
> ④ 若弹出「界面资源不匹配」警告 —— 说明机器上还开着旧版后端，关掉它再重启。
> **注意**：一定要跑这一版自带的界面（装 v0.4.3 安装包，或重新 `desktop:setup`）；
> 壳复用 4500 上旧后端时，旧页面本身不会跟着变。

> 2026-10-16 三补：**右上角那块白**（v0.4.2 真机截图）。
>
> 现象：v0.4.2 上去掉系统标题栏后，右上角剩一块 58px 高的白色矩形（只有窗口
> 三个按钮），页面其余部分深色。
>
> 取证（截图逐像素）：
> - 那块白 = `(245,247,251)` = 我们自己的**浅色** palette `#f5f7fb` —— 说明
>   overlay 的 `color` 生效了（系统默认色是 `COLOR_BTNFACE`，不是这个值），
>   只是停在**创建时**那一份（那时 `themeSource` 还是 `system`、系统是浅色）。
> - 高度 73 设备像素 ÷ 1.25 DPR ≈ 58 ✓ 就是 `WINDOW_CHROME_HEIGHT`。
> - 顶栏右侧的预览胶囊/侧栏开关**消失了**（该区域只有 4 种颜色，旧截图同区域
>   304 种）→ v0.4.2 的 `env(titlebar-area-*)` 让位 CSS 没生效，按钮被 overlay
>   盖住了。
>
> 结论：**壳是新的、页面是旧的**。两条都指向"服务端吐的不是这一版界面"：
> 旧页面既没有 v0.4.1 的主题上报（所以叠加层颜色没人刷），也没有 v0.4.2 的让位
> CSS。而壳复用 4500 上已有后端时只探 `/workspace` 通不通（`backendResponds`），
> **完全不看版本** —— 只要机器上还留着旧版 `npm run host`（或旧 `.stage/app`），
> 就会静默拼出"新壳 + 旧界面"。
>
> 修法（三件，v0.4.3）：
> 1. **壳自己盯页面主题**：`did-finish-load` 注入 `THEME_WATCH_SCRIPT` —— 读
>    `<html data-theme/data-theme-mode>`，MutationObserver 跟随。页面主题是唯一
>    真值源，壳自己看就不受页面版本影响（旧页面也会写这两个属性）。主动上报
>    仍保留（快路径），主进程按 `模式+解析值` 去重。
> 2. **版本不一致要喊**：`warnIfBackendMismatch` 拿 4500 上 `GET /` 引用的哈希
>    资源名，跟壳自带 `web/dist/index.html` 对一下，不一致就弹窗说明"界面资源
>    不是客户端自带的这一份，多半是旧后端还开着"（继续 / 退出）。
> 3. **让位宽度加兜底**：`max(138px, <env 计算>) + 14px` —— 三个标题栏按钮在
>    DIP 下恒为 46×3，`env()` 万一不生效也不会让按钮压住页面元素。
>
> 另：桥的 `setNativeTheme` 改成 `(mode, resolved)` 两参：壳按解析值直接刷
> overlay，不再依赖 `shouldUseDarkColors`（实测它赋值后是同步的，但少一个假设）。

> 产物现状（2026-10-16，**v0.4.2 已发布**）：tag `v0.4.2` → `b411560`
> （去掉 Windows 系统标题栏，见下一段），四件套实测：mac `arm64.dmg` 210.4 MiB
> （220588948 B）+ `arm64-mac.zip` 216.3 MiB（226839030 B）；Windows `setup.exe`
> 172.5 MiB（180873592 B）+ `x64.zip` 234.6 MiB（246020904 B）。cask 自动 bump
> 到 0.4.2（bot 提交 `6793d41`），sha256 `af7c93d78481…1a1`（与 DMG 一致）。
>
> **这一版要在 Windows 上验的**：① 顶上一条必须是**页面自己的深色顶栏**，不再有
> 系统 caption / 菜单栏的白带（深色、浅色、跟随系统三种设置都试）；② 顶栏空白处
> 拖得动窗口、双击能最大化；③ 右上角最小化/最大化/关闭三个按钮能点，且它们在
> 深色下是浅色符号、浅色下是深色符号；④ 预览胶囊/侧栏开关没被窗口按钮压住；
> ⑤ 按 Alt 能唤出菜单栏（验证完可以按 Esc）。

> 2026-10-16 再补：**Windows 干脆不要系统标题栏**（v0.4.1 那版不够，真机反馈
> "还是有大白边"）。
>
> v0.4.1 只修了一半，源码级原因：**系统标题栏（caption）是 DWM 画的，应用侧没有
> 开关** —— Chromium 只在带 DWM backdrop 的窗口上才设
> `DWMWA_USE_IMMERSIVE_DARK_MODE`（`ui/views/widget/desktop_aura/
> desktop_window_tree_host_win.cc` 的 `UpdateBackdropColorMode()`，开头就是
> `if (!ShouldAddDWMBackdrop()) return;`），Electron 只在 `SetBackgroundMaterial`
> 里碰 `DWMWA_CAPTION_COLOR`。`nativeTheme.themeSource` 能改的只有 Chromium
> 自己画的东西（菜单/原生控件）。所以深色主题下永远剩一条浅色 caption。
>
> 修法 = DSH 的做法（`lib/main.js` win32 分支源码为证）：
> `titleBarStyle: "hidden"` + `titleBarOverlay: { height: 40, color, symbolColor }`，
> 主题色经 `windowsAppearance` IPC 用 `setTitleBarOverlay({color, symbolColor})`
> 回刷。我们照抄：
> - `main.ts`：win32 分支 hidden + overlay（高度 = 前端 `--topbar-height` 58px，
>   `WINDOW_CHROME_HEIGHT` 与它对齐，有套件锁）；配色 `windowChromePalette()`
>   只认「设置里的主题」；`registerNativeTheme` 里 themeSource 与 overlay 颜色
>   **一起刷**；win32 另加 `setAutoHideMenuBar(true)` —— 系统菜单栏同样是
>   `GetSysColor` 画的浅色带（Alt 仍可调出）。
> - `preload.cts` 暴露 `platform` → `main.tsx` 首帧前写
>   `<html data-shell-platform>` → `ShellBar.module.css` 用
>   `env(titlebar-area-x/width)` 把窗口按钮那一块宽度让出来
>   （Electron 的 overlay `color` 只画按钮区，见 `set_overlay_button_color`，
>   不覆盖页面内容）。
>
> 这样 Windows 上一条浅色原生带都不剩：顶栏就是页面自己的那一条（拖拽面靠
> `[data-window-drag]`，与 macOS 同一套机制）。**仍需 Windows 真机验收的点**：
> 拖拽/双击最大化、窗口按钮可用、浅色主题下按钮符号色对比度、Alt 唤出菜单。

> 产物现状（2026-10-16，**v0.4.1 已发布**）：tag `v0.4.1` → `d216b58`
> （唯一改动：原生 chrome 跟随页面主题，见下一段），CI 四件套实测（`curl -sIL`
> 取 content-length）：mac `PayasoAgent-0.4.1-arm64.dmg` 210.4 MiB（220585952 B）
> + `PayasoAgent-0.4.1-arm64-mac.zip` 216.3 MiB（226837746 B）；Windows
> `PayasoAgent-0.4.1-setup.exe` 172.5 MiB（180872509 B）+
> `PayasoAgent-0.4.1-x64.zip` 234.6 MiB（246019660 B），各带 blockmap。
> cask 自动 bump 到 0.4.1（bot 提交 `0eab1e5`），sha256
> `19ce29187cba…3ae`（与 DMG 一致）。
>
> **这一版要在 Windows 上验的就是主题一致性**（v0.4.0 没有这个修复）：
> 打开应用 → 设置 → 外观 → 选「深色」，窗口的**系统标题栏 + 菜单栏**应与页面
> 一起变深（旧版是页面深、边框白）；选「浅色」应整体变浅；选「跟随系统」则跟
> Windows 的颜色模式走。**文件对话框不在其中** —— 它只认系统设置（Chromium
> 从不 ForceDark），DSH 同样。

> 产物现状（2026-10-15，**v0.4.0 已发布**）：tag `v0.4.0` 已推送（指向 `43b3286`），
> `.github/workflows/release.yml` 随之触发 —— mac DMG/ZIP + Windows NSIS/ZIP →
> GitHub Release → 自动 bump `Casks/payasoagent.rb` 并推回 main（因此发完要
> `git pull`，main 上会多一个 bot 提交，即 `d0769e6`）。
>
> 本版产物实测数字（Release 页，`curl -sIL` 取 content-length）：
> mac `PayasoAgent-0.4.0-arm64.dmg` 210.4 MiB（220618076 B）+
> `PayasoAgent-0.4.0-arm64-mac.zip` 216.3 MiB（226837212 B）；Windows
> `PayasoAgent-0.4.0-setup.exe` 172.5 MiB（180871916 B）NSIS 安装器 +
> `PayasoAgent-0.4.0-x64.zip` 234.6 MiB（246019157 B）便携包，各带 blockmap。
> cask 已自动 bump 到 0.4.0，sha256 `dd3cb492…204`（与 DMG 一致）。
>
> 已知缺口：Windows 原生目录选择器 —— **壳路径已真机验证**（2026-10-15，Win11
> 实测截图：点「打开工作区」直接弹出系统原生 `选择文件夹` 面板，标题/取消/选择
> 按钮齐全，无弹窗无 toast）；**浏览器 Host 路径（koffi + COM worker）仍未真机
> 验证**（那条路径标题是 `选择 PayasoAgent Workspace`，与壳的默认标题不同，
> 认标题即可分辨走的是哪条）。macOS 侧（壳 Electron dialog / 浏览器 Host
> osascript）早已实测能出原生面板。

> 2026-10-16 补：**原生 chrome 跟随页面主题**（Win11 真机截图里"上面的那一栏
> 是白的"就是这条）。
>
> 症状：网页皮肤由 CSS 决定，但系统标题栏 / 菜单栏 / 原生控件是 Chromium 照
> `nativeTheme.themeSource` 画的 —— 壳从不设它，于是永远跟**系统**外观走：
> 页面深色 + 标题栏/菜单栏浅色（实测像素：页面侧栏 `(18,24,32)`，而窗口标题栏
> `(243,243,243)`、菜单栏 `(255,255,255)`）。
>
> 修法（DSH 同款单向同步）：渲染进程把**主题模式**报给壳，壳写进 themeSource。
> `web/src/theme.ts` 的 `applyThemeMode` → 桥 `payasoDesktop.setNativeTheme(mode)`
> → `preload.cts` 发 `payaso:nativeThemeSet` → `main.ts` 的 `registerNativeTheme`
> 校验 sender 是自己的主窗口 + 值域兜底后写 `nativeTheme.themeSource`。
> 报的是**模式**（`light`/`dark`/`system`）而不是解析后的值 —— 报解析值等于把
> 用户的"跟随系统"钉死。DSH 的对应实现：`lib/preload-app.cjs` 监听
> `data-theme-source` 发 `dsh-desktop:native-theme-set`，`lib/main.js` 收下写
> `nativeTheme.themeSource`。
>
> 兼容：桥方法与值都按"老壳可能没有"写（可选链 + try/catch，浏览器形态直接
> no-op），**新网页配 v0.4.0 装出来的旧壳不会崩**，只是原生 chrome 不跟随。
>
> 验证：新增套件 `tests/frontend-native-theme.test.ts`（10 例：模式上报/
> 浏览器形态/桥抛错/老壳无此方法/通道名两端一致 + 归属校验 + 值域兜底）；
> 另用 scratch 里的 Electron 探针跑过真实往返 —— 真 preload →
> `setNativeTheme('light')` → 渲染进程 `prefers-color-scheme: dark` 由 true 变
> false，`dark` 变回 true，非法值被丢弃。
>
> 边界（说清楚免得误判）：**文件对话框本身不受影响**。Chromium 的 Windows
> 文件对话框代码（`shell/browser/ui/file_dialog_win.cc`、
> `ui/shell_dialogs/select_file_dialog_win.cc`）里没有任何主题开关，
> `base/win/dark_mode_support.cc` 只会把进程设成 `PreferredAppMode::kAllowDark`
> （跟随系统），从不 ForceDark —— 所以那个白色面板只有 Windows 的
> 「设置 → 个性化 → 颜色」能改，DSH 与我们在这一点上完全同命。

> 产物现状（2026-10-09 清理后）：Release 页**只保留 v0.3.5** 一个桌面版，
> mac（`arm64.dmg` 210MB + `arm64-mac.zip` 216MB）与 Windows（`setup.exe` 172MB
> NSIS 安装器 + `x64.zip` 234MB 便携包）**双平台齐备**，各带 blockmap；
> Homebrew cask 已自动 bump 到 0.3.5（sha256 与 DMG 一致）。
> 本地 `apps/desktop/release/mac-arm64/` 仍有编译产物可直接 `open`。
>
> 清理动作：删掉桌面线 v0.2.0–v0.3.4 的 8 个 tag + release（其中 v0.3.3/v0.3.4 是
> mac job 死掉、只剩 Windows 资产的残次品）。**`git push --delete origin <tag>` 就够
> 了 —— 不需要 token，release 页面会随之 404、资产不可达**（release 对象本身还会在
> 服务端残留，但用户侧已拿不到）。另外两个 tag `v1.0.0-local-mvp`、`v2.2.0` 是桌面
> 客户端之前的项目里程碑，**按用户要求保留**。

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

## 3. 十一个坑（都留了证据，别再踩）

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
（后来又在 v0.3.4 上犯了一次同款：单点 format 回归，见**坑 12**。）

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

### 坑 11 · `hiddenInset` 不等于免拖拽条：窗口拖不动

**现象**：用户装好打开 —— **窗口没法拖动**。main.ts 原注释还言之凿凿"隐藏标题栏
保留了系统拖拽热区，不需要自己画拖拽条"，被真机直接打脸。

**真相**：`titleBarStyle: 'hiddenInset'` 藏掉标题栏后，拖拽面不会自动等价于
"可见的顶栏"——要让**顶栏任意处可拖**，必须用 `-webkit-app-region: drag`
**显式声明**，这是 Web 内容窗口的硬规则。

**修复**（照抄 DSH：它的前端配方就在 app.asar 里，逐字节扒出）：

- 顶部铬条挂 `data-window-drag` 属性（`ShellBar` 根 + 侧栏 `logoRow`）
- `web/src/index.css` 三条规则：`[data-window-drag]{drag}` + 伞形交互元素
  `no-drag`（button/a/input/…/`[role=*]` 全家桶）+ `body > :not(#root)` no-drag（弹层）
- 关键设计：**drag 只挂铬条、不挂整窗** —— 文字选择、附件拖放（InputBar 那两个
  onDrop 容器）全不受影响；浏览器忽略该属性，web 版零副作用

**教训**：macOS 的"无标题栏"≠"免拖拽条"，**拖拽面是显式声明出来的**；
"我以为系统会兜底"的地方，去扒别人家的产物（asar 里的 CSS）比猜靠谱。

### 坑 12 · 改完没跑全仓 `biome check .`：v0.3.4 死在 lint 步，而注解说的是"上一步"

**现象**：`v0.3.4` 的 mac job **46s 就早退**，注解只有一句
`Process completed with exit code 1`，锚点 `#step:6:320`。同一份注解里
`v0.3.3` 挂的是 `#step:7:282`（1m33s）。两步号只差 1，很容易读串。

**真相**：步号映射是 **隐藏的 "Set up job" = 1，可见步整体 +1**。用两次**已知**
失败反推校准过（这是本节最值钱的一张表）：

| 注解锚点 | 可见步 | 步骤名 | 实证 |
|---|---|---|---|
| `#step:6:*` | 5 | `Lint & format check (Biome)` | **v0.3.4（本次）** |
| `#step:7:*` | 6 | `Deterministic test suites (no LLM)` | v0.3.3（job-notification 竞态） |
| `#step:8:*` | 7 | win `Prepare desktop payload` | 37753082 / 37754441（`.cmd` 与 GNU tar） |
| `#step:11:*` | 10 | mac `Package DMG & ZIP` | 37738384（空 `CSC_LINK`，坑 8） |

所以 v0.3.4 挂的是 **biome**，不是测试。而 biome 确实红：`507cd54` 把
`await waitFor(...)` 改成双向事件驱动后，表达式从三行收成一行、行宽掉到 100 列以内，
biome format 要求**合成一行**；提交时没跑全仓 `npx biome check .` —— 坑 7 的教训
原样又犯一次（这次不是累积，是**单点回归**）。

**复现**（全本地，一行不差）：

```bash
npx biome check .                  # exit 1 | Found 1 error.（160 个 warning 不挡路）
npx biome check . --reporter=json  # summary.errors = 1
npx biome format .                 # 直接点名 tests/job-notification.test.ts:113
npx biome format --write tests/job-notification.test.ts   # 修
```

**教训两条**：

1. **格式化 error 是"改完立刻能发现"的**，`npx biome check .` 必须跟着每次编辑一起跑
   （与 CI 同参，别只 `--write` 改动文件）。format 类回归的特征是 **job 早早退** ——
   lint 步在 npm ci + tsc 之后，46s 就死；而测试步要跑约 40s，挂它至少 1m30s。
   **总时长是免费的旁证**，先看时长再猜步号，能直接否掉"测试挂了"这种误判。
2. **判定失败步要用 `#step:N:C` 锚点，并且复取一次确认**。盯 Release 的 watcher
   脚本曾把同一个 run 读成 `#step:7:282`（实际 `#step:6:320`）—— 注解读取有缓存/时序，
   单次采样不能当结论。`annotations_partial` 匿名可取这条没变，仍是第一诊断通道。

> 修复提交 `b3acb54`：只动格式（1 插入 3 删除），`tsc` 0 错、biome exit 0、
> 113 套件全绿后重打 tag。

**顺手补掉的诊断盲区**（`tests/run-all.ts`）：上面两条教训都是"事后从步号反推"，
可一旦挂在 `Deterministic test suites` 上，注解仍然只知道"exit code 1"——
113 个套件里是哪一个全凭猜（v0.3.3 就这么盲猜过一轮）。现在 runner 在
`GITHUB_ACTIONS=true` 下会补发 `::error title=确定性测试集合失败::…` 注解，
带**套件名 + 退出码 + 重跑命令 + 输出摘录**（换行编码成 `%0A`，单步上限 10 条）。
本地不设该变量，输出零污染；退出码仍由 `process.exit` 决定，注解不改判定。
实测：临时插一个必败套件 → `test:all` exit 1、注解正确下发；撤掉后 113 套件全绿、
`::error` 行数 0。

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

1. `fetch-node.mjs`：win32 支持官方 zip + `node.exe`（解压用 tar，但**必须显式取
   `System32\tar.exe`（bsdtar，认 zip）** —— PATH 里排前面的可能是 Git Bash 的
   **GNU tar，不认 zip**，不赌 PATH 顺序）；`mv` 命令 Windows 没有 → 换 `renameSync`
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
