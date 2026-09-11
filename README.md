# PayasoAgent

自研的 **LLM 驱动工具调用 Agent 运行时**：`LLM 决策 → 工具执行 → 结果回传` 的 Agent Loop 内核，外加一层 **Host API（HTTP + SSE）** 与一个 **React Web UI**。后端纯 Node 内置能力（`node:http` / `fetch` / `node:sqlite`），无第三方运行时框架；前端为独立 Vite 工程。

* **本地单机**：Host 仅监听 `127.0.0.1:4500`，无多租户、无云端依赖

* **安全优先**：shell 在 macOS seatbelt 沙箱内执行（fail-closed），API 密钥存 macOS Keychain 不落库

* **当前版本：v2.2**

> 完整架构与契约（工具清单、Trace 事件、API、安全边界）以 [docs/architecture-current.md](docs/architecture-current.md) 为唯一权威文档。

## 当前能力

**Agent 运行时**

* Agent Loop：工具重试/失败恢复、防死循环、Checkpoint/Resume（中断后从断点续跑）；无固定迭代上限，由模型收尾/取消/错误/Harness 策略终止

* 内核不变量（v1.8）：回合终态必须有可见产出（空回答按 Harness 策略有界恢复，用尽则失败，绝不静默完成）；工具参数必须满足声明 schema；只有瞬时错误才重试

* Side-Effect Safety：non-idempotent 操作三态生命周期（executing/succeeded/uncertain），崩溃恢复不重复副作用

* Tool Output Guard：单工具结果 16KB 硬上限（预算与切片算法为 `src/tool-output-budget.ts` 单一来源），防止大输出撑爆 Context

* True Cancellation：AbortSignal 全链路传播（Host → Agent → LLM 请求 → shell 进程组），`running → stopping → stopped`

* 原子终态落盘：终态状态与终态事件在同一 SQLite 事务提交，崩溃不出现"状态完成但事件丢失"

**工具集**

* 文件：`ls` / `read`（行号 + offset/limit 分页，超预算保留首尾并给出精确续读区间）/ `write`（原子写）/ `edit`（精确替换）/ `grep`（正则递归搜索，默认忽略依赖/产物目录）/ `glob`（按模式查找文件，mtime 排序）/ `moveFile` / `deleteFile`

* `shell`：macOS `sandbox-exec` 执行，输出上限 64KB，**超时默认 120s 可配**（模型可传 `timeoutMs`，上限 600s）；`background=true` 立即返回 jobId，用 `shellJob` 查询/取回输出/终止（长测试与构建不阻塞本轮）；HOME/TMPDIR 指向沙箱外**短路径**受管 scratch（macOS 默认 /private/tmp/payaso-shell，Read Only 下仍可写缓存，不污染工作区；短路径保证 tsx 等依赖 TMPDIR 建 Unix socket 的工具可用）；沙箱不可用时拒绝执行（绝不裸跑）

* `updatePlan`：Agent 自述任务清单（全量替换；Harness 持有状态、随 checkpoint 恢复），前端在用户气泡下方实时显示进度

* `loadSkill`：按需加载工作区 skill（`.payaso/skills`、`.claude/skills`、`.pi/skills`）；`calculator` / `getWeather` 为演示工具

* 项目约定：自动加载 `PAYASO.md` / `AGENTS.md` / `CLAUDE.md`（按优先级合并、标注来源、软链去重）

**权限与密钥**

* 三档文件系统权限：`read-only` / `workspace-write`（默认）/ `full-access`，Run 创建时快照、LLM 不可改

* 多 Provider 模型配置：自定义 OpenAI 兼容端点、一键拉取模型目录、默认模型选择；每个 Run 快照绑定 provider/model

* API 密钥仅存 macOS Keychain，SQLite/接口响应/日志中只出现 `hasApiKey` 与掩码；旧明文配置启动时自动迁移

**Host 与 Web UI**

* HTTP API + SSE 实时事件流；SQLite 持久化 sessions / runs / events（`.data/payaso.db`），Host 重启历史不丢

* 工作区：原生文件夹选择、按工作区分组会话、工作区/会话重命名、软删除回收站与恢复

* 深色"文档流"界面：会话列表、流式 Timeline（思考折叠、工具调用极简行、上下文压缩弱提示）、模型/权限选择、设置弹窗

* 中英双语界面：设置 → 通用设置 → 语言可切换（`zh-CN` / `en-US`），文案集中在前端 `web/src/i18n/`
  （约定见 `web/src/i18n/CONVENTIONS.md`）；`tests/frontend-i18n-coverage.test.ts` 是"用户可见位置不得残留中文"的验收闸门

## 快速启动

要求 **Node.js ≥ 22.5**（使用 `node:sqlite`；`nvm use` 可读取仓库 `.nvmrc`）。

```bash
# 1. 安装依赖（根目录 npm install 会自动连带安装 web/ 依赖）
npm install
# 若 postinstall 未生效（如 npm ci --ignore-scripts），手动补装：
# cd web && npm install && cd ..

# 2. 配置模型（二选一）
cp .env.example .env      # 填 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL
                          # 首次启动时 .env 会被一次性导入设置；之后以设置面板为准

# 3. 启动
npm run dev               # 开发模式：Host(4500) + Vite(5173)
npm start                 # 生产模式：构建前端后单端口 4500（UI+API）
npm run cli "帮我计算 15*37"   # 命令行单次任务
```

> 开发模式报 `failed to serve import mermaid ...` 时：`cd web && rm -rf node_modules/.vite` 再重启 `npm run dev`（Vite 依赖预构建缓存过期）。

也可以不写 `.env`，直接在 Web UI 左下角「设置」中添加模型提供方（密钥写入 Keychain）。

## 测试命令

| 命令                               | 内容                                                                     | 依赖            |
| -------------------------------- | ---------------------------------------------------------------------- | ------------- |
| `npm run test:all`               | **82 个确定性套件**（子进程隔离、有界并发，约 17s；失败详情随汇总重打，完整日志落 `.payaso/logs/`）：工具契约、沙箱/权限、持久化、取消、终态原子性、Context Compaction、内核不变量（空回合/参数契约/错误分类/输出预算/shell 执行环境）、P1 能力（grep 正则+ignore/glob/项目指令发现/shell 只读免回放）、P2（原始参数恢复/scratchpad 瘦身/后台长任务）、Host Auth、Keychain 契约等 | 无 LLM         |
| `npx tsc --noEmit`               | TypeScript 类型检查                                                        | 无             |
| `npm run build:web`              | 前端生产构建                                                                 | 无             |
| `npm run test:host`              | Host API 集成测试（真实 HTTP server + 真实 Run）                                 | 需 LLM（`.env`） |
| `npm test`                       | Agent E2E                                                              | 需 LLM（`.env`） |
| `npm run test:stress`            | 压测 26 个场景（长链/大输出/恢复/副作用/沙箱逃逸）                                          | 需 LLM（`.env`） |
| `npx tsx tests/keychain.test.ts` | Keychain 集成（随机账户，测后清理；不可用则 SKIP）                                       | 仅 macOS       |

CI（`.github/workflows/ci.yml`，macOS + Node 22）固定执行 `npm ci` → `npx tsc --noEmit` → `npm run test:all` → `npm run build:web`；`test:host` 在配置了 LLM 密钥（`OPENAI_API_KEY` secret）时自动执行。

## 当前限制

* **无联网工具**：没有 web search / fetch，Agent 无法获取外部信息（`shell` 的网络能力由 `network.mode` 控制，默认 on）

* **shell 沙箱仅 macOS**：`sandbox-exec` 不可用时 shell 工具整体禁用（fail-closed）；其他平台需显式设置 `PAYASO_SHELL_UNSANDBOXED=1` 才放行

* **上下文管理**：超预算先按完整旧轮增量摘要压缩（compaction），单任务长执行有当前轮紧急裁剪兜底

* **纯文本交互**：无文档解析；图片输入需模型声明视觉能力

* **单机单用户**：仅监听 127.0.0.1，无用户鉴权/多租户

* `.env` 为磁盘明文，建议导入设置后删除其中的密钥行
