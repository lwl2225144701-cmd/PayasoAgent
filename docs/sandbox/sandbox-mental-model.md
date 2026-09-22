# 沙箱分层心智模型

> 定位：面向**理解**的概念文档——回答「沙箱到底是什么、分几层、每层守什么、为什么这么设计」。
> 与 `cross-platform-sandbox-plan.md`（实施方案：Windows ACL 细节、实施状态、真机验证清单）互补，两者不重复。
> 最后更新：2026-09-22。代码指证以当前源码为准。

## 0. 一句话定位

**沙箱 = 一套「圈住 Agent 能力」的白名单系统。** Agent（LLM）会生成任意 shell 命令，
这些命令不可信，所以必须让它们跑在一个**「默认全禁、逐项放行」**的环境里。

它不是 Docker、不是虚拟机。macOS 上它是 **三层 JS 策略 + 一层内核强制**叠出来的：

```
① 应用层路径校验（纯 JS 逻辑，管「能摸哪个文件」）
     └─ ② 权限模式（read-only / workspace-write / full-access）
          └─ ③ 工具链白名单（管「能跑哪些程序 + 它们的 PATH」）
               └─ ④ OS 沙箱（内核 seatbelt，管「读/写/执行/联网」四件事）
```

---

## 1. 为什么需要沙箱

Agent 会执行任意 shell 命令。命令字符串来自 LLM，不可枚举、
不可逐字符信任（`curl … | sh`、`rm -rf`、读 `/etc/passwd` 都可能出现）。
所以必须有一个**内核级兜底**：无论命令里写了什么，它的文件/网络系统调用都被拦住。

关键区分——**文件工具和 shell 工具走两条完全不同的防线**：

| 工具 | 防线 | 原因 |
|---|---|---|
| `read` / `write` / `edit` / `grep` / `glob` | ① 应用层路径校验（纯 JS） | 参数是 LLM 给的，可逐字符校验、可用 realpath 折叠 symlink |
| `shell` | ④ OS 沙箱（内核 seatbelt） | 命令会干什么**不可枚举**，只能靠内核兜住所有系统调用 |

这解释了为什么 shell 必须上内核、而文件工具只需逻辑校验。

---

## 2. 逐层详解

### ① 应用层路径校验 —— `src/sandbox/sandbox-manager.ts`

与 OS 无关，纯路径/文件系统逻辑。回答一个问题：
**Agent 报上来的路径，真实指向是不是还在 workspace 里？**

- workspace 根 = `<sandboxRoot>/workspaces/<runId>`；`runId` 白名单校验
  （拒绝 `../`、路径分隔符、绝对路径、盘符）。
- `resolveWorkspacePath`：拒绝绝对路径、`..`，双保险「解析结果必须还在 workspace 内」。
- `assertInsideRoot`：**realpath 级校验**——即使目标是个 symlink 指向 workspace 外，
  也会被真路径折叠揪出来（含**悬空 symlink**，向上找最近存在的祖先做 realpath）。
- `cleanupWorkspace`：只允许删当前 runId 的 workspace，绝不越界删上级。

### ② 权限模式 —— `src/permission-mode.ts`

三档（`PERMISSION_MODES`）：`read-only` / `workspace-write`（默认）/ `full-access`。
Run 创建时快照，LLM 不可改。它决定 `SandboxPolicy.writableRoots` 里放什么：

- `read-only` → 可写根为空（仅 scratch）
- `workspace-write` → 可写根 = `[workspace]`
- `full-access` → 放宽文件系统，但仍套 seatbelt（见 ④）

### ③ 工具链白名单 —— `src/sandbox/toolchain-manager.ts`

**这是最容易被忽视、也最关键的一层。** 它回答「沙箱里到底能跑哪些程序、PATH 是什么」。
启动时探测 `DEFAULT_TOOLCHAIN_COMMANDS = ['git', 'node', 'npm']` 三个命令：

- 解析每个命令的**可执行路径** + 它们的**动态库依赖闭包**（`machODependencyClosure`，用 otool 扫 dylib），
  确保 git 的 helper、npm 的软链、node 的 dylib 在沙箱里都够得着。
- 拼出三样东西：
  - **`safePath`** = 沙箱里 shell 的 `PATH`
    （node 目录 + git 目录 + npm 目录 + `/bin:/sbin:/usr/bin:/usr/sbin`）
  - **`readableRoots`** = 能读的根（workspace + scratch + 系统路径 + 工具链 dylib 闭包）
  - **`executableRoots`** = 能**执行**的根（系统路径 + node/git/npm 目录 + scratch）

> ⚠️ 核心事实：白名单**按 Node 技术栈设计**（就 `git/node/npm` 三个命令）。
> 所以 `node`/`npm` 天然可跑；`python3`(Homebrew)、`tesseract`、`qpdf` 不在白名单里，
> 「能读不能执行」。这是「skill 换 Node 生态」那条决策链的沙箱侧根因。

### ④ OS 沙箱 —— `src/sandbox/macos-sandbox.ts`

shell 工具跑命令时，**不是**直接 `spawn("bash")`，而是：

```js
spawn("/usr/bin/sandbox-exec", ["-p", <seatbelt profile>, "/bin/sh", "-c", 命令])
```

`profileFor()` 把 ①②③ 的内存策略翻译成**内核强制规则**（seatbelt profile）：

```
(version 1)
(deny default)                                    ← 默认全禁（白名单模式）
(import "system.sb")                              ← 借苹果系统基线（dyld 引导必需）
(allow process-fork) (allow process-exec)         ← 允许派生进程
(allow signal) (allow sysctl-read)
(deny network*)                                   ← 默认断网（network.mode != on 时）
(allow file-read* (subpath <可读根>))
(allow file-read* process-exec (subpath <可执行根>))   ← 能读 + 能执行（两码事！）
(allow file-write* (subpath <可写根>))
```

设计要点：

- **`deny default` + 白名单**：没被显式 allow 的，全部 deny。fail-closed。
- **读 / 写 / 执行 三个独立边界**：`readableRoots` ≠ `executableRoots` ≠ `writableRoots`。
  `isExecutableRoot()` 判定「能读 + 能执行」，普通可读根只加 `file-read*`。
- **网络独立开关**：Network Capability Separation——文件权限 ≠ 网络权限；
  `deny` 优先于 `allow`，且 shell 的 deny 是固定语义（联网能力必须走独立的 Browser/Network provider，
  绝不重新放开 shell）。

### 辅助层

- **scratch**（`src/sandbox/shell-scratch.ts`）：受管临时根，macOS 主根 `/tmp/payaso-shell`。
  作为 shell 的 `HOME`/`TMPDIR`，**所有权限模式下可写、且是 workspace 外唯一允许的可写根**
  （read-only 模式命令仍需要缓存目录）。`PAYASO_SHELL_SCRATCH_ROOT` 是 **Host 侧**覆盖变量，
  **不进入子 shell env**——脚本里用 `$TMPDIR` 而非这个变量。
- **命令副作用分类**（`src/sandbox/shell-command-effect.ts`）：判定命令是 `read` 还是
  `non_idempotent`，决定是否走 side-effect 生命周期。
- **统一执行入口**（`src/sandbox/shell-executor.ts`）：按平台选执行器
  `macos-seatbelt` / `windows-acl` / `uncontained-gated`，并诚实报告隔离能力
  （`executor` / `enforcement` / `writeIsolation` / `readIsolation` / `networkIsolation`）。

---

## 3. 三条关键认知

1. **「能读」≠「能执行」** —— 这是最容易踩的坑。`/opt/homebrew/bin` 在 `readableRoots`
   （能读）但不在 `executableRoots`（不能 exec），所以 host 装好的 `python3`/`tesseract`
   在沙箱里「看得见、用不了」。

2. **文件工具 vs shell 是两条防线** —— 见 §1 表格。别把「文件工具的安全校验」误当成
   「shell 也安全」：shell 靠内核，文件工具靠逻辑。

3. **fail-closed 贯穿一切** —— 沙箱不可用（如 Linux 无 seatbelt）→ 拒绝执行，
   绝不静默降级到无沙箱。`uncontained-gated` 需显式 `PAYASO_SHELL_UNSANDBOXED=1`，
   且能力报告如实标注 `enforcement: 'none'`。

---

## 4. 一个类比锚定

> 想象一栋楼：
> - **③ 工具链白名单** = 提前登记的访客名单（只有 node/git/npm 在名单上，
>   还备注了它们的朋友圈 = dylib 依赖闭包）
> - **①② 权限策略** = 各楼层通行规则（哪些房间能看、能写）
> - **④ seatbelt** = 门口的 X 光安检门（内核级，不在名单或越界，直接拦下）
> - **应用层路径校验** = 前台核对身份证（纯逻辑，防 symlink 伪造身份）

---

## 5. 与 skill / 生态的关系（串回「为什么换 Node」）

前面几轮讨论过「pdf skill 换 Python 生态 → Node 生态」，它的沙箱侧根因就是第 ③ 层：

- 工具链白名单**按 Node 技术栈**（`git/node/npm`）设计，Node 工具天然在白名单内。
- Python 生态的 `python3`(Homebrew) / `tesseract` / `qpdf` / `pdftotext` 都不在白名单里，
  「够不着」不是 bug，是白名单按宿主技术栈收紧的**设计使然**。
- 结论：skill 的运行时应与宿主技术栈**同构**。用 Node 生态不是「绕过沙箱」，
  而是让 skill 落在沙箱默认放行的那一类里。

---

## 6. 代码索引

| 文件 | 职责 |
|---|---|
| `src/sandbox/sandbox-manager.ts` | ① 应用层路径校验：workspace 生命周期、realpath 防 symlink 逃逸 |
| `src/permission-mode.ts` | ② 权限三档定义与快照 |
| `src/sandbox/toolchain-manager.ts` | ③ 工具链白名单：探测 git/node/npm、拼 safePath / 可执行根 / dylib 闭包 |
| `src/sandbox/sandbox-policy.ts` | 内存策略：readable / executable / writable / scratch / network 五边界 |
| `src/sandbox/macos-sandbox.ts` | ④ seatbelt profile 翻译 + sandbox-exec 启动 + child env 构造 |
| `src/sandbox/shell-scratch.ts` | 受管 scratch 根（HOME/TMPDIR） |
| `src/sandbox/shell-executor.ts` | 平台选择 + 隔离能力诚实报告 |
| `src/sandbox/shell-command-effect.ts` | 命令副作用分类（read vs non_idempotent） |
| `src/sandbox/windows-acl-sandbox.ts` + `win-acl-runner.mjs` | Windows ACL 部分写入隔离（详见 cross-platform-sandbox-plan.md） |

相关文档：`docs/sandbox/cross-platform-sandbox-plan.md`（实施方案）、`docs/sandbox/windows-mac-compat.md`（Shell 隔离部分）。