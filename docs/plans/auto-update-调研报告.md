# 检查更新与自更新实现方案 · 调研报告

> 调研对象：生产实装的 DeepSeek Harness（DSH）桌面端 `0.2.0-rc.2`（macOS arm64 整包），
> 以及本仓库 PayasoAgent 桌面壳的现状。DSH 侧结论均从已安装的
> `/Applications/DeepSeek Harness.app`（`app.asar` + `Resources/`）逆向核实，非文档推测。
>
> 下文的行号引用（如 `main.js:9472`）指向 DSH 包内的 `lib/main.js` —— 取用方式：
> `app.asar` 头 16 字节后是索引 JSON，按条目 offset 读即可（**本仓库不留解包副本**，
> 免得把 DSH 的打包产物混进我们自己的 `apps/desktop/`）。

## 0. 结论（TL;DR）

DSH 的自更新是**三条链路**，不是一个功能：

| 链路 | 机制 | 更新什么 |
|---|---|---|
| A. 整包自更新 | `electron-updater@6.8.9`，generic feed，`channel: nightly` | 整个 `.app`（含 asar 里的壳 + extraResources 里的后端与 Node 运行时），**后端随壳一起升级** |
| B. 服务端强制更新策略 | 主进程轮询 `harness.deepseek.com` 策略接口，`code: 40005` 即强制 | 不下载任何东西，只弹全屏阻断窗，把用户赶去链路 A |
| C. CLI 命令管理 | bundled node 跑 `command-manager.js` worker，往 PATH 装 `dsh` 命令 | 命令的 shim 指向 `.app` 内部运行时，**app 升级后 CLI 自动跟随新版本**，无需单独升级逻辑 |

对本仓库的含义：`electron-updater@6.8.9` 已是现成依赖、CI 已经在产 `zip + blockmap` 并挂
GitHub Releases、`GET /runs` 已能无鉴权查到在跑任务（见 §5.2）——期 3 缺的只是
`publish` 配置和壳侧协调器代码，**后端不用动，基础设施零新增**。

---

## 1. 链路 A：electron-updater 整包自更新

### 1.1 发布源（app-update.yml，打包时由 electron-builder 写入 Resources）

```yaml
provider: generic
url: https://download.deepseek.com/dsh-desk/feeds/mac-arm64/
channel: nightly
updaterCacheDirName: '@deepseek-aidsh-desktop-updater'
```

- feed 文件名规则（读 `electron-updater@6.8.9` 源码确认，`Provider.js` + `util.js`）：
  macOS 为 `<channel>-mac.yml`，Windows 为 `<channel>.yml`。
  DSH 实际请求 `https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml`。
- 每个 arch 一条 feed 路径（`mac-arm64` / `mac-x64` / `win-x64`…），yml 里带
  `version / files[].url / sha512 / blockmapSize`，zip 与 `.blockmap` 必须同名同目录。
- `channel: nightly` + `allowPrerelease: true`：发预发布版（`0.2.0-rc.2` 这种）。
- `updaterCacheDirName`：下载缓存目录名（不配则用 appId，多包同机时互相踩）。

### 1.2 autoUpdater 的关键定制（`DesktopUpdateCoordinator`，main.js:6947）

```js
updater.autoDownload = false            // 只检查，用户点了才下载
updater.autoInstallOnAppQuit = false    // 退出时不偷偷装，安装永远走显式确认
updater.channel = "nightly"
updater.allowPrerelease = true
updater.allowDowngrade = false
```

- **自定义 HTTP executor**（`DesktopUpdateHttpExecutor extends ElectronHttpExecutor`，
  main.js:6882）：保留 electron-updater 的代理与 `login` 事件转发，额外加**空闲超时**
  （默认 60s，`DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS` 可调）——收到响应头后每个 data/end
  都续期，专治"连接挂着不动"的静默失败，且**不是**总下载时限。
- **版本门禁**：`valid(version)` + semver `gt(version, currentVersion())`，低于当前版本
  一律视为"无更新"（`allowDowngrade=false` 之外的双保险）。
- **单飞合并**：check / download / install 各一个 in-flight Promise，重复调用直接 join；
  下载确认带 `version` 参数，版本不符抛 "download confirmation is stale"。
- **开发版门禁**：`enabled() = app.isPackaged && existsSync(process.resourcesPath/app-update.yml)`，
  没打包或没 feed 配置的构建根本不检查。

### 1.3 状态机与轮询调度

状态（主进程私有，渲染进程只收语义化投影 `presentDesktopUpdate`：phase/version/percent/failure）：

```
idle ──check──▶ available ──用户点下载──▶ downloading ──▶ verifying ──▶ ready ──▶ installing ──▶ quitAndInstall
 ▲                 │                        │                │
 └──检查失败/无更新─┴──────任一环节失败─────┴────────────────┴──▶ error（带 failedOperation: check|download|install）
```

- `DesktopUpdateSchedule`（main.js:8330）：默认 **10 分钟**一轮
  （`DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS`），失败指数退避、上限 **6 小时**
  （`DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS`），**±20% jitter**
  （`DSH_DESKTOP_UPDATE_CHECK_JITTER`）打散多客户端同时请求；时钟用 `performance.now()`
  单调时钟，不受系统改时间影响。
- 触发点：启动（`automaticCheck`）、**窗口聚焦**、`powerMonitor.on("resume")`（睡眠唤醒）、
  菜单手动（bypass 期限）、策略接口返回 blocking 时立即补查。
- 错误分类：`NETWORK_FAILURE` 正则把 `ERR_INTERNET_DISCONNECTED/ETIMEDOUT/...` 归为
  `*-network`，文案区分"网络问题"与"安装失败"；渲染层永远看不到原始报错。

### 1.4 安装前的任务交接（这是"自更新"真正的难点，`beforeRestart`，main.js:11465）

顺序严格如下，任何一步失败都回滚：

1. `commandManager.idle()` —— 等 CLI 命令管理 worker（链路 C）结束，别边装边改 PATH。
2. `await workspaceRecovery` / `await startup` —— 等工作区恢复、后端启动流程 settle。
3. `host.updateTasks("inspect")` —— 通过桌面控制协议问后端：有没有在跑的任务
   （10s 超时；后端不可用 → `tasks-unavailable` 错误，放弃本次安装）。
4. **确认框**：有任务 → warning 型"将停止进行中的任务并重启，继续？"（停止/稍后）；
   无任务 → info 型"版本 x 就绪，安装并重启"。对话框是独立窗口（见 1.5）。
5. 复核 `backend.host` 没被换过后，`host.updateTasks("lock")` —— **加锁拒绝新任务准入**；
   此时若发现又有新任务起来 → `tasks-changed`，要求重新确认。
6. 关平台内嵌视图 → `requireCleanStop = true` → `backend.stop()`（优雅关停）→
   校验关停确实干净（否则抛错回滚）→ `quitAndInstall(true, true)`。

失败回滚：`host.updateTasks("unlock")` 放行 → **重新拉起后端**并恢复导航 → 弹错误框。
即安装失败不会把用户晾在一个没有后端的壳里。

### 1.5 UI 与遥测

- **更新对话框**：独立的隐藏 BrowserWindow（`dsh-app://shell/update-dialog.html`），
  隔离 preload 只在 origin 精确匹配时暴露 `dshUpdateDialog`（status/changed/respond 三个通道）。
  响应带 **revision**：主进程替换对话框内容就 +1，过期响应直接拒（"stale dialog response"），
  Esc = 取消、关闭 = 取消，**任何取消路径都不授予安装许可**。
- **强制更新窗**（链路 B）：`mandatory-update.html` 全屏窗，文本 + 下载/安装按钮 +
  服务端下发的兜底页面链接（`allowedPageOrigins` 白名单校验），支持飞书测试登录
  （`authentication: "feishu-test"`）。
- **遥测**：`updateJournal`（JSONL，记录 check-requested/download-requested/install-confirmed/
  workspace-ready…）+ `track()` 埋点（`desktop_upgrade_click` /
  `desktop_upgrade_download_result{is_success,error_reason}` /
  `desktop_upgrade_install_restart_click`）。
- 菜单项即截图里那个：`checkUpdatesMenu` → `openUpdatePrompt(true)`：先弹"正在检查…"，
   无更新 → "已是最新版 当前版本 x.y.z"，有更新 → 问是否下载，下载完 → 安装确认。

---

## 2. 链路 B：服务端强制更新策略（`DesktopMandatoryUpdatePolicy`，main.js:8724）

与 electron-updater **完全独立**的第二条查询：

- 配置在桌面包 `package.json` 的 `dshMandatoryUpdatePolicy` 字段：
  `{ origin: "https://harness.deepseek.com", allowedPageOrigins: [...], authentication: "anonymous" }`。
- 轮询节奏与链路 A 相同量级（10min / 退避 6h / ±20% jitter / manual 绕过期限），
  请求头带身份：`x-client-arch`、`x-client-update-channel: nightly`、
  `x-client-bundled-dsh-version`（后端整包版本）。
- 响应协议：`code:0 + biz_code:0 + biz_data:null` → 不强制；`code:40005` → **blocking**，
  带 `show_content{title,detail}` 和 `desktop_app_link`（兜底页，白名单 origin 才让点）。
- blocking 时：普通对话框全部 abort，弹出 mandatory 全屏窗；已知决策**不因后续失败被擦掉**
  （"failures never erase a known mandatory decision"）。
- 用途：后端协议大版本跃迁、安全底线版本等"必须升"的场景，与"有新版可用"解耦。

---

## 3. 链路 C：CLI 命令管理与"后端包"的更新方式

### 3.1 后端包不单独升级，随 app 整包替换

- 后端整体（`dist/ + web/dist/ + node_modules/`）与自带官方 Node 都在 **extraResources**
  （真实文件系统，不进 asar），`app-update` 替换 `.app` 时一锅端——**不存在后端单独 OTA**。
- `Resources/dsh/desktop-runtime.json` 是后端整包清单：`release{version, hostProtocolVersion,
  nodeVersion, pnpmVersion}` + `sharedPackages[]` + `files[]`（**12417 个文件逐一 sha256**）。
  用于启动时对账与插件 profile 管理。
- `DesktopProjectManager.applyRelease()`（main.js:3471）每次后端启动前跑：读清单、迁移
  `pnpm-workspace.yaml` 旧配置、建插件 profile（pnpm workspace）、清理解除的链接投影。
  **这不是自更新**，是 profile 对账；插件装在上层 profile 里，不随 app 升级被冲掉。

### 3.2 `dsh` 命令：shim 指向 app 内运行时（main.js:7253）

- `DesktopCommandManager` 用 bundled node 起 `runtime/cli/command-manager.js` worker，
  支持 inspect / install / repair / remove；macOS 遇 `EACCES/EPERM` 自动走
  `/usr/bin/osascript` 提权重试（用户取消 → `ECANCELED`）。
- 探测"PATH 实际选中哪个 dsh"：登录 shell 跑 `command -v dsh`（带 5s 超时），
  能识别被别的安装 shadowed 的情况。
- **升级语义**：symlink/.cmd 的靶子是 `.app` 内部的 runtime 目录（`.../Contents/Resources/runtime/...`），
  app 换新版 = 靶子内容换新，**CLI 零成本跟随**。更新前 `commandManager.idle()` 等 worker
  收尾，就是怕装到一半改链接。

### 3.3 后端配合关停的控制协议

主进程与后端 Host 之间有私有控制通道，更新用到三个动作（10s 超时）：
`update-tasks: inspect | lock | unlock`。lock 之后新任务被准入拒绝；
主进程还会校验后端退出是优雅的（`DesktopHostUncleanExitError`），不优雅就回滚不装。

---

## 4. PayasoAgent 现状 vs DSH：差距清单

| 项 | DSH | 本仓库现状 |
|---|---|---|
| electron-updater | 6.8.9，全量使用 | `apps/desktop/package.json` 已声明 6.8.9，**零使用** |
| publish 配置 | generic feed + nightly channel | `electron-builder.yml` 里 **`publish: null`**（不生成 app-update.yml） |
| CI 产物 | — | `release.yml` 已出 **dmg + zip + blockmap 并挂 GitHub Releases**（zip 就是给 updater 用的，README 已注明"期 3"） |
| 壳的关停能力 | 后端协作 inspect/lock/unlock | `stopBackend()` 已有分级关停（SIGTERM→SIGKILL / Windows taskkill /T）；任务查询可复用现成的 `GET /runs`（无鉴权，带 status），**无准入锁**（可暂不做） |
| 更新 UI/菜单 | 独立对话框 + 强制窗 + 菜单项 | 无 |
| 签名 | ad-hoc 签名（未公证也发 nightly） | 同样未签（afterPack ad-hoc），用户基数小可接受 |

计划文档（`docs/plans/desktop-client-electron-plan.md` §5）已把期 3 定为
`electron-updater + app-update.yml（provider: generic 或 GitHub Releases）`，与本调研一致。

---

## 5. 落地建议（期 3）

### 5.1 发布源二选一

- **方案 1（推荐先做）：GitHub provider。** CI 已经在往 GitHub Releases 挂 zip+blockmap，
  只要在 `electron-builder.yml` 加：
  ```yaml
  publish:
    provider: github
    owner: <org>
    repo: <repo>
    releaseType: release   # 别用 draft；latest release 即 latest.yml 源
  ```
  打包时自动生成 `app-update.yml`（`provider: github`），feed 文件 `latest-mac.yml` /
  `latest.yml` 由 GitHub latest release 的资产提供。零新增基础设施。
  注意：国内用户到 github.com 的可达性要在真实网络验；私有仓库需要 `GH_TOKEN`。
- **方案 2：generic + 自有静态源**（对齐 DSH）。需要一台 https 静态托管放
  `latest-mac.yml + zip + blockmap`（或后续上 nightly channel 时 `nightly-mac.yml`）。
  好处是渠道可控、可打分批发布；坏处是多一套设施。

### 5.2 壳侧代码（照 DSH 裁剪，不必全抄）

1. `update-coordinator.ts`：autoUpdater 包装（autoDownload/autoInstallOnAppQuit=false，
   版本 semver 门禁，单飞合并，状态机 idle→available→downloading→ready→installing）。
   **删除**：自定义 httpExecutor（可后续加）、journal/track（本仓库暂无埋点体系）。
2. `update-schedule.ts`：10min 轮询 + 失败退避 + jitter；触发点接启动、窗口 focus、
   `powerMonitor.resume`、菜单手动。
3. 菜单：app 子菜单加"检查更新…"（`checkUpdatesMenu`），无更新弹"已是最新"。
4. **安装前交接（重点，且后端零改动）**：
   - 后端**已有**现成端点：`GET /runs` 返回 `{ runs: [...] }`，每个 run 带 `status`
     （`running` / `stopping` / 已完成等；`run-types.ts` 的 `isCancellable()` 即
     "在跑"判定），且该 GET **不鉴权、不查 origin**（只有 POST/变更类端点才要），
     壳直接 `fetch('http://127.0.0.1:4500/runs')` 即可，无需新增端点。
   - 有任务 → warning 确认框"将停止进行中的任务"；无任务 → info 确认框；
   - 确认后 `stopBackend()`（现成，含 Windows taskkill /T），关停干净才 `quitAndInstall`；
     失败则重新 `startBackend()` 并提示（照 DSH 的回滚思路）。
   - DSH 比这多一层 `update-tasks: lock` 准入锁 + "安装前又有新任务起来就重新确认"，
     本仓库可先不做（确认到停后端之间只有几百毫秒，用户手动起新任务的窗口极小），
     后续要补再照抄。
5. 开发版门禁：`app.isPackaged && existsSync(app-update.yml)` 才启用，开发期不弹更新。
6. `updaterCacheDirName` 建议显式设置，避免与将来其他 Electron 应用互踩缓存。

### 5.3 已知坑（DSH 源码里核实过的）

- macOS 的公证和跨版本签名身份必须分开判断。2026-10-18 本机复核发现，本项目
  ad-hoc 签名的 designated requirement 绑定当前构建 cdhash，不能跨版本通过 Squirrel
  校验；不能据「未公证可运行」推断「临时签名可自动替换」。当前此类构建走手动更新包
  安装，稳定签名身份的构建才走原生自动替换，详见 `desktop-update-故障排查-20261018.md`。
- zip 与 `.blockmap` 必须同时上传且同名（CI 已满足）；差 blockmap 会退化为整包下载。
- 更新成功后 app 自动重启（`quitAndInstall(isSilent=true, isForceRunAfter=true)`），
  后端由壳重新拉起——本仓库 `boot()` 已覆盖该路径。
- `channel` 一旦发出去就**别来回改**（nightly↔latest 切换用户端会出现降级/串台）；
  DSH 固定 nightly + `allowDowngrade=false`。

---

## 6. 未验证 / 待确认

- GitHub provider 在目标用户网络下的实际可达性与速度（需真机测）。
- 私有仓库发布时 `GH_TOKEN` 的 CI 注入方式（public 仓库不需要）。
- Windows 侧 NSIS 安装器 + zip 的 updater 行为（本仓库 win 目标已配 nsis+zip，未实测）。
- `GET /runs` 的返回体里历史 run 也会列出，"在跑"过滤条件需按 `isCancellable()`
  （`running`/`stopping`）实现时确认无遗漏状态（已核实状态枚举在 `run-types.ts`）。

---

## 附：关键源码位置（DSH 0.2.0-rc.2，app.asar/lib/main.js）

| 功能 | 位置 |
|---|---|
| 更新 HTTP executor（空闲超时） | main.js:6882 `DesktopUpdateHttpExecutor` |
| 更新协调器（状态机/单飞/quitAndInstall） | main.js:6949 `DesktopUpdateCoordinator` |
| 安装前任务交接与回滚 | main.js:11465 `beforeRestart` 闭包 |
| 轮询调度（退避/jitter） | main.js:8330 `DesktopUpdateSchedule` |
| 强制更新策略 | main.js:8724 `DesktopMandatoryUpdatePolicy` |
| 错误分类与语义投影 | main.js:8406-8449 `presentDesktopUpdate` 等 |
| 更新对话框（revision 防串期） | main.js:9472 `DesktopUpdateDialog` + renderer/update-dialog.js |
| CLI 命令管理 worker | main.js:7236 `DesktopCommandManager`（worker: `runtime/cli/command-manager.js`） |
| 后端 profile 对账 | main.js:3449 `DesktopProjectManager.applyRelease` |
| feed 文件名规则 | node_modules/electron-updater@6.8.9 `out/providers/Provider.js:41-46`、`out/util.js:30` |
| 发布源配置 | `Resources/app-update.yml`（generic + nightly） |
