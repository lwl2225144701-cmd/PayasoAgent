# Windows 更新过渡窗与图标在位修复（2026-10-29）

> 状态：代码与测试已落地（`desktop-update` 58 项 + Windows 原生测试通过）。**真实跨版本升级未验收**：需用已发布 v0.4.23 作为旧端跑一次完整「下载 → 安装并重启」，确认全程图标不消失、无需手动双击。构建通过、单测通过均不替代这一步。

## 1. 现场证据

用户实机 0.4.22 → v0.4.23 反馈：更新后桌面图标被删除，等一会儿才出现；应用没有自动打开，需手动双击。

本机日志（`%LOCALAPPDATA%\PayasoAgent\logs\windows-install.log`，本地时间）：

| 时间 | 事件 |
|---|---|
| 16:45:29 | `installing 0.4.23 and waiting for application exit` / `isSilent: true, isForceRunAfter: true` |
| 16:45:41 | `begin prepare` |
| 16:45:42.66 | `completed prepare` —— 桌面与开始菜单两个 `.lnk` 已删除 |
| 16:49:30.14 | `begin finish` —— 链接到此才重建 |
| 16:49:30.82 | `link verified`（桌面） |
| 16:49:31.72 | `launch pid=13568` |
| 16:49:52.79 | `[handoff] ready pid=13568` —— 新应用**确实启动并就绪** |
| 16:50:10.55 | `begin repair`（第二次实例，用户手动双击触发） |

两个可量化事实：

1. **图标消失 3 分 48 秒**（16:45:42.66 → 16:49:30.82）。
2. **自动重启链路是通的**（16:49:53 就绪回执到达）。从点击到窗口出现共 **4 分 23 秒**，期间屏幕上没有任何可见状态：Electron 已退出、图标已删除、静默安装无进度提示。用户等到图标回来（16:49:30）便认定失败，16:50:11 手动双击——手动那次也成功，于是"成功"被归因成手动操作。

结论：**坏的不是重启，是过程不可见**；图标消失则是另一处独立的确定性缺陷。

## 2. 根因一：图标为什么消失

不是 Windows 链接跟踪，是安装事务自己删的，而上游模板**故意不补**：

1. `PayasoUpdate.Prepare` 在旧卸载之前 `File.Delete` 掉两个链接。
2. 上游 `addDesktopLink` / `addStartMenuLink`（app-builder-lib 26.15.3，`include/installer.nsh`）在 `$keepShortcuts == "true"` 时只处理改名搬迁、**不创建**。而 `keepShortcuts` 必然为 true：`registryAddInstallInfo` 写入 `KeepShortcuts "true"`，且此时旧 EXE 仍在。
3. 于是链接只能等 `customInstall` 里的 `finish` 补建 —— 也就是整个「旧卸载 + 写新文件」结束之后。图标必然消失整个安装时长。

对照：`uninstallOldVersion` 会自动带 `--keep-shortcuts`，旧卸载器的 `${ifNot} ${isKeepShortcuts}` 分支因此不删链接。只要新安装器不主动删，链接全程原位有效。

## 3. 根因二：静默安装期间零反馈

`quitAndInstall(true, true)` 走 `/S` 静默安装， PayasoAgent 侧没有任何过渡界面。应用一退，用户对着空桌面。

## 4. WorkBuddy 参考实现（逆向自 `D:\AI\workbuddy\resources\app.asar`）

- 安装参数：`['/S', '--updated', '/UPDATE=1', '/D=<installDir>']`（`main/update-service.win32.js`）。
- 过渡窗两个脚本位于 `resources/scripts/`：
  - `launch-update-progress.vbs`：wscript（GUI 子系统，无控制台）以 `WshShell.Run cmd, 0, False` 隐藏启动 PowerShell 并立即返回，使 PowerShell 能在 Electron 主进程退出后继续存活。用 `cmd /c start` 会闪黑窗，直接 detached spawn powershell 会在跑脚本前退出。
  - `update-progress.ps1`：WinForms 无边框窗，标题「正在安装更新」、正文「更新即将完成，应用将自动重启，请稍候...」、Marquee 进度条。四种关闭条件先到先得：新应用出现可见主窗口（排除旧 PID）/ 安装器进程消失 + 3s 淡出 / 120s 未见到安装器 / 600s 绝对上限。
- 退出时序：`hideAllWindowsForUpdate()` → spawn installer（detached）→ `app.emit('before-quit-for-update')` → `app.quit()` → `setTimeout(app.exit(0), backstop)`。
- 启动新应用走上游 `${StdUtils.ExecShellAsUser} "$launchLink" "open" "--updated"`。

PayasoAgent 的 `PayasoUpdate.exe launch` + 命名管道就绪回执（核对 token / 版本 / 实际 EXE / PID）比上游 `ExecShellAsUser` 更严，**保留不动**；实机日志也证明它工作正常。

## 5. 本次改动

| 文件 | 改动 |
|---|---|
| `apps/desktop/resources/scripts/update-progress.ps1` | 新增。过渡窗，关闭条件以「新应用可见主窗口」优先。 |
| `apps/desktop/resources/scripts/launch-update-progress.vbs` | 新增。隐藏中继，避免控制台闪黑。 |
| `apps/desktop/src/update/update-progress-window.ts` | 新增。不 import electron（会被带入纯 Node 单测，`process.resourcesPath` 为 undefined 正好当门禁）；locale 用 `Intl` 推断；任何失败只记录不抛出。 |
| `apps/desktop/src/update/windows-installer.ts` | `spawnLog` 在 spawn 安装器**之前**调过渡窗（`protected` 便于测试覆盖）；`app.quit()` 后加 20s `app.exit(0)` 兜底（unref，正常退出时作废）。 |
| `apps/desktop/windows/PayasoUpdate.cs` | `Prepare` 由「删除链接」改为「原地重写为禁跟踪链接」：目标路径不变，图标全程在位；旧卸载器带 `--keep-shortcuts` 不会删它，禁跟踪标志保证整目录搬移时不跟随旧 EXE。重写失败只记录并保持原链接在位，`Finish` 仍重建并读回校验，不因一条链接写不进而阻断更新。 |
| `apps/desktop/electron-builder.yml` | `win.extraResources` 增加 `resources/scripts → scripts` 与 `build/icon.ico → icon.ico`。 |
| `apps/desktop/scripts/verify-package.mjs` | Windows 产物体检新增：`scripts/update-progress.ps1` 与 `scripts/launch-update-progress.vbs` 必须存在。 |
| `tests/windows-update-native.mjs` | 「旧文件移动前必须已分离链接」改为「必须仍在位且已禁用跟踪」；回滚恢复旧快照、用户主动删图标不补建两条断言不变。 |
| `tests/desktop-update.test.ts` | 新增 2 项：过渡窗接线顺序与脚本内容契约；wscript 中继参数、本地化文案、资源缺失静默跳过。 |

## 6. 验证结果与边界

| 检查 | 结果 |
|---|---|
| `node tests/desktop-update.test.ts` | 58 项通过（含 Windows 原生测试：禁跟踪标志 / 原地分离 / 失败回滚 / 删图标不补建 / 进程就绪回执） |
| `apps/desktop` `tsc --noEmit` | 通过 |
| `biome check`（改动文件） | 通过 |
| `test:all` 全套 | `desktop-update` 通过；另有 22 个套件失败，**全部为既有环境问题**，与本次改动无关 |

关于 `test:all` 的 22 个失败，已做两项排除：(1) 逐一确认无失败套件引用本次改动的任何文件；(2) 在 `HEAD` 干净 worktree 上复跑 `attachment-store` / `docs-code-paths` / `shell-execution` / `write-scope` / `preview-api` / `workspace`，失败表现完全一致。失败成因为：Windows 无 Unix 权限位（`438 !== 292` / `666 !== 384`）、`sandbox-exec` 与 Keychain 仅 darwin、沙箱拒绝 spawn `node`/`git` 与删除 `D:\Temp\Temp\*`、无 LLM 网络、以及既有的文档路径失效。仓库级 `biome check .` 的 192 个错误同为既有问题（`core.autocrlf=true` 导致工作区大量 CRLF，CI 检出为 LF 故不复现；`web/` 单独就有 45 个）。

## 7. 待实机验收

1. 用已发布 v0.4.23 作为旧端，候选包为新版，完整跑「点击下载 → 安装并重启」。
2. 全程确认：桌面与开始菜单图标**始终在位**；过渡窗出现并在新窗口就绪后自动关闭；无需任何手动双击。
3. 更新后立即、30 秒后、退出程序后分别从桌面和开始菜单启动，校验目标与禁跟踪标志（`PayasoUpdate.exe inspect <lnk>`）。
4. 主动删除桌面图标后正常启动，确认不会被补建。
5. 管理员安装（降权启动路径）与连续升级各跑一轮。
6. CI 的 headless runner 缺交互桌面，跑不了上述第 1、5 项；候选构建通过不等于实机验收完成。
