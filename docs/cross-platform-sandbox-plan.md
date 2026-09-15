# 跨平台 Shell 沙箱改造方案

状态：**部分实施（2026-09-14）** —— 统一执行器与 Windows ACL 路径已落地（gate 默认关），macOS 行为零变化；**Windows 真机验证未完成**，完成 §5 清单并通过后另行翻默认 gate。日期：2026-09-14。

> **2026-09-14 真机修订（重要）**：原设计假设"受限令牌内执行 Git Bash"。真机探针推翻了这一点 —— MSYS2/WSL 载体在 `WRITE_RESTRICTED` 令牌下**必然**在 DLL 初始化阶段死亡，与安装路径、发现顺序、gate 配置均无关（机制见 §3）。ACL 路径因此改为**只接受原生 PE 载体**（PowerShell，退化 cmd.exe），对不兼容载体 fail-closed 并给出准确诊断。详见 `windows-acceptance-final.md`。

## 0. 实施现状（2026-09-14）

| 项 | 状态 | 落点 |
|---|---|---|
| 统一执行入口 `shell-executor.ts` | ✅ | `selectShellExecutor`（平台+env 可注入纯函数）+ `executeShellCommand`；结果附 `executor`/`enforcement` 元数据 |
| macOS Seatbelt 包装 | ✅ | darwin 分支自 runtime-tools 原样搬运（probe fail-closed、事件形状不变） |
| Windows ACL 执行器 | ✅ 代码就绪 / ⏸ 待真机验证 | `windows-acl-sandbox.ts`（argv 构造、独立 IPC 执行状态报告、taskkill 整树终止） |
| 薄 runner | ✅ 代码就绪 / ⏸ 待真机验证 | `win-acl-runner.mjs`（纯 JS 免 tsx；复用 `@deepseek-ai/dsh-sandbox-windows-acl` 的 AclSandbox） |
| **载体族建模（`runtime`）** | ✅ 真机定案 | `shell-host.ts`：`ShellRuntime = 'native' \| 'msys2' \| 'wsl'`；`isAclCompatibleCarrier`（仅 native 通过）；`discoverNativeShellHost`（PowerShell → cmd.exe，**不回落 bash**）；`describeAclIncompatibleCarrier`（点名真实机制，不误导用户去装 Git for Windows） |
| **前台 shell 实时输出通道** | ✅ | `tools.onShellOutput` → `process-manager.onToolOutput` → Runtime 发 `shell_output_delta` SSE → Timeline"当前 running 卡"显示实时输出（`runtime-tools.ts` 的 `liveShellOutput` 以 `TOOL_OUTPUT_MAX_BYTES` 封顶，防 SSE 洪泛） |
| **命令语言入环境上下文** | ✅ | `instructions.ts` 追加 `Shell:` 行（`describeShellLanguage`）：Windows ACL 下是 PowerShell，无沙箱下是 Git Bash —— 语言不同、语法不通，必须显式告知模型 |
| 能力报告 | ✅ | `shellIsolationCapabilities()`；`GET /runtime/capabilities` 响应 `shellIsolation` 字段；设置 UI"Shell 隔离"行（partial 警示 + standing ACE 披露） |
| gate | ✅ 默认关 | `PAYASO_SHELL_WINDOWS_ACL=1` 启用（`.env.example` 有注释）；判定统一走 `isWindowsAclEnabled(env)`，不再散落硬编码字符串 |
| 测试 | 确定性回归与 Windows 真机验收分开记录 | `shell-executor`（平台矩阵 + fail-closed E2E）、`windows-acl-sandbox`（IPC、执行阶段、可撤销授权、真实 Node 子进程通信）、`platform-shell-host`（载体发现三平台 + ACL 兼容性 + **真机原生载体执行/超时/中止**；POSIX 专属用例在 Windows 上显式 SKIP） |

**关键设计决策（为什么不是直接用 DeepSeek stock runner）**：stock runner 的 argv 契约（`--workspace/--temp/--mode`）无法表达 Payaso 的"read-only 工作区 + 可写受管 scratch"语义——其 read-only 模式零授权（含临时写入），workspace-write 模式必授予 workspace，且其随机私有 temp 目录路径无法预知（HOME 指不进去）。因此写 Payaso 自有薄 runner（`win-acl-runner.mjs`），权限模式映射：

- **read-only** → `AclSandbox{ manageDacls:false, mode:'workspace-write', writableDirs:[scratch], writeSid:tempWriteSid(scratch), tempDir:null }`：scratch 由 `AclWriteGrant.add(scratch, false)` 授权并独立 dispose，workspace 不授权 → 只读；历史 workspace-write 留下的 standing workspace ACE 因 `workspaceWriteSid` 不在 restricting 列表而惰性
- **workspace-write** → 库原生形状：`writableDirs:[workspace] + workspaceWriteSid(workspace)`（standing ACE）+ `tempDir:scratch + tempWriteSid(scratch)`（可撤销 ACE）

runner 以子进程方式运行（Payaso 主进程不加载任何 Win32 FFI）；koffi 自绑 `SetEnvironmentVariableW` 设 `HOME/TMP/TEMP/TMPDIR=scratch`（显式 env block 过 `CreateProcessAsUserW` 会 `ERROR_INVALID_PARAMETER`）。状态通过独立 IPC 报告 `not_started / unknown / completed`；进入 spawn 前即转为 unknown，只有完成等待才为 completed。清理错误单独报告，缺失报告按 unknown 处理；不以 stderr 或退出码断言未执行。

**Full access**：ACL 不支持该模式；仅显式设置 `PAYASO_SHELL_UNSANDBOXED=1` 才走已有无沙箱执行路径，否则明确拒绝，不映射为 workspace-write。

**清理限制**：正常结束及初始化失败会清理可撤销 scratch 授权。spawn/wait 异常导致子进程状态未知时，不在活进程下撤销授权；runner 退出依靠 Job 关闭回收子进程，Host 随后尝试删除 scratch。强制终止、删除失败仍可能留下 ACL 残留，需真机验证与后续清理机制；不宣称所有故障均已清理。工作区 standing ACE 的产品清理入口尚未实现；依赖公开了 `AclWriteGrant`，不能宣称只能用 `icacls` 撤销。

## 1. 目标与范围

保留 Payaso 的权限策略和 macOS 行为，抽出统一 Shell 执行接口，优先验证 DeepSeek Harness Windows ACL runner 的可复用性，为后续 npm/npx 分发准备 Windows 执行能力。

本期只做执行层适配；不改 Agent Loop，不引入 Cordis 插件体系，不扩展 Windows 工具链自动安装。Linux 沙箱与 npm 发布另行实施。

## 2. 最小改动

| 位置 | 改动 | 状态 |
|---|---|---|
| `src/sandbox/shell-executor.ts`（新增） | 统一执行入口与平台选择，接收 Host/Runtime 提供的策略、命令、取消信号、超时和输出回调；返回统一执行结果与隔离能力。 | ✅ |
| `src/sandbox/macos-sandbox.ts` | 包装为执行器，保留现有策略、功能探测与失败拒绝行为。 | ✅（经 shell-executor 包装，文件本身零改动） |
| `src/sandbox/windows-acl-sandbox.ts` + `win-acl-runner.mjs`（新增） | 适配 DeepSeek 独立 ACL runner；受限令牌内执行**原生 PE 载体**（PowerShell），通过 Job Object 回收子进程。 | ✅ 代码就绪 / ⏸ 待真机验证 |
| `src/tools/runtime-tools.ts` | 将平台分支移入执行器；前台与后台共用该入口，保留工具输出预算和错误处理。 | ✅ |
| Host 能力接口与 Web 权限提示 | 展示实际支持范围；无法兑现的权限要求明确返回不可用，不静默放宽。 | ✅（`/runtime/capabilities` 的 `shellIsolation` + 设置 UI） |

沿用 `SandboxPolicy`、`shell-host.ts` 的解释器发现和受管 scratch。工作区、权限、临时目录均由 Host/Runtime 决定，不能由模型参数覆盖。

### 载体族是硬约束（2026-09-14 真机定案）

`WRITE_RESTRICTED` 令牌做**两次**访问检查（普通 SID + restricting SID）。命名管道的默认安全描述符模板不携带 restricting SID，于是：

- **MSYS2/Cygwin**（Git for Windows 的 `bash.exe`、`usr\bin\*`）：DLL 初始化时必须**以写访问打开自己的命名信号管道** → 该 open 被拒（Win32 error 5）→ 进程以 `STATUS_DLL_INIT_FAILED (0xC0000142)` 退出，**任何命令都来不及执行**。
- **legacy WSL**（`System32\bash.exe`）：无法创建 WSL 服务实例 → `E_ACCESSDENIED`。
- **原生 PE**（`powershell.exe`、`cmd.exe`）：正常。`mingw` 系的 `git.exe` 亦正常（不依赖 `msys-2.0.dll`）。

这是**后端固有属性**，不是配置问题：改安装路径、改发现顺序、翻 gate 都不会改变结论。因此：

1. ACL 沙箱**只接受 `runtime === 'native'` 的载体**（`isAclCompatibleCarrier`），由 `discoverNativeShellHost` 单独发现，且**刻意不回落 bash** —— 宁可返回 null 让上层 fail-closed 并给出准确诊断（`describeAclIncompatibleCarrier`），也不放行一个注定在初始化期死掉的载体。
2. `discoverShellHost`（无沙箱路径用）的 win32 顺序修正为 `ProgramFiles\Git → ProgramFiles(x86)\Git → 注册表 InstallPath → PATH bash.exe → legacy WSL`。原顺序把 WSL 排在 PATH 之前，装了 Git for Windows 也可能永远选不到 Git Bash；而 Git Bash 的可用面严格大于 WSL。
3. 命令调用形状由载体语言决定（`buildShellInvocation`）：posix → `-c`；WSL → `-s` + stdin；PowerShell → `-NoProfile -NonInteractive -Command`；cmd → `/d /s /c`。

依赖：`@deepseek-ai/dsh-sandbox-windows-acl@0.1.5-rc.2`（MIT，精确锁版无 `^`；传递依赖 `koffi ^3.1.0`（全平台 prebuild，macOS 装而不用）与 `@deepseek-ai/dsh-win32-process@0.1.5-rc.2`；peer `@deepseek-ai/cordis@4.0.2` 被自动安装为死重——库本体不 import 它）。

## 3. Windows 接入边界

DeepSeek ACL runner 是**部分写入隔离**：不限制读取与网络，Everyone 写权限和 NTFS 硬链接存在例外。不能视为 Payaso macOS 策略的等价实现。

- 能力报告区分：写入隔离程度（partial）、读取限制（none）、网络限制（none）；`partial` 在 Host/Web 可见（设置 → 通用 → Shell 隔离）。
- **命令语言随路径变化**：ACL 路径（gate 开）只有 PowerShell 可用，无沙箱路径是 Git Bash。同一台机器上语言不同、语法不通（如 PowerShell 5.1 不支持 `&&` 串联），故由 `instructions.ts` 把当前语言写进环境上下文，不让模型盲猜。若发现载体不兼容，报错点名真实机制而非"请安装 Git for Windows"（装了也不解决）。
- 要求限制读取或关闭网络时，ACL runner 无法满足。网络：`network.mode=off` 时 shell 被 tools 层全局拒绝（平台无关），开启时不做 OS 层限制——能力报告如实标注 `networkIsolation: 'none'`。
- "只读工作区 + 可写私有 scratch"的 Payaso 语义经薄 runner 的授权形状适配保留（见 §0 映射），不映射为授予 workspace 写。
- Windows ACL 初始化或 runner 启动失败，不回退裸跑（IPC 区分未执行与执行结果不确定）。既有 `PAYASO_SHELL_UNSANDBOXED` 开关仍是独立显式选择。
- 工作区 ACE 持续保留（合成 SID，无账户映射，跨会话复用）；临时 ACE 可撤销（dispose）。scratch 删除在 runner 退出（子进程已结束）之后由 runtime-tools 执行。standing ACE 清理入口待实现并真机验证，不能依赖未验证的 icacls 命令。

## 4. 实施顺序与停止条件

1. **抽接口**：先让 macOS 通过统一执行器运行，验证行为不变。✅ 完成（88 套件全绿后进入下一步）
2. **做 Windows 最小验证**：验证独立 runner 的依赖安装、原生 PE 载体（PowerShell）执行、流式输出、取消和私有 scratch 授权；锁定验证过的依赖版本，保留第三方许可。⏸ **部分完成** —— 载体兼容性、原生载体执行/超时整树终止/预中止已在本机验证通过；§5 其余条目（ACE 生命周期、CJK 路径、runner 失败路径、升级重启）仍待执行。
3. **接入产品**：完成能力提示和策略匹配后，再启用 Windows 部分隔离路径（翻 `PAYASO_SHELL_WINDOWS_ACL` 默认值）。⏸ 阻塞于第 2 步

若现成 runner 无法满足 scratch 或进程生命周期契约，先做薄适配（已按此落地：`win-acl-runner.mjs`）；仍无法满足则保持 Windows 受限执行不可用，不以扩大权限作为替代。若必须实现与 macOS 等价的读取/网络限制，另立更强隔离方案，本期 ACL 接入不承担该目标。

## 5. Windows 真机验证清单（gate 翻默认的前置条件）

环境：干净 Windows 11 + Node ≥ 22.5。**PowerShell 是 ACL 路径的必需载体**（Windows 自带，无需额外安装）；Git for Windows 仅无沙箱路径需要，**不是 ACL 路径的前置条件**（其 MSYS2 载体在受限令牌下不可用，见 §2 载体族）。逐条记录证据，任一失败即保持 gate 关闭并回写本文档。

1. **依赖安装**：`npm ci` 无 cordis 冲突、koffi 原生模块安装成功；`npm pack @deepseek-ai/dsh-sandbox-windows-acl@0.1.5-rc.2` 解包 diff 相邻 `deepseek-harness` 仓库 `packages/sandbox/sandbox-windows-acl/src/`（以发布物为准，不一致项记录后才可继续锁版）。
2. **standing ACE 生命周期**：首次 workspace-write 全树传播；二次 provision 命中 exact-ACE skip（O(1)，无重复传播）；runner dispose 后 scratch ACE 消失、workspace ACE 留存（`icacls <dir>` 检查）。
3. **执行契约**：原生载体（PowerShell）流式输出实时回传至 UI（`shell_output_delta`）；超时 `taskkill /F /T` 整树终止无孤儿进程（kill-on-close Job Object 兜底）；Ctrl+C 后 runner 存活至授权撤销并镜像退出码（含 32 位 NTSTATUS 全宽）。**不兼容载体 fail-closed**：指向 MSYS2/WSL 载体时必须在 spawn 前被拒且诊断准确。
4. **边界**：工作区外写入被拒（`%USERPROFILE%`、其他盘符）；read-only 下工作区写拒绝且 scratch 可写（`echo x > "$HOME/cache.txt"` 成功）；Everyone 写例外与 NTFS 硬链接例外显式复现，确认能力报告如实标注 partial。
5. **跨会话 scratch 隔离**：同 workspace 两个会话，会话 A 的 scratchWriteSid 不能写会话 B 的 scratch。
6. **中文与空格路径**：workspace 与 scratch 路径含 CJK 与空格全程无乱码（argv 传递、错误消息、输出）。
7. **runner 失败路径**：坏 argv / 删除 runner / 指向不存在目录 → 启动前有 IPC 报告时为 not_started，删除 runner 等无报告情况为 unknown；命令执行后 wait/清理失败不得被说成未执行，不回退无沙箱。
8. **standing ACE 清理**：通过依赖的 ACL 授权接口验证 DACL 撤销和恢复；清理后再次 workspace-write 仍能重新授权。
9. **升级/重启**：Host 重启后 standing ACE 复用（无重复传播）；依赖版本升级后行为可解释。
10. **发布前**：干净环境验证 npm 包及原生依赖安装；升级/重启后授权与清理行为可解释。仅通过 mock 或 TypeScript 检查不算完成。

## 本轮验证（2026-09-14，Windows 真机）

在 Windows 11 本机跑 `npm run test:all`：**90 套件 / 74 PASS / 16 FAIL**。为区分"既有"与"回归"，用 `git worktree` 在改动前的 `2d8f513` 跑同一套件作为基线：**同样是 90 套件 / 74 PASS / 16 FAIL，且 16 个失败套件逐项相同**。故这 16 个失败全部为既有/环境性（Windows 跑测机 + `core.autocrlf` CRLF 检出 + symlink/SQLite/darwin 假设的测试），**非本次改动引入**。

本次改动修复其中 2 个套件：

- `platform-shell-host`：载体发现顺序修正（PATH 优先于 legacy WSL）、**宿主路径泄漏修复**（原先 WSL 回落用硬编码 `C:\Windows\System32\bash.exe` 做 `existsSync`，探测会穿出注入的 fake env 命中跑测机真实 WSL，导致结果随"跑测机装了什么"变化），并补上 win32 原生载体的真实执行/超时/中止覆盖。结果 17 PASS / 0 FAIL / 2 SKIP（POSIX 专属用例在 Windows 上显式 SKIP）。
- `docs-contract`：`extractDocList` 在正则匹配前归一化 CRLF→LF（文档因 `autocrlf` 全为 CRLF，原正则假设 LF）。2 FAIL → 7 PASS。

静态检查：主项目 `tsc --noEmit` 与 web `tsc -b` 均 **0 错误**。Biome 对改动文件报 19 处 `format`，经未改动文件 `src/cli.ts` 复现同一报错，确认是全仓库 CRLF 检出伪影（`biome.json` 未设 `lineEnding`，默认 `lf`）；唯一 lint 诊断 `noNonNullAssertion` 在基线同处已存在（664 → 669 行，因上方新增 5 行位移）。本次改动新增 lint 问题为 0。

Windows 真机验收其余条目仍未完成，gate 保持默认关闭。

## 参考

- DeepSeek：`packages/sandbox/sandbox/`（接口）、`sandbox-local/`（平台选择）、`sandbox-windows-acl/`（ACL runner），源码位于相邻 `deepseek-harness` 仓库；npm 发布物 `@deepseek-ai/dsh-sandbox-windows-acl@0.1.5-rc.2`。
- Payaso：`src/sandbox/shell-executor.ts`、`windows-acl-sandbox.ts`、`win-acl-runner.mjs`、`sandbox-policy.ts`、`macos-sandbox.ts`、`shell-host.ts`、`src/tools/runtime-tools.ts`；测试 `tests/shell-executor.test.ts`、`tests/windows-acl-sandbox.test.ts`。
- 本方案补充 `docs/windows-mac-compat.md` 的 Shell 隔离部分；现状以当前源码为准。
