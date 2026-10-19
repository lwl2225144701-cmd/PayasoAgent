# Windows Full access 仍留在受限令牌内

状态：**已按本文步骤实施**。日期：2026-10-19。分支：`glune`。

## 要达到的作用

和 macOS 的 Full access 对齐，只对齐作用，不拆掉沙箱：

- 命令要能启动。
- 进程仍在 Windows 的 `WRITE_RESTRICTED` 受限令牌里。
- 能写的地方 = 当前用户本来就能写的地方。用户写不了的地方仍然写不了。
- `read-only` 和 `workspace-write` 继续只授权临时目录或当前项目，逻辑不改。

macOS 的 Seatbelt 在 Full access 下仍然包着进程，只是加上 `file-read*` / `file-write*`。Windows 的受限令牌写文件要过两道检查：第一道是用户自己的权限，第二道只认 restricting SID 列表里的身份。现在这个列表是：

- `read-only`：登录 SID + Everyone
- `workspace-write`：上面两个，再加工作区 SID 和临时目录 SID

所以第二道只放行那几个被单独授权的目录。库 `@deepseek-ai/dsh-sandbox-windows-acl@0.1.5-rc.2` 的 `AclSandbox.mode` 只有这两档，加不进「用户自己的身份」。这就是 Full access 被整段拒绝的原因。

网络对不齐，本文不解决：这个令牌只管写，不管网络。macOS 可以在沙箱里单独关网络。当前默认网络是开的，日常作用一致。

## 做法

Full access 不调用 `AclSandbox`，也不给任何目录加新的 ACE。单独建一个受限令牌，restricting SID 列表是：

- 登录 SID 和 Everyone（库里两档都保留，否则 PowerShell 初始化会失败）
- 当前令牌里已启用、且不是 deny-only 的组 SID（包含用户自己的组）
- 当前令牌的用户 SID

不把完整性级别降到 Low。Low 会让用户目录写失败，和 macOS 的作用相反。

令牌创建失败就抛错，禁止退回不受限进程。命令用现有的 `spawnInheritedJobProcess` 在这个令牌里启动，载体仍是原生 PowerShell / cmd。

## 实施步骤

按顺序做。未列出的行为不动。

### 步骤 1

本文件即步骤 1。

### 步骤 2

`src/sandbox/windows-acl-sandbox.ts` 的 `buildWindowsAclRunnerArgv` 接受 `full-access`，把 `--mode full-access` 传给 runner。不要再抛「does not support Full access」。不要把它改写成 `workspace-write`。

### 步骤 3

`src/sandbox/shell-executor.ts` 的 `executeWindowsAcl` 去掉 Full access 的提前拒绝。三种权限都进入 `runWindowsAclShell`。没有原生载体时的 fail-closed 文案保持原样。

### 步骤 4

`src/sandbox/win-acl-runner.mjs`：

- `parseArgs` 接受 `full-access`。
- `executeWithSandbox` 在 `full-access` 时调用新模块，不构造 `AclSandbox`，不加目录 ACE。
- 非 win32 调用这一档时直接失败，不加载 Win32。
- `scripts/copy-runtime.mjs` 把 `win-acl-full-access.mjs` 和 runner 一起复制到 `dist/sandbox`。TypeScript 不会复制 `.mjs`。

新文件 `src/sandbox/win-acl-full-access.mjs`：

- 用 `@deepseek-ai/dsh-win32-process` 的 `extendWin32ProcessBindings` 绑定 `CreateRestrictedToken` 和读取令牌 SID 所需的 API。指针必须来自这一套绑定，才能交给 `spawnInheritedJobProcess`。
- `CreateRestrictedToken` 的标志是 `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`。
- restricting 列表按上一节。
- 启动前把 `HOME`、`TMP`、`TEMP`、`TMPDIR` 设为 scratch，和另外两档一样，子进程继承。
- 任何 Win32 失败在 `spawn` 之前抛出。

### 步骤 5

测试：

- `tests/windows-acl-sandbox.test.ts`：`full-access` 的 argv 含 `--mode` 且值为 `full-access`，不再期望抛错。
- `tests/shell-executor.test.ts`：非 win32 跳过。win32 上 `PAYASO_SHELL_WINDOWS_ACL=1` 且不设 `PAYASO_SHELL_UNSANDBOXED`。
  - Full access 执行 `Write-Output BYPASS_OK`，退出码 0，stdout 含 `BYPASS_OK`，`executor` 仍是 `windows-acl`。
  - 同一个 Full access 命令能在工作区外写一个当前用户可写的文件。
  - 同一个路径用 `workspace-write` 写，必须失败。

### 步骤 6

设置页不把执行器改名，仍显示「Windows ACL 受限令牌」。仅当当前权限是 `full-access` 且执行器是 `windows-acl` 时，描述改为：

- zh-CN：`三种权限都在受限令牌内。Full access 的写入按当前用户权限放行；read-only 与 workspace-write 仍只授权规定目录。`
- en-US：`All three modes stay inside the restricted token. Full access writes follow the current user's permissions; read-only and workspace-write still grant only the designated directories.`

文案键：`settings.shellIsolation.fullAccessNote`。

### 步骤 7

在 `docs/sandbox/cross-platform-sandbox-plan.md` 的「Full access」原句后追加，不删原句：

> 2026-10-19 修订（见 `docs/plans/windows-full-access-token-plan.md`）：Full access 仍创建 `WRITE_RESTRICTED` 令牌，但 restricting SID 改为当前用户已有身份，因此写入范围与该用户一致。read-only 与 workspace-write 的目录授权不变。`PAYASO_SHELL_UNSANDBOXED` 仍不是这一档的入口。

### 步骤 8

运行：

```bash
npx tsx tests/windows-acl-sandbox.test.ts
npx tsx tests/shell-executor.test.ts
```

两条都要通过。跑第二条前先去掉进程环境里的 `PAYASO_SHELL_WINDOWS_ACL`，否则「gate 关」那条用例会误走沙箱。

### 步骤 9

`npm run build:server` 与 `npm run build:web`。停掉占用 4500 的 Host 和正在运行的 PayasoAgent，再用 `node --env-file=.env dist/host/index.js` 拉起 Host，然后启动已安装的 PayasoAgent。确认 `GET /runtime/capabilities` 的 `shellIsolation.executor` 仍是 `windows-acl`。
