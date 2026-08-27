# PayasoAgent 当前架构基线（Current Architecture）

> **文档定位**：当前代码状态的唯一权威说明。以工作区代码为准（基线日期 **2026-08-26**），并如实记录已知缺口。
>
> **取代（Superseded）**：
> - `runtime-kernel-freeze.md` —— v1.3.3 Kernel Freeze 基线（已过时，仅存历史）
> - `v1.0-design.md` + `architecture-v1.0.svg` —— v1.0 设计稿（已过时，仅存历史）
> - `.trae/documents/minimal-web-ui_plan.md` —— Web UI 实现方案（已按此落地）
>
> **版本锚点**：`CURRENT_VERSION = v1.5 + Host API + Web UI (web v0.1)`。

---

## 0. 一句话

PayasoAgent 是一个自研的 **LLM 驱动工具调用 Agent 运行时**：`LLM 决策 → 工具执行 → 结果回传` 的循环内核（Runtime Kernel），外加一层 **Host API（HTTP + SSE）** 与一个 **React Web UI**。没有第三方运行时依赖（后端纯 `node:http`/`fetch`），前端独立 Vite 工程。

---

## 1. 演进与 Freeze 的关系

原计划以 `runtime-kernel-freeze.md` 将 `src/runtime/` 冻结在 v1.3.3（只读工具）。实际上代码在 Freeze 声明之后继续演进，**Freeze 声明已被打破**——以下能力在 Freeze 之后落地：

| 版本 | 新增能力 | 位置 |
|---|---|---|
| v1.3.2 | Side-Effect 生命周期（executing/succeeded/uncertain + 持久化） | `runtime/side-effect.ts` |
| v1.3.3 | Tool Output Guard（单结果 16KB） | `runtime/output-guard.ts` |
| v1.4 | Host stop 支持（迭代边界取消检查） | `runtime/agent.ts` |
| v1.5 | **融合身份机制**：`getOperationKey` 可选接收 ToolContext，路径归一化（`canonicalPathKey`） | `tools/*` |
| v1.5+ | 写工具全家桶：`writeFile` / `createDir` / `moveFile` / `deleteFile` / `searchText` / `shell` | `tools/filesystem.ts`、`tools/runtime-tools.ts` |
| v1.5+ | macOS OS Sandbox（`sandbox-exec` policy）执行 shell | `sandbox/macos-sandbox.ts`、`sandbox-policy.ts` |
| Host | HTTP API + SSE + RunManager + 静态文件服务 + 原生工作区选择器 | `host/*` |
| Web | React 18 + Vite 前端（Sidebar / Timeline / RunHeader / InputBar） | `web/` |

**现状结论**：`src/runtime/` 不再是冻结区，而是"**谨慎修改区**"——改动需带回归测试，但不再有"不做 X"的硬边界承诺（除本文件 §10 明示的非目标）。

---

## 2. 架构分层总览

```
┌─────────────────────────────────────────────────────────────┐
│ Web UI (web/, React+Vite, 端口 5173 dev / dist 由 Host 托管) │
└───────────────┬─────────────────────────────────────────────┘
                │ fetch / EventSource(SSE)
┌───────────────▼─────────────────────────────────────────────┐
│ Host (src/host/, node:http, 端口 4500, 仅 127.0.0.1)         │
│  server.ts → routes.ts → RunManager → runAgent(后台)         │
│  persistence/(SQLite) · run-events.ts · workspace.ts         │
└───────────────┬─────────────────────────────────────────────┘
                │ runAgent(task, checkpoint?, opts)
┌───────────────▼─────────────────────────────────────────────┐
│ Runtime Kernel (src/runtime/ + src/llm/ + src/tools/)        │
│  agent.ts: Agent Loop（迭代/重试/恢复/防死循环）              │
│  state.ts · scratchpad.ts · context.ts · trace.ts            │
│  checkpoint.ts · side-effect.ts · output-guard.ts            │
│  llm.ts: OpenAI 兼容 chat/completions(fetch,无 SDK)          │
│  tools/tools.ts: 注册表/执行/Schema/effect 契约              │
│  tools/filesystem.ts + runtime-tools.ts: 10 个工具           │
└───────────────┬─────────────────────────────────────────────┘
                │ ToolContext{ runId, workspaceRoot, onSandboxEvent }
┌───────────────▼─────────────────────────────────────────────┐
│ Sandbox (src/sandbox/)                                       │
│  sandbox-manager.ts: 路径解析/双重校验/工作区生命周期         │
│  macos-sandbox.ts + sandbox-policy.ts: macOS seatbelt 沙箱   │
└─────────────────────────────────────────────────────────────┘
```

依赖方向（无环）：`cli.ts → runtime/agent.ts → {llm, tools, sandbox, runtime/*}`；`host/* → runtime/agent.ts`；工具不反向依赖 runtime。

---

## 3. 模块清单（文档契约锚点）

> 本清单由 `tests/docs-contract.test.ts` 与代码比对锁定：新增/删除工具或 Trace 事件类型必须同步修改本文件。

### 3.1 后端源码

| 文件 | 职责 |
|---|---|
| `src/cli.ts` | CLI 入口：`npm run cli "任务"` / `--resume <runId>` / `--run-id <id>` |
| `src/runtime/agent.ts` | Agent Loop 主循环：迭代预算、重试/恢复、防死循环、Side-Effect 集成、Checkpoint 落盘 |
| `src/runtime/state.ts` | AgentState：status / iteration / currentStep / 工具统计 / pendingAction / lastToolError |
| `src/runtime/scratchpad.ts` | 工作记忆：completedSteps / failedSteps / invalidSteps / nextStep，随 system 注入不被裁剪 |
| `src/runtime/context.ts` | ContextManager：按轮分组裁剪，保留 system + 最后一条 user；Messages + Tool Schema 统一预算 |
| `src/runtime/model-context.ts` | 模型上下文能力配置、环境变量覆盖和保守 token 估算 |
| `src/runtime/trace.ts` | 结构化事件轨迹（15 类事件，见 §3.3） |
| `src/runtime/checkpoint.ts` | 最小 JSON 持久化（`.checkpoints/<runId>.json`） |
| `src/runtime/side-effect.ts` | 副作用三态生命周期 + canonical operation key 去重 |
| `src/runtime/output-guard.ts` | 单工具结果 16KB 硬上限（UTF-8 安全截断） |
| `src/llm/llm.ts` | OpenAI 兼容 `/chat/completions` 封装（fetch，无 SDK；总请求超时默认 240s 可配 `LLM_REQUEST_TIMEOUT_MS`，覆盖响应头+正文；有限重试 + 响应形状校验） |
| `src/tools/tools.ts` | 工具注册表 / 执行 / Schema 导出 / effect 契约 / validateResult / resolveOperationKey |
| `src/tools/filesystem.ts` | listDir / readFile / writeFile（含可写区权限与原子写） |
| `src/tools/runtime-tools.ts` | searchText / createDir / moveFile / deleteFile / shell |
| `src/sandbox/sandbox-manager.ts` | 工作区生命周期、resolveWorkspacePath、assertInsideRoot、cleanupWorkspace |
| `src/sandbox/macos-sandbox.ts` | macOS `sandbox-exec` 启动器（timeout 10s、输出限 64KB）+ **能力探测**（probeSandboxAvailability，fail-closed 门） |
| `src/sandbox/sandbox-policy.ts` | seatbelt 策略生成（default-deny + 白名单） |
| `src/host/server.ts` | node:http 服务器 + 统一错误兜底 |
| `src/host/routes.ts` | 路由分发：/runs API、/workspace、静态文件 + SPA fallback |
| `src/host/run-manager.ts` | 活跃 Run 内存状态 + SQLite 历史/状态/事件 + SSE 广播；启动时 running→interrupted |
| `src/host/run-events.ts` | HostEvent 类型 + SSE 编码 |
| `src/host/workspace.ts` | Host 持有的当前 Workspace（原生 macOS picker，绝不把绝对路径暴露给 LLM） |
| `src/host/persistence/store.ts` | 薄 RunStore 接口（Run CRUD + Event append/list） |
| `src/host/persistence/sqlite-store.ts` | 原生 `node:sqlite` 实现；默认 `~/.payaso/payaso.db` |
| `src/host/index.ts` | Host 启动入口（PORT 可覆盖，默认 4500） |

### 3.2 Web 前端

```
web/src/
├── main.tsx / App.tsx      React 入口 + 三栏布局 + 全局状态
├── api.ts                  fetch 封装 + SSE EventSource
├── hooks/useEventStream.ts SSE 连接/重连/去重
├── types.ts                HostRun / HostEvent / FileEntry
├── format.ts               时间/大小格式化
└── components/             Sidebar / Timeline(思考/工具卡片) / RunHeader
                            / InputBar / ShellBar / SummaryDrawer / FileModal ...
```

### 3.3 文档契约：工具清单与 Trace 事件清单

> 下面的 JSON 块是**机器契约**（`tests/docs-contract.test.ts` 读取比对），手工修改会导致测试失败。

<!-- docs-contract:tools -->
```json
["calculator","getWeather","listDir","readFile","writeFile","searchText","createDir","moveFile","deleteFile","shell"]
```
<!-- /docs-contract:tools -->

<!-- docs-contract:events -->
```json
["llm_call","tool_call","tool_result","tool_result_invalid","final_answer","tool_error","context_trim","context_usage","recovery_decision","side_effect_skip","side_effect_uncertain","tool_output_truncated","shell_sandbox_started","shell_sandbox_denied","scratchpad_update","error"]
```
<!-- /docs-contract:events -->

---

## 4. 核心机制现状

### 4.1 Agent Loop（`agent.ts`）

```
for (i = startIter .. MAX_ITERATIONS=10):
  ├─ 0.    注入 Scratchpad 到 system（messages[0]）
  ├─ 0.5   ContextManager.process() → 按轮裁剪（上限 4000 字符估算）
  ├─ 1.    chat(messages, getSchemas())
  │         └─ 无 tool_calls → stripThink → final_answer → status=completed
  └─ 2.    逐个 tool_call：
        ├─ 2a. non_idempotent → resolveOperation（replay / uncertain / start）
        ├─ 2b. isBlocked 防死循环（同 tool+input 失败超限 / 已 invalid → 禁调）
        ├─ 2c. non_idempotent → begin(opKey) + saveCheckpoint()（persist 失败禁止 execute）
        └─ 2d. 执行：read/idempotent 重试 ≤2；non_idempotent 零重试
              ├─ success → validate(raw) → guard(16KB) → 按 valid/invalid 分支
              └─ throw   → non_idempotent markUncertain / 其余 recordFailure+重试
```

常量：`MAX_ITERATIONS=10`、`MAX_RETRY=2`（总尝试 3）。上下文预算由 `model-context.ts` 按模型能力解析：环境变量优先，其次内置模型表，最后保守 fallback。

### 4.2 三层状态职责

| 模块 | 内容 | 持久化 | LLM 可见 | 裁剪影响 |
|---|---|---|---|---|
| State | runId/status/iteration/统计/lastError | ✔ checkpoint | ✗ | ✗ |
| Scratchpad | completed/failed/invalid/nextStep | ✔ checkpoint | ✔（注入 system） | ✗ |
| Messages | ChatML 历史 | ✔ checkpoint | ✔ | ✔（按轮丢弃） |

### 4.3 关键保证（与测试对应）

- **Tool Output Guard**：`validateResult` 看完整 raw，其后一切（trace/scratchpad/messages/replay）只用 ≤16KB 的 guarded 结果，防止大输出把 Context 撑爆。
- **Side-Effect Safety**：`executing → succeeded | uncertain`；`succeeded` 同 key 回放不重跑；`executing/uncertain` 不再自动执行；execute 前必须先持久化 executing。
- **Operation Identity (v1.5)**：`toolName::canonicalKey`；`canonicalPathKey` 把 `./work/a.txt` 与 `work/a.txt` 归一为同一 key，且不暴露宿主绝对路径。
- **Sandbox 两层校验**：字符串级（禁 `..`/绝对路径/盘符）+ realpath 级（禁 symlink 逃逸、根不是 symlink、悬空链接拒绝）。
- **Checkpoint/Resume**：每步至少保存一次；resume `startIter = iteration-1`，不延长预算；workspace 沿用不清理。

---

## 5. 工具全景（10 个）

| 工具 | effect | operation key | 说明 |
|---|---|---|---|
| `calculator` | idempotent | fallback JSON(args) | 数学表达式（仅数字/运算符白名单，`Function` 求值） |
| `getWeather` | read | fallback JSON(args) | mock 城市天气 |
| `listDir` | read | `path:<canonical>` | 列目录条目，不跟随 symlink |
| `readFile` | read | `path:<canonical>` | UTF-8 ≤1MB，二进制/超大 → invalid |
| `writeFile` | idempotent | `path:<canonical>:contentLen:<n>:sum:<s>` | 原子写（tmp+rename），≤1MB |
| `searchText` | read | `path:<canonical>:pattern:<p>` | 子串查找，回前 20 匹配 |
| `createDir` | idempotent | `path:<canonical>` | 单层创建，父目录需存在 |
| `moveFile` | **non_idempotent** | `src:<canonical>:dst:<canonical>` | 拒绝覆盖已存在目标 |
| `deleteFile` | idempotent | `path:<canonical>` | 文件不存在幂等返回 |
| `shell` | **non_idempotent** | `cmd:<command>` | macOS sandbox-exec 执行，cwd=workspaceRoot，timeout 10s，输出 64KB；**fail-closed**：sandbox-exec 不可用（如 macOS 26）时拒绝执行，绝不跑无沙箱 shell |

**写区权限**：`input/` 只读、仅 `work/` 与 `output/` 可写 —— 仅对 legacy per-run sandbox 生效（见 §8 已知缺口 #2）。

---

## 6. Host API 契约

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/runs` | 创建 Run（`{task}`），立即返回 runId，后台执行 |
| GET | `/runs` | 从 SQLite 列出当前与历史 Run（Host 重启后仍存在） |
| GET | `/runs/:id` | 单个 Run 元数据 |
| POST | `/runs/:id/resume` | 从 checkpoint 恢复 |
| POST | `/runs/:id/stop` | 停止（迭代边界生效；见 §8 已知缺口 #4） |
| GET | `/runs/:id/events` | SQLite 历史事件回放 + 当前活跃 Run 实时 SSE；支持 Last-Event-ID |
| GET | `/runs/:id/files` | 工作区文件树（深度≤6，数量≤500） |
| GET | `/runs/:id/files/*` | 读取工作区内文件（≤1MB） |
| GET | `/workspace` / DELETE `/workspace` / POST `/workspace/open` | 当前 Workspace 查询/清空/原生选择器 |

SSE 事件 = Runtime Trace 16 类（透传）+ Host 生命周期 5 类 `run_started / run_completed / run_failed / run_stopped / run_interrupted`。

---

## 7. 运行方式

```bash
npm install
cp .env.example .env      # OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL
npm run dev               # Host(4500) + Vite(5173)，开发模式
npm start                 # build:web + Host，单端口 4500（UI+API）
npm run cli "帮我计算 15*37"
npm run test:all          # 确定性套件（无 LLM）
npm test                  # Agent E2E（需 LLM）
npm run test:stress       # 压测 23 场景（需 LLM）
npm run test:host         # Host API 集成（需 LLM）
```

---

## 8. 安全边界与已知缺口（如实记录）

> 本节是"家丑清单"：审计/上线前逐条核对。已修复项保留删除线与验证结果，其余条目 = 现状事实 + 建议动作。

| # | 缺口 | 位置 | 影响与建议 |
|---|---|---|---|
| 1 | **shell 沙箱网络放开**：策略含 `(allow network*)`，与注释"Network out of scope"矛盾 | `sandbox/macos-sandbox.ts:114` | shell 可外连/外发数据（仅当沙箱可用时；不可用时 shell 整体禁用，见 #8）。建议网络默认 deny，或至少在 UI/Schema 层明确标注"沙箱不含网络" |
| 2 | **正式 Workspace 整根可写（设计边界，非缺口）**：`assertWritableZone` 仅对 legacy Run Sandbox 保留 `work/`/`output/` 白名单 | `tools/filesystem.ts:181` | 用户显式授权的真实 Workspace 是 Agent 项目根，需支持根目录 `work-test.txt` 与项目源码修改；安全边界是不得越出 Workspace Root |
| 3 | ~~**Checkpoint 写入非原子**~~ **已修复** | `runtime/checkpoint.ts` | 改为同目录唯一 tmp 写入后 `rename` 原子替换；失败时清理 tmp |
| 4 | ~~**`run_stopped` SSE 事件缺失**~~ **已修复** | `host/run-manager.ts` | `stop()` 不再预先改终态，统一由 `finish(run, "stopped")` 设状态并发布事件 |
| 5 | ~~**resume 无"正在运行"守卫**~~ **已修复** | `host/run-manager.ts` | 同一 Host 进程内，已有 running runId 时 `resume()` 直接拒绝，不替换内存记录、不启动第二个 Agent |
| 6 | ~~**`readBody` 无大小限制**~~ **已修复** | `host/routes.ts` | Run JSON 请求体限制 64KB；同时检查 `Content-Length` 和实际流式字节，超限返回 413 |
| 7 | ~~**LLM 层无重试 + 无防御解析**~~ **已修复** | `llm/llm.ts` | 总请求超时默认 240s（`LLM_REQUEST_TIMEOUT_MS` 可配），定时器覆盖"响应头 + 正文读取"，`res.json()` 不再无保护挂死；**总超时不自动重试**（防长生成连续三遍、重复计费）；网络错误/408/429/5xx 最多重试 2 次（支持 `Retry-After`）；4xx 不重试；JSON/choices/message/tool_calls 形状防御校验 |
| 8 | ~~os-sandbox / workspace 两个确定性套件 FAIL~~ **已修复**：`sandbox-exec` 在某些外层受限运行环境中无法应用 profile（`sandbox_apply: Operation not permitted`，exit 71） | `sandbox/macos-sandbox.ts`、`tools/runtime-tools.ts`、`tests/os-sandbox.test.ts`、`tests/workspace.test.ts` | 修复 = 运行时能力探测 `probeSandboxAvailability()` + **fail-closed 门**；不可用则 shell 拒绝执行，可用则跑完整隔离矩阵。该能力取决于实际运行上下文，不应仅按 macOS 版本判断 |
| 9 | **system（含 Scratchpad）的模型视图尚未单独压缩** | `runtime/context.ts`、`runtime/scratchpad.ts` | 已去除固定 4000 字符限制，改为按模型配置输入/输出/安全预算，并以 `context_usage` 观测 Messages/Tool Schema/Scratchpad；若未来实测接近窗口，再增加有界 Scratchpad Model View |
| 10 | **`.env` 存真实 API 密钥**（不入库，但磁盘明文） | 项目根 `.env` | 建议轮换 + 后续引入密钥管理 |
| 11 | ~~**思考标签保留在历史**~~ **已修复** | `runtime/agent.ts` | `reasoning_content` 与 content 内嵌 `<think>` 块都不再写入下一轮 messages/checkpoint；Trace 仍可记录 provider reasoning 供观测 |

---

## 9. 测试矩阵（基线日实测）

| 套件 | 命令 | 状态 |
|---|---|---|
| 确定性 15 套件（增加 persistence：SQLite CRUD、事件顺序/隔离、Host restart、interrupted、Workspace Resume） | `npm run test:all` | **15/15 PASS** |
| Host 集成 | `npm run test:host` | 需 LLM |
| Agent E2E | `npm test` | 需 LLM |
| 压测 | `npm run test:stress` | 23 场景，需 LLM，非确定性 |

---

## 10. 明确非目标（当前不做）

- 多模型/多 Provider 路由、缓存、降级（LLM 层仅实现单 Provider 的有限重试）
- 工具执行超时（除 shell 的 10s）：无 AbortController 包装
- 流式 / 分页 Tool Output；长期 Memory / RAG；跨 run 编排（`MAX_ITERATIONS=10` 仍为硬预算）
- checkpoint 生命周期清理（Trace/Host Event 已由 SQLite 持久化）
- 用户鉴权 / 多租户（runId 单租户；Host 仅监听 127.0.0.1）
- 非 macOS 上的 shell 工具（`sandbox-exec` 仅 darwin）；**macOS 上 sandbox-exec 不可用时 shell 自动禁用**（fail-closed，见 §8 #8）

---

## 11. 文档维护约定（防漂移）

1. **版本锚点**：本文件头部 `CURRENT_VERSION` 与代码中版本注释（`v1.5 融合身份` 等）保持同步；跨版本改动必须同步本文件。
2. **契约测试**：`tests/docs-contract.test.ts` 用 §3.3 的机器可读 JSON 块锁定 **工具清单** 与 **Trace 事件清单**。改代码不改文档 → `npm run test:all` 红。
3. **清单纪律**：§3 模块清单按"新增/删除文件"同步增删；§8 缺口在修复后移入"已修复"并在对应测试标注，防止家丑清单失效。
4. **新增文档**：新文档一律带版本锚点 + Superseded 关系说明，防止出现第四份无主文档。
