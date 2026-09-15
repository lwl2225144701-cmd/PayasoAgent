# npm / npx 分发改造方案

状态：**部分实施（2026-09-14）** —— §3 七项改造点已全部落地（未提交），本地 tarball 打包与冒烟验证通过；**尚未做干净目录外的完整体验验收与 npm 发布**。日期：2026-09-14。

## 1. 目标

将 PayasoAgent 从源码启动改为 npm 包分发：用户安装 Node.js 后，一条命令启动本地 Host 和 Web UI，无需克隆仓库、构建前端或准备 `.env`。

```bash
npx payaso-agent@latest
```

以上为目标命令，包名与发布权限待确认。程序仍在用户电脑上运行，默认监听 `127.0.0.1`；本方案不涉及云端托管、桌面安装包或 Runtime 重构。

第一阶段以 macOS 完整体验为验收范围。Windows 保留现有实验 gate，跨平台沙箱验收独立推进。

## 2. 用户体验

1. 执行命令，检查 Node 版本并启动服务，默认端口 4500。
2. 服务就绪后打开浏览器；打开失败时打印可访问地址，服务继续运行。
3. 首次使用通过现有设置页面添加模型，再选择工作区；不自动将启动目录授权给 Agent。
4. 重启或升级后保留模型配置、会话与恢复数据。Ctrl+C 沿用现有优雅退出流程。

最小命令参数：`--port`、`--no-open`、`--version`、`--help`。端口占用时明确报错并提示换端口，不自动连接未知服务。

## 3. 核心改造

| 改造点 | 最小实现 |
|---|---|
| npm 命令入口 | 新增带 Node shebang 的启动入口并声明 `package.json.bin`；默认启动 Web 应用，与现有单次任务 CLI 分开。 |
| 发布前构建 | 增加后端生产构建配置，输出 Node 可执行 ESM；前端提前构建。运行时不依赖 `tsx`、TypeScript 或 Vite。 |
| 安装与开发分离 | 移除发布包中递归安装 `web/` 的 `postinstall`；源码开发另设初始化步骤，并同步 CI。保留原有开发命令。 |
| 静态资源 | 发布前将 Web 产物放入固定包内目录，使用 `import.meta.url` 定位，不再依赖 `process.cwd()`。 |
| 数据路径 | 新增统一应用路径模块，集中解析数据库、checkpoint、默认托管工作区等持久路径；保留已有显式路径覆盖配置。 |
| 首次配置 | 新启动入口不要求 `.env`；优先使用已有持久配置，无配置时引导打开设置。保留显式环境变量的一次性导入能力。 |
| 发布内容 | 用 `files` 白名单包含后端产物、Web 产物、必要 `.mjs` runner 与许可；排除 `.env`、运行数据、测试日志和开发文件。 |

普通 JS 依赖及 `sharp`、Windows ACL / `koffi` 等原生依赖继续通过 npm 安装；“用户无需构建前端”不等于“没有运行依赖”。后端构建必须保留原生模块加载边界及 `win-acl-runner.mjs` 的相对路径，不能只复制编译后的 `.ts` 产物。

## 4. 路径与兼容

| 路径类别 | 约定 |
|---|---|
| 程序与静态资源 | npm 安装目录，只读使用；不写入 npx 缓存。 |
| 应用持久数据 | 默认 `~/.payaso/`，可用 `PAYASO_HOME` 指定绝对目录；包含数据库、checkpoint、默认托管工作区等。 |
| 用户工作区 | 保留用户选择的真实项目目录；附件等已有工作区内容继续按现有契约存放。 |
| Shell scratch | 保留现有受管短临时目录和清理机制，不搬入较长的用户数据路径，避免 Unix socket 路径长度回归。 |
| 凭证 | macOS 继续用 Keychain；非 macOS 加密凭证文件的路径随应用路径配置一致解析，避免产生第二套配置。 |

开发运行与 npm 运行共用路径解析逻辑。旧仓库中的数据库、checkpoint、默认 sandbox 不自动搬迁：提供明确迁移步骤，成组备份和迁移；校验数据库及 checkpoint 中记录的绝对工作区路径，不能只复制数据库便宣称恢复可用。旧数据在迁移验证完成前保留。

## 5. 实施顺序与验收

1. **先整理路径与启动入口**：保留当前功能，验证从任意目录启动、无 `.env` 启动和优雅退出。
2. **再制作发布包**：构建后执行 `npm pack`，在仓库外的干净目录安装生成的 tarball，验证只依赖发布文件和生产依赖即可启动；检查包内没有密钥或运行数据。
3. **验证完整体验**：首次配置模型、选择工作区、执行任务、停止任务、重启恢复历史；模拟版本升级和旧数据迁移，确认数据与凭证仍可用。
4. **最后发布**：确认包名、版本、发布权限和许可后发布 npm；用真实 `npx <包名>@<版本>` 再验一次。发布前不得把本地 tarball 验证说成线上分发已完成。

验收必须覆盖：无开发依赖、无源码目录、中文与空格路径、端口占用、浏览器打开失败、原生依赖安装，以及 macOS Shell 现有权限行为。类型检查、相关定向测试与全量确定性回归通过后交付；Windows 安装成功不代表 Windows 沙箱已验收。

## 实施现状与验证记录（2026-09-14）

| 改造点 | 状态 | 落点 |
|---|---|---|
| npm 命令入口 | ✅ | `bin/payaso.cjs`（shebang、Node≥22.5 检查、`--port/--no-open/--version/--help`、不读当前目录 `.env`）+ `package.json` `bin` 字段 |
| 发布前构建 | ✅ | `tsconfig.build.json` + `build:server`（tsc + `scripts/copy-runtime.mjs`）、`prepack` 全量构建（server + web + `scripts/generate-notices.mjs` 许可） |
| 安装与开发分离 | ✅ | 根 `package.json` 移除递归安装 `web/` 的 `postinstall`；CI 同步修改 |
| 静态资源 | ✅ | `src/app-paths.ts` 以 `import.meta.url` 定位 `packageRoot`/`webStaticRoot`；`static-handler.ts` 不再依赖 `process.cwd()` |
| 数据路径 | ✅ | `src/app-paths.ts`（`PAYASO_HOME` / `~/.payaso`）被 sqlite、checkpoint、凭证、sandbox、附件五处消费，显式 env 覆盖全部保留 |
| 首次配置 | ✅ | bin 入口不读 `.env`；无持久配置时打印"在页面左下角设置中配置模型，再选择工作区" |
| 发布内容 | ✅ | `files` 白名单 `bin/ dist/ web/dist/ THIRD_PARTY_NOTICES.md`；`npm pack` 产物 175 文件 / 2.7MB |

### 本轮验证（macOS，Node 22.22.3）

- 类型检查 `tsc --noEmit` 通过；全量确定性回归 90 套件全绿（17s）。
- 干净目录（`mktemp -d`）`npm install payaso-agent-2.2.0.tgz` 成功（108 包，无 dev 依赖、无源码目录）。
- 打包产物冒烟：任意 cwd、无 `.env`、`PAYASO_HOME` 指向临时目录 → Host 启动，`GET /` 200（zh-CN UI），`GET /runtime/capabilities` 正常（macos-seatbelt full），数据落 `PAYASO_HOME/payaso.db`。
- `PAYASO_HOME` 含中文与空格路径全程正常（启动、HTTP、落盘）。
- 端口占用：明确报错 `Port N is in use. Choose another port with --port.`，exit 1，不连接未知服务。
- SIGINT：优雅退出，exit 0。
- 包内容检查：无 `.env`/日志/checkpoint/测试文件；无 `sk-` 密钥模式命中。
- **完整体验验收（人工，2026-09-14 通过）**：干净目录 `~/Downloads/myProject/test_payasoAgent` 安装 tarball，UI 完成首次模型配置（密钥入 Keychain）、选择含中文/空格路径的工作区、执行真实任务并中途停止；Ctrl+C 优雅退出后重启，历史会话与消息完整、可继续对话。数据全程隔离在 `test_payasoAgent/app-home/`，未污染 `~/.payaso` 与源码目录。

### 未完成

1. **npm 发布**（§5 第 4 步）：版本 2.2.0；包名 `payaso-agent` 经查 registry 未被占用；发布账号未登录（`npm whoami` 报 ENEEDAUTH）；license 字段未定。
2. **真实数据搬迁**：演练已通过（见下），待用户实际切换运行方式时按迁移表执行一次。

### 迁移演练（2026-09-14 通过）

以只读方式复制真实旧数据（Host 运行中，DB 用 `sqlite3 .backup` 一致性快照，附件/checkpoint 直接拷贝）到演练目录：DB 144 runs / 65 sessions / 52k events、附件 5 文件、checkpoint 299 文件（36MB）。凭证目录 `~/.payaso-agent` 不存在（macOS 走 Keychain），跳过。

以 `PAYASO_HOME=演练目录` 启动包实例：启动无错误，`GET /runs` 返回完整历史且内容可读——**演练通过**。

发现（符合 §4 预期，写入迁移注意）：47 个历史 workspace_root 中 32 个已不存在（旧 `sandbox/workspaces/<uuid>` 被清理、部分为已过期的 `/private/tmp` 路径）——历史会话可查看，但**对已消失 workspace 的旧 run 执行恢复/文件读取会失败**，属预期行为；恢复旧任务前应先在 UI 重新选择有效工作区。
3. Windows：本方案不改变 Windows 实验 gate 状态；安装成功不代表 Windows 沙箱已验收（见 `docs/cross-platform-sandbox-plan.md` §5）。

### 旧数据迁移（不自动搬迁，手动成组操作）

以下迁移均在 **Host 停止状态下**进行，目标目录为 `~/.payaso/`（或 `PAYASO_HOME` 指向的目录）：

| 旧位置（源码运行） | 新位置 | 说明 |
|---|---|---|
| `<仓库>/.data/payaso.db`（含 `-wal`/`-shm`） | `~/.payaso/payaso.db` | 会话、事件、模型配置；随库迁移的绝对 workspace 路径仍指向旧目录，迁移后需在 UI 重新打开或确认旧目录仍在原位 |
| `<仓库>/.data/attachments/v1/` | `~/.payaso/attachments/v1/` | 附件内容库，必须与数据库同批迁移，否则附件引用悬空 |
| `<启动目录>/.checkpoints/` | `~/.payaso/checkpoints/` | Run 断点；checkpoint 内记录的绝对 workspace 路径同理需校验 |
| `~/.payaso-agent/`（旧凭证目录） | `~/.payaso/credentials/` | 非 macOS 加密凭证；macOS 用 Keychain，无此文件则跳过 |

迁移后启动一次并验证：会话历史可见、附件可读、选中工作区后执行任务成功，再删除旧目录（迁移验证完成前保留旧数据）。

## 参考落点

- `package.json`、`tsconfig.json`、`web/vite.config.ts`：启动与构建。
- `src/host/index.ts`、`src/host/routes/static-handler.ts`：Host 生命周期与静态文件。
- `src/host/persistence/sqlite-store.ts`、`src/persistence/file-checkpoint-store.ts`、`src/sandbox/sandbox-manager.ts`：当前依赖源码目录或启动目录的数据路径。
- `docs/cross-platform-sandbox-plan.md`：独立的跨平台沙箱实施与验收边界。
