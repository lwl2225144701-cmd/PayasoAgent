# 跨平台 Shell 沙箱改造方案

状态：**部分实施（2026-09-14）** —— 统一执行器与 Windows ACL 路径已落地（gate 默认关），macOS 行为零变化；**Windows 真机验证未完成**，完成 §5 清单并通过后另行翻默认 gate。日期：2026-09-14。

## 0. 实施现状（2026-09-14）

| 项 | 状态 | 落点 |
|---|---|---|
| 统一执行入口 `shell-executor.ts` | ✅ | `selectShellExecutor`（平台+env 可注入纯函数）+ `executeShellCommand`；结果附 `executor`/`enforcement` 元数据 |
| macOS Seatbelt 包装 | ✅ | darwin 分支自 runtime-tools 原样搬运（probe fail-closed、事件形状不变） |
| Windows ACL 执行器 | ✅ 代码就绪 / ⏸ 待真机验证 | `windows-acl-sandbox.ts`（argv 构造、独立 IPC 执行状态报告、taskkill 整树终止） |
| 薄 runner | ✅ 代码就绪 / ⏸ 待真机验证 | `win-acl-runner.mjs`（纯 JS 免 tsx；复用 `@deepseek-ai/dsh-sandbox-windows-acl` 的 AclSandbox） |
| 能力报告 | ✅ | `shellIsolationCapabilities()`；`GET /runtime/capabilities` 响应 `shellIsolation` 字段；设置 UI"Shell 隔离"行（partial 警示 + standing ACE 披露） |
| gate | ✅ 默认关 | `PAYASO_SHELL_WINDOWS_ACL=1` 启用（`.env.example` 有注释） |
| 测试 | 确定性回归与 Windows 真机验收分开记录 | `shell-executor`（平台矩阵 + fail-closed E2E：macOS 上真跑 runner → kernel32 加载失败 → IPC not_started → 结构化报错）、`windows-acl-sandbox`（IPC、执行阶段、可撤销授权、真实 Node 子进程通信） |

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
| `src/sandbox/windows-acl-sandbox.ts` + `win-acl-runner.mjs`（新增） | 适配 DeepSeek 独立 ACL runner；受限令牌执行 Git Bash，通过 Job Object 回收子进程。 | ✅ 代码就绪 / ⏸ 待真机验证 |
| `src/tools/runtime-tools.ts` | 将平台分支移入执行器；前台与后台共用该入口，保留工具输出预算和错误处理。 | ✅ |
| Host 能力接口与 Web 权限提示 | 展示实际支持范围；无法兑现的权限要求明确返回不可用，不静默放宽。 | ✅（`/runtime/capabilities` 的 `shellIsolation` + 设置 UI） |

沿用 `SandboxPolicy`、`shell-host.ts` 的解释器发现和受管 scratch。工作区、权限、临时目录均由 Host/Runtime 决定，不能由模型参数覆盖。

依赖：`@deepseek-ai/dsh-sandbox-windows-acl@0.1.5-rc.2`（MIT，精确锁版无 `^`；传递依赖 `koffi ^3.1.0`（全平台 prebuild，macOS 装而不用）与 `@deepseek-ai/dsh-win32-process@0.1.5-rc.2`；peer `@deepseek-ai/cordis@4.0.2` 被自动安装为死重——库本体不 import 它）。

## 3. Windows 接入边界

DeepSeek ACL runner 是**部分写入隔离**：不限制读取与网络，Everyone 写权限和 NTFS 硬链接存在例外。不能视为 Payaso macOS 策略的等价实现。

- 能力报告区分：写入隔离程度（partial）、读取限制（none）、网络限制（none）；`partial` 在 Host/Web 可见（设置 → 通用 → Shell 隔离）。
- 要求限制读取或关闭网络时，ACL runner 无法满足。网络：`network.mode=off` 时 shell 被 tools 层全局拒绝（平台无关），开启时不做 OS 层限制——能力报告如实标注 `networkIsolation: 'none'`。
- "只读工作区 + 可写私有 scratch"的 Payaso 语义经薄 runner 的授权形状适配保留（见 §0 映射），不映射为授予 workspace 写。
- Windows ACL 初始化或 runner 启动失败，不回退裸跑（IPC 区分未执行与执行结果不确定）。既有 `PAYASO_SHELL_UNSANDBOXED` 开关仍是独立显式选择。
- 工作区 ACE 持续保留（合成 SID，无账户映射，跨会话复用）；临时 ACE 可撤销（dispose）。scratch 删除在 runner 退出（子进程已结束）之后由 runtime-tools 执行。standing ACE 清理入口待实现并真机验证，不能依赖未验证的 icacls 命令。

## 4. 实施顺序与停止条件

1. **抽接口**：先让 macOS 通过统一执行器运行，验证行为不变。✅ 完成（88 套件全绿后进入下一步）
2. **做 Windows 最小验证**：验证独立 runner 的依赖安装、Git Bash 执行、流式输出、取消和私有 scratch 授权；锁定验证过的依赖版本，保留第三方许可。⏸ **待真机执行（§5 清单）**
3. **接入产品**：完成能力提示和策略匹配后，再启用 Windows 部分隔离路径（翻 `PAYASO_SHELL_WINDOWS_ACL` 默认值）。⏸ 阻塞于第 2 步

若现成 runner 无法满足 scratch 或进程生命周期契约，先做薄适配（已按此落地：`win-acl-runner.mjs`）；仍无法满足则保持 Windows 受限执行不可用，不以扩大权限作为替代。若必须实现与 macOS 等价的读取/网络限制，另立更强隔离方案，本期 ACL 接入不承担该目标。

## 5. Windows 真机验证清单（gate 翻默认的前置条件）

环境：干净 Windows 11 + Node ≥ 22.5（Git for Windows 必装）。逐条记录证据，任一失败即保持 gate 关闭并回写本文档。

1. **依赖安装**：`npm ci` 无 cordis 冲突、koffi 原生模块安装成功；`npm pack @deepseek-ai/dsh-sandbox-windows-acl@0.1.5-rc.2` 解包 diff 相邻 `deepseek-harness` 仓库 `packages/sandbox/sandbox-windows-acl/src/`（以发布物为准，不一致项记录后才可继续锁版）。
2. **standing ACE 生命周期**：首次 workspace-write 全树传播；二次 provision 命中 exact-ACE skip（O(1)，无重复传播）；runner dispose 后 scratch ACE 消失、workspace ACE 留存（`icacls <dir>` 检查）。
3. **执行契约**：Git Bash 流式输出实时回传；超时 `taskkill /F /T` 整树终止无孤儿 bash.exe（kill-on-close Job Object 兜底）；Ctrl+C 后 runner 存活至授权撤销并镜像退出码（含 32 位 NTSTATUS 全宽）。
4. **边界**：工作区外写入被拒（`%USERPROFILE%`、其他盘符）；read-only 下工作区写拒绝且 scratch 可写（`echo x > "$HOME/cache.txt"` 成功）；Everyone 写例外与 NTFS 硬链接例外显式复现，确认能力报告如实标注 partial。
5. **跨会话 scratch 隔离**：同 workspace 两个会话，会话 A 的 scratchWriteSid 不能写会话 B 的 scratch。
6. **中文与空格路径**：workspace 与 scratch 路径含 CJK 与空格全程无乱码（argv 传递、错误消息、输出）。
7. **runner 失败路径**：坏 argv / 删除 runner / 指向不存在目录 → 启动前有 IPC 报告时为 not_started，删除 runner 等无报告情况为 unknown；命令执行后 wait/清理失败不得被说成未执行，不回退无沙箱。
8. **standing ACE 清理**：通过依赖的 ACL 授权接口验证 DACL 撤销和恢复；清理后再次 workspace-write 仍能重新授权。
9. **升级/重启**：Host 重启后 standing ACE 复用（无重复传播）；依赖版本升级后行为可解释。
10. **发布前**：干净环境验证 npm 包及原生依赖安装；升级/重启后授权与清理行为可解释。仅通过 mock 或 TypeScript 检查不算完成。

## 本轮验证

类型检查、改动文件 Biome 检查及 90 个确定性套件通过（macOS，18.0s）。沙箱内首次回归因本地监听 EPERM 失败，获准在沙箱外重跑后全绿。Windows 真机验收仍未完成，gate 保持默认关闭。

## 参考

- DeepSeek：`packages/sandbox/sandbox/`（接口）、`sandbox-local/`（平台选择）、`sandbox-windows-acl/`（ACL runner），源码位于相邻 `deepseek-harness` 仓库；npm 发布物 `@deepseek-ai/dsh-sandbox-windows-acl@0.1.5-rc.2`。
- Payaso：`src/sandbox/shell-executor.ts`、`windows-acl-sandbox.ts`、`win-acl-runner.mjs`、`sandbox-policy.ts`、`macos-sandbox.ts`、`shell-host.ts`、`src/tools/runtime-tools.ts`；测试 `tests/shell-executor.test.ts`、`tests/windows-acl-sandbox.test.ts`。
- 本方案补充 `docs/windows-mac-compat.md` 的 Shell 隔离部分；现状以当前源码为准。
