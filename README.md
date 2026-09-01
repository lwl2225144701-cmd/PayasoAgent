# PayasoAgent

自研的 **LLM 驱动工具调用 Agent 运行时**：`LLM 决策 → 工具执行 → 结果回传` 的 Agent Loop 内核，外加一层 **Host API（HTTP + SSE）** 与一个 **React Web UI**。后端纯 Node 内置能力（`node:http` / `fetch` / `node:sqlite`），无第三方运行时框架；前端为独立 Vite 工程。

* **本地单机**：Host 仅监听 `127.0.0.1:4500`，无多租户、无云端依赖

* **安全优先**：shell 在 macOS seatbelt 沙箱内执行（fail-closed），API 密钥存 macOS Keychain 不落库

* **当前版本：v1.6**

> 完整架构与契约（工具清单、Trace 事件、API、安全边界）以 [docs/architecture-current.md](docs/architecture-current.md) 为唯一权威文档。

## 当前能力

**Agent 运行时**

* Agent Loop：迭代预算、工具重试/失败恢复、防死循环、Checkpoint/Resume（中断后从断点续跑）

* Side-Effect Safety：non-idempotent 操作三态生命周期（executing/succeeded/uncertain），崩溃恢复不重复副作用

* Tool Output Guard：单工具结果 16KB 硬上限，防止大输出撑爆 Context

* True Cancellation：AbortSignal 全链路传播（Host → Agent → LLM 请求 → shell 进程组），`running → stopping → stopped`

* 原子终态落盘：终态状态与终态事件在同一 SQLite 事务提交，崩溃不出现"状态完成但事件丢失"

**工具集（10 个）**

* 文件：`listDir` / `readFile` / `writeFile`（原子写）/ `searchText` / `createDir` / `moveFile` / `deleteFile`

* `shell`：macOS `sandbox-exec` 执行，10s 超时、64KB 输出上限、**网络全隔离**；沙箱不可用时拒绝执行（绝不裸跑）

* Demo：`calculator` / `getWeather`（mock）

**权限与密钥**

* 三档文件系统权限：`read-only` / `workspace-write`（默认）/ `full-access`，Run 创建时快照、LLM 不可改

* 多 Provider 模型配置：自定义 OpenAI 兼容端点、一键拉取模型目录、默认模型选择；每个 Run 快照绑定 provider/model

* API 密钥仅存 macOS Keychain，SQLite/接口响应/日志中只出现 `hasApiKey` 与掩码；旧明文配置启动时自动迁移

**Host 与 Web UI**

* HTTP API + SSE 实时事件流；SQLite 持久化 sessions / runs / events（`.data/payaso.db`），Host 重启历史不丢

* 工作区：原生文件夹选择、按工作区分组会话、工作区/会话重命名、软删除回收站与恢复

* 深色"文档流"界面：会话列表、流式 Timeline（思考折叠、工具调用极简行、上下文压缩弱提示）、模型/权限选择、设置弹窗

## 快速启动

要求 **Node.js ≥ 22.5**（使用 `node:sqlite`；`nvm use` 可读取仓库 `.nvmrc`）。

```bash
# 1. 安装依赖（根目录 + web/）
npm install
cd web && npm install && cd ..

# 2. 配置模型（二选一）
cp .env.example .env      # 填 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL
                          # 首次启动时 .env 会被一次性导入设置；之后以设置面板为准

# 3. 启动
npm run dev               # 开发模式：Host(4500) + Vite(5173)
npm start                 # 生产模式：构建前端后单端口 4500（UI+API）
npm run cli "帮我计算 15*37"   # 命令行单次任务
```

也可以不写 `.env`，直接在 Web UI 左下角「设置」中添加模型提供方（密钥写入 Keychain）。

## 测试命令

| 命令                               | 内容                                                                     | 依赖            |
| -------------------------------- | ---------------------------------------------------------------------- | ------------- |
| `npm run test:all`               | **31 个确定性套件**（子进程隔离，秒级）：工具契约、沙箱/权限、持久化、取消、终态原子性、Context Compaction、Host Auth、Keychain 契约等 | 无 LLM         |
| `npx tsc --noEmit`               | TypeScript 类型检查                                                        | 无             |
| `npm run build:web`              | 前端生产构建                                                                 | 无             |
| `npm run test:host`              | Host API 集成测试（真实 HTTP server + 真实 Run）                                 | 需 LLM（`.env`） |
| `npm test`                       | Agent E2E                                                              | 需 LLM（`.env`） |
| `npm run test:stress`            | 压测 26 个场景（长链/大输出/恢复/副作用/沙箱逃逸）                                          | 需 LLM（`.env`） |
| `npx tsx tests/keychain.test.ts` | Keychain 集成（随机账户，测后清理；不可用则 SKIP）                                       | 仅 macOS       |

CI（`.github/workflows/ci.yml`，macOS + Node 22）固定执行 `npm ci` → `npx tsc --noEmit` → `npm run test:all` → `npm run build:web`；`test:host` 在配置了 LLM 密钥（`OPENAI_API_KEY` secret）时自动执行。

## 当前限制

* **迭代硬上限 10 轮**：复杂长任务可能中途失败（Checkpoint 可 resume，但不延长预算）

* **shell 限制**：10s 超时、64KB 输出、所有权限模式下禁止网络；`sandbox-exec` 仅 macOS 可用（不可用时 shell 工具整体禁用）

* **无联网工具**：没有 web search / fetch，Agent 无法获取外部信息

* **文件操作基础**：`readFile` 整文件读取（≤1MB，无行范围分页）；`writeFile` 整文件覆盖写（无精确字符串替换/diff 编辑）；`searchText` 仅单文件字面量匹配

* **纯文本交互**：无多模态（图片/文档解析）、无文件上传入口

* **上下文管理**：超预算按轮裁剪最早消息，无摘要压缩（compaction）

* **单机单用户**：仅监听 127.0.0.1，无用户鉴权/多租户

* `.env` 为磁盘明文，建议导入设置后删除其中的密钥行
