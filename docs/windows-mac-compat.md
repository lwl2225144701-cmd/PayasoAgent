# Windows 兼容性改造方案（对照 pi 三层设计 + 工作目录打开修复）

状态：设计稿。目标平台 macOS（现状基准）/ Windows（本方案主战场）。Linux 顺带覆盖（纯 Node 路径均可用，shell 载体同 unix 路径）。

## 0. 结论（TL;DR）

- PayasoAgent 是 **源码分发 + React Web GUI**，不是 TUI、不是二进制分发——pi 的第 3 层（终端交互）与第 4 层（构建产物矩阵）**整体不适用**，但第 1、2 层的核心思想照单全收：**「shell 载体」与「沙箱」解耦**、**平台差异收敛到薄适配层**。
- 当前 Windows 上最大的两处硬伤：**shell 工具整块不可用**（`runtime-tools.ts:338` 以 `probeSandboxAvailability()`=仅 darwin 决定 shell 生死）、**工作区打开/选择器直接 throw**（`workspace.ts:43`）。本方案针对两者给出落地设计。
- 一个现实约束贯穿全文：**浏览器不暴露宿主任意文件夹的绝对路径**，所以文件夹选择必须由 Host 侧进程弹系统对话框（macOS 已是此设计，Windows 照搬此模式）。

## 1. 现状矩阵

| 能力 | macOS（现状） | Windows（现状） | 归属层 |
|---|---|---|---|
| shell 工具 | sandbox-exec 包裹 `/bin/bash` | ❌ fail-closed 拒绝 | Shell |
| 进程树终止 | 沙箱内 timeout 处理 | 无对应路径 | Shell |
| 凭据存储 | Keychain | ✅ 加密文件兜底（v1.6 已做） | 文件系统 |
| 附件库硬链接/只读 | hardlink + chmod 0444 | ⚠️ NTFS hardlink ✓；0444→只读属性导致删除失败 | 文件系统 |
| 路径展示 | 正斜杠 | ⚠️ 附件已统一 `/`，工具输出待审计 | 文件系统 |
| 工作区选择器 | osascript choose folder | ❌ throw「仅支持 macOS」+ 前端静默 | 进程边界 |
| 文件/HTML 默认应用打开 | `/usr/bin/open` | ❌ throw | 进程边界 |
| 工具链受控准备 | brew 系 | 降级 unsupported ✓（随 shell 无意义） | —— |
| 终端交互（TUI） | —— | ——（无 TUI，不适用） | 终端 |
| 构建产物 | tsx 源码直跑 | 同左 ✓ | 发布 |

## 2. Windows 工作区打开修复方案（专题）

### 2.1 现状与病灶

调用链：GUI「选择 Workspace」→ `web/src/App.tsx:545 handleOpenWorkspace` → `api.openWorkspace()` → `POST /workspace/open`（routes.ts:744）→ `openWorkspacePicker()`（workspace.ts:41）。

两个独立病灶叠加：
1. `openWorkspacePicker()` 非 darwin 直接 throw「当前版本仅支持 macOS 本地文件夹选择器」；
2. 前端 `handleOpenWorkspace` 的 `catch` 只 `console.error`，UI 无任何反馈——用户看到的是「点了没反应」。

### 2.2 方案：Host 侧 PowerShell 文件夹对话框

保持 API 契约与 macOS 完全一致（`POST /workspace/open` → `{ workspace, cancelled }`），**前端零改动**，平台差异全部收敛在 `workspace.ts`：

```
win32 → execFile(WindowsPowerShell 5.1, FolderBrowserDialog 脚本)
          ├─ 选目录  → 走与 macOS 相同的 setWorkspace(canonicalizeWorkspaceRoot) 校验链
          ├─ 取消    → 解析为 null（cancelled: true）
          ├─ 超时/失败 → 报错（引导消息）
darwin → 现有 osascript 路径不变
```

关键实现细节：

- **固定用 Windows PowerShell 5.1**（`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`，Win7+ 必有），**绝不用 pwsh/PS7**：PS7 是 .NET Core，默认不带 `System.Windows.Forms`，会直接 `Add-Type` 失败。
- **必须 `-STA`**：`FolderBrowserDialog` 依赖 STA 线程，缺了会抛 `OLE 初始化失败`。

```powershell
# $target 由 JS 侧拼入；输出编码显式 UTF-8，避免中文/空格路径乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '选择 PayasoAgent Workspace'
$d.ShowNewFolderButton = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::WriteLine($d.SelectedPath.TrimEnd([char]0))
}
```

- JS 侧：`execFile(powershell, ['-NoProfile','-STA','-Command', script], { timeout: 120_000 })`；stdout 为空/仅空白 → `null`（取消）；解析出的路径直接交给现有 `setWorkspace()` → `canonicalizeWorkspaceRoot`（isAbsolute + exists + isDirectory + `realpathSync.native`）——**安全校验零新增代码**，与 macOS 同一条链。
- PowerShell 本身不可用（极端裁剪系统）→ `ENOENT` 捕获后报「请安装 Windows PowerShell 或改用 workspace 名称创建」；此引导消息同时解决用户可恢复性问题。

### 2.3 顺带修复：文件/HTML「用默认应用打开」

`default-browser.ts` 硬编码 `/usr/bin/open`，Windows 上该端点报错。分支化 `systemBrowserOpener`：

- win32：`rundll32.exe url.dll,FileProtocolHandler <file://URL>`（Windows 语义上的「默认应用打开」，与 macOS `open` 对齐）；
- linux：`xdg-open <file://URL>`；
- darwin：现有 `/usr/bin/open` 不变。

### 2.4 验收

- Windows：GUI 点「选择 Workspace」→ 弹原生文件夹对话框 → 选目录后 workspace 生效且校验通过；取消无副作用；找不到 PowerShell 时收到可操作报错。
- macOS：行为与现状逐字节一致（回归测试覆盖 `POST /workspace/open`）。

## 3. Shell 工具层改造（Windows 上让 shell 复活）

### 3.1 核心思想：载体与沙箱解耦

现状 `runtime-tools.ts:338` 把「有无 sandbox-exec」当作 shell 前提，Windows/Linux 整块不可用。改为：

```
discoverShellHost()          # 只负责找解释器（新 src/sandbox/shell-host.ts）
darwin → /bin/bash + MacOSSandbox 包裹（现状语义不变，沙箱仍是增强而非前提的载体）
win32  → Git Bash 固定路径三连 → where bash → existsSync 校验
linux  → /bin/bash → which bash → fallback sh
```

Git Bash 查找顺序（对齐 pi）：`%ProgramFiles%\Git\bin\bash.exe` → `%ProgramFiles(x86)%\Git\bin\bash.exe` → PATH 内 `where bash.exe`；全部落空 → 报错「请安装 Git for Windows（https://git-scm.com）」并引导。

### 3.2 安全语义：延续 fail-closed，但把决定权给用户

Windows/Linux 无 sandbox-exec，不能静默降级。三通道（2026-09 起由统一执行器 `src/sandbox/shell-executor.ts` 分派，平台分支已移出 runtime-tools）：

- macOS：Seatbelt 沙箱（enforcement=full）；
- Windows：`PAYASO_SHELL_WINDOWS_ACL=1`（默认关）→ ACL 受限令牌执行器（enforcement=**partial**：写入部分隔离——Everyone 与 NTFS 硬链接例外，读与网络不受限；workspace-write 会在工作区留下持续性授权 ACE，清理入口见下）。**真机验证清单完成前保持关闭**（docs/cross-platform-sandbox-plan.md §5）；
- 其余（含 gate 关闭的 win32、linux）：**仍拒绝**（延续「绝不静默降低遏制」原则）；放行条件：显式环境开关 `PAYASO_SHELL_UNSANDBOXED=1`。

能力报告：`GET /runtime/capabilities` 的 `shellIsolation` 字段（executor / enforcement / writeIsolation / readIsolation / networkIsolation 诚实分级），设置 UI「通用 → Shell 隔离」行展示 partial 警示与 standing ACE 披露。partial 必须可见，不静默放宽权限语义。

standing ACE 清理：`icacls <workspace> /remove <workspaceWriteSid 推导的 SID>`（库不导出 revokeWrite，本期不实现程序化撤销；详见 cross-platform-sandbox-plan.md §3/§5）。

ACL 执行细节（薄 runner `win-acl-runner.mjs` + `windows-acl-sandbox.ts`）：read-only → 仅 scratch 可写（workspace 不授权）；workspace-write/full-access → workspace + scratch；runner 失败（exit 127 + `payaso-win-acl: ` 签名）= 命令未执行，fail-closed 不回退。

### 3.3 进程树终止（配套必需）

无沙箱路径下超时/强制终止由我们自己管。新 `terminateProcessTree(pid)`：

- win32：`taskkill.exe /F /T /PID <pid>`（整树）；
- unix：`process.kill(-pid, 'SIGKILL')`（进程组），失败退回单进程 kill。

spawn 时 `detached: process.platform !== 'win32'`（win 不 detach 防孤儿，对齐 pi）。

### 3.4 WSL（可选，P2）

`C:\Windows\System32\bash.exe` 存在（老 WSL）→ `bash -s` + stdin 传命令避免 argv 转义。建议先只做 Git Bash，WSL 识别放后。

## 4. 文件系统/路径层（缺口小，逐项补）

| 项 | 动作 | 说明 |
|---|---|---|
| 附件只读权限 | win32 跳过 `chmod 0444`（attachment-store.ts） | 0444 在 win 映射为只读属性 → rmSync EPERM，删不掉附件 |
| `~` 展开 | 新增 `expandHome()` 分平台（`~`、`~\`都认） | pi 同款，5 行 |
| 展示路径统一 `/` | 审计 tool 输出/日志中拼接路径 | 附件已统一（`toWorkspaceRel`），抽查 filesystem 工具输出 |
| 云同步 xattr | 不做 | 无云同步目录识别需求（pi 是 mac 独有能力，我们不涉及） |
| 外部编辑器 | 不做 | 无该特性 |

## 5. 不适用层（明确划掉，避免误做）

- **终端交互层（pi 第 3 层）**：我们无 TUI。VT 输入、Kitty keyboard protocol、SIGWINCH、keybinding 分平台全部没有对应物。可借鉴的只有组织模式：**native 能力按平台分发、运行时按 `process.platform` 挑**（sharp prebuilt 已是这个模式的现成例子；`secret-store.ts:36` 已完成同类组合根）。
- **发布构建层（pi 第 4 层）**：源码分发（tsx 直跑），无二进制打包需求；`build-binaries.sh` 六目标矩阵不适用。将来若做桌面壳（Electron/Tauri）再抄。

## 6. 优先级与改动清单

- **P0（核心可用）**：`src/sandbox/shell-host.ts`（载体发现）+ `terminateProcessTree()` + runtime-tools 双通道（darwin 沙箱 / 其他平台审批放行）+ 工作区选择器 win32 分支 + `default-browser` 平台分支 + 附件 chmod win 分支。≈300 行，全部单文件级改动。
- **P1（体验）**：~ 展开、目录路径反斜杠审计、前端「选择 Workspace」失败时 toast（不再静默）。
- **P2（可选）**：WSL stdin 通道、`src/platform/` 目录重组收敛平台差异。

验收基准：全量测试在 macOS 保持 44/45（唯一失败为沙箱环境既有项）；新增 worker 级单测覆盖 `discoverShellHost` 各平台分支（用 `options.platform ?? process.platform` 注入，与 toolchain-manager 同款可测模式）。