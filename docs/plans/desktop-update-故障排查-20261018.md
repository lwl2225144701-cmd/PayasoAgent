# 桌面更新安装无反馈排查（2026-10-18）

用户已授权推送并发包，本轮发布版本为 **v0.4.16**。最终构建与资产状态以 [Release](https://github.com/lwl2225144701-cmd/PayasoAgent/releases/tag/v0.4.16) 和 [Actions](https://github.com/lwl2225144701-cmd/PayasoAgent/actions) 为准。

## 本机证据

- 排查时 `/Applications/PayasoAgent.app` 的实际版本仍是 **0.4.13**。
- 缓存中已有完整的 `PayasoAgent-0.4.15-arm64-mac.zip`（227111938 字节），SHA-512 与发布 feed 一致；新包的 `codesign --verify --deep --strict` 通过。
- 两版均为 ad-hoc 临时签名。旧版的 designated requirement 为 `cdhash H"62753db19f2a555515d2784aebc646b11c0403d3"`，新版为 `cdhash H"5e8bbabfaf6c02b8d5df3c18695b79e6348365e7"`。
- 用旧版的签名要求校验新包，得到 `code failed to satisfy specified code requirement(s)`。因此包本身完整，但不能通过 Squirrel 的跨版本签名验证。
- 截图中的 `fetch failed` 出现在后续安装前的 `GET /runs` 检查。旧协调器会在安装前停止后端，但只捕获 `quitAndInstall()` 的同步异常；安装器异步报错时仅记控制台日志，后端不会恢复。再次安装便可能连接不到本地任务服务。
- 本次首次安装的完整原始事件日志未落盘，无法逐条还原点击时间线；签名拒绝条件与异步失败不恢复服务的代码缺陷已分别复现。

macOS 更新器从当前应用取 designated requirement，并用它验证新应用，见 [Squirrel 签名校验源码](https://github.com/Squirrel/Squirrel.Mac/blob/master/Squirrel/SQRLCodeSignature.m)。[Electron 官方说明](https://www.electronjs.org/docs/latest/api/auto-updater#macos)也要求 macOS 自更新应用有签名。公证与跨版本签名身份不是同一条件。

## 本地修复

- 把实际更新流程抽为可执行测试的状态机；后台检查保持静默，手动检查即使加入已有请求也会给出结果。
- 增加 `checking / ready / installing` 状态。下载完成、选择稍后或安装失败后均保留已下载入口；重试直接使用已下载文件。检查、下载、安装不会重复并发执行，下载前等待已有检查结束以保持目标版本一致。
- 正式签名的 macOS 构建先等待 Squirrel 验签与暂存成功，再查询任务、确认、停止后端。所有原生安装都等待真实退出事件，同时捕获异步错误和交接超时；失败时先恢复后端，再报错。
- ad-hoc 或无法确认签名身份的 Mac 构建使用手动替换路径：完成下载后显示「打开更新包」，打开经 updater 校验的 ZIP，并说明解压、退出、替换、重开。此路径不会停止后端，也不会绕过系统签名校验。Windows 继续使用原生安装。
- preload 订阅后主动请求最新状态，避免页面刷新时漏接；新增本地滚动日志 `userData/logs/updater.log`（单文件约 1 MiB，保留一份轮转），供下一次现场排查。
- 本地任务响应格式异常时拒绝安装，不能当成没有运行中的任务。回滚也不会重启不属于当前客户端的外部后端。

## 验证与边界

- 更新专项回归：**37 项通过**，覆盖异步错误、超时、后端恢复顺序、稍后再装、重复点击、检查与下载交错、临时签名手动安装。
- 完整确定性回归：**130 套件通过**，串行耗时 91.5 秒；后续补充的状态快照接线和并发目标版本测试另跑专项通过。
- 根目录 TypeScript、桌面构建、Web 生产构建、Biome 错误级检查通过。
- 实际更新 UI 组件的六种可见状态及按钮可用性已用隔离页面验证；「安装更新」「打开更新包」点击均正确进入桥接回调。截图位于 `.payaso/logs/update-review/ready-manual.png`。
- 未在 `/Applications` 替换用户应用；没有声称正式证书下的完整跨版本安装已实机验收。真正的一键自动替换仍需要稳定的签名身份。
- 修复纳入 v0.4.16；此前发布的 v0.4.15 不包含这次更新流程修复。

从旧版本迁移时，可先退出客户端，再手动覆盖安装 [v0.4.16 DMG](https://github.com/lwl2225144701-cmd/PayasoAgent/releases/download/v0.4.16/PayasoAgent-0.4.16-arm64.dmg)，保留用户数据目录即可。

## Windows 复核与补修（同日）

Windows 使用 NSIS，不走 Mac 的 Squirrel 签名条件。共用状态机已覆盖检查反馈、已下载状态、重复点击和安装失败后恢复服务，但复核当前锁定的 electron-updater 6.8.9 后，又发现两处 Windows 专属缺口：

1. `BaseUpdater.quitAndInstall()` 在同步 `doInstall()` 返回 true 后排队退出，`NsisUpdater` 此时可能仍在异步启动 exe 或等待提权。进程创建失败时客户端可能已经退出。新增 `GuardedNsisUpdater`，保留上游下载、哈希/签名校验、安装参数和提权回退，只在确认启动后退出；文件缺失不再进入忽略错误字符串的 `shell.openPath` 回退。
2. 原 `stopBackend()` 先清空子进程引用，再同步执行无超时的 `taskkill`。关停失败会丢失管理能力，也可能阻塞主进程。现改为异步限时执行，确认退出后才释放引用；失败保留原进程、取消安装，允许重试。旧进程退出也不会误清新进程引用。

同时补充后端进程的 `error` 监听：回滚重新启动时如果可执行文件缺失或被拒绝，启动就绪检查会抛出原始异常，由更新流程提示恢复失败；未创建的进程不留管理引用，避免未处理事件直接导致客户端崩溃。

普通 exe 使用 Node 的 `spawn` 事件确认成功创建，不能只看 PID，见 [Node 官方说明](https://nodejs.org/docs/latest-v22.x/api/child_process.html#event-spawn)。`elevate.exe` 则等待退出码 0 才确认授权/启动；其 1.3.0 源码由 [electron-builder 的构建脚本](https://github.com/electron-userland/electron-builder-binaries/blob/master/packages/nsis/assets/nsis-elevate.sh)指向，已下载并核对归档 SHA-256 `b1b3f070353a0eadee2cea3a575049d10df9763ff24e39313da4cec9455382e1`：未带 `-w` 时 ShellExecuteEx 成功即退出 0，失败/取消退出 1，不会等安装器整个结束。

- 本机专项共 **45 项通过**，新增 8 项覆盖 Windows 的实际 NSIS 接线、启动确认、异步失败恢复/重试、中文空格路径、安装目录参数、提权取消、缺失安装器、关停失败。调用进程创建和 UAC 的结果使用可控事件源，不能算 Windows 操作系统实测。
- 130 套件回归中 129 项通过，唯一失败是本排查记录漏登文档索引；补齐后单独重跑 `docs-index` 通过。桌面构建、根类型检查和 Biome 错误级检查通过。
- CI 新增 Windows runner 更新回归；Windows 发布 job 在出包前也必须跑。另有两个 **仅 Windows 执行** 的真实 OS 用例：进程创建/失败、`taskkill /T` 关停父子进程。本轮 Windows runner 的实际结果见 Actions，不能用本机 mock 结果代替。
- 仍需 Windows 实机用旧版本完整验证「检查 → 下载 → 安装 → 替换 → 重启」，包括当前电脑的权限与系统拦截情况。当前仅有 macOS 主机，没有可用 Windows VM；不能据本机回归断言全部 Windows 实机问题已消失。
- 用户已授权将本轮补修推送并发布为 v0.4.16；v0.4.15 不含这些补修。

## 2026-10-29：更新成功后快捷方式失效

- 用户确认操作为下载新版本、安装并重启；新程序能正常运行且版本正确，随后双击图标出现“目标已更改或移动”。因此当前现场指向快捷方式失效，尚未取得该快捷方式的实际目标路径，不能认定具体是哪一次链接跟踪改写。
- 源码确认的缺口：程序写入快捷方式后只信 API 返回值；仅立即和 3 秒后检查，3 秒成功便记录本版本已核验。安装器创建快捷方式失败时直接清除错误，更新后自动启动还优先依赖开始菜单链接。
- 本地补修：更新首次检查刷新已有链接，写入后读回目标、工作目录、图标和应用身份；在 3/10/30 秒有界复查，末次成功才记版本，退出时取消复查。普通启动仍不补建用户主动删除的图标。诊断写入现有 `userData/logs/updater.log`。
- 安装器更新后直接启动已安装 EXE，先检查 EXE 存在；快捷方式创建失败写入安装目录的 `shortcut-repair.log`，由程序启动后的修复继续处理，不因单独的快捷方式失败中止安装。
- 本机验证：更新专项 53 项通过，包含写入成功但读回错误、晚到损坏、失败不记版本及退出取消；原生主题 18 项与架构边界测试通过。根类型检查、桌面编译、Biome 错误级检查通过。
- 验证边界：本机为 macOS，未执行 Windows 的 NSIS 编译和真实跨版本更新；3/10/30 秒是重试策略，不是 Windows 链接跟踪的完成时间保证。当前自动修复仅管理当前用户桌面和开始菜单的同名链接，公共桌面、改名链接及任务栏固定副本未覆盖。本轮改动尚未发布。
