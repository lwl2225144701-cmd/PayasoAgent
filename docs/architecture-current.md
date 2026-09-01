# PayasoAgent 当前架构基线（Current Architecture）

> **文档定位**：当前代码状态的唯一权威说明。以工作区代码为准（基线日期 **2026-08-31**，v1.6 Release Closure），并如实记录已知缺口。
>
> **取代（Superseded）**：
>
> * `runtime-kernel-freeze.md` —— v1.3.3 Kernel Freeze 基线（已过时，仅存历史）
>
> * `v1.0-design.md` + `architecture-v1.0.svg` —— v1.0 设计稿（已过时，仅存历史）
>
> * `.trae/documents/minimal-web-ui_plan.md` —— Web UI 实现方案（已按此落地）
>
> **版本锚点**：`CURRENT_VERSION = v1.6 + 多 Provider 模型配置 + Run 模型绑定 Context Budget + True Cancellation + Shell Network Isolation + SecretStore/Keychain`。

***

## 0. 一句话

PayasoAgent 是一个自研的 **LLM 驱动工具调用 Agent 运行时**：`LLM 决策 → 工具执行 → 结果回传` 的循环内核（Runtime Kernel），外加一层 **Host API（HTTP + SSE）** 与一个 **React Web UI**。没有第三方运行时依赖（后端纯 `node:http`/`fetch`），前端独立 Vite 工程。

***

## 1. 演进与 Freeze 的关系

原计划以 `runtime-kernel-freeze.md` 将 `src/runtime/` 冻结在 v1.3.3（只读工具）。实际上代码在 Freeze 声明之后继续演进，**Freeze 声明已被打破**——以下能力在 Freeze 之后落地：

| 版本     | 新增能力                                                                                  | 位置                                             |
| ------ | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| v1.3.2 | Side-Effect 生命周期（executing/succeeded/uncertain + 持久化）                                 | `runtime/side-effect.ts`                       |
| v1.3.3 | Tool Output Guard（单结果 16KB）                                                           | `runtime/output-guard.ts`                      |
| v1.4   | Host stop 支持（迭代边界取消检查）                                                                | `runtime/agent.ts`                             |
| v1.5   | **融合身份机制**：`getOperationKey` 可选接收 ToolContext，路径归一化（`canonicalPathKey`）               | `tools/*`                                      |
| v1.5+  | 写工具全家桶：`writeFile` / `createDir` / `moveFile` / `deleteFile` / `searchText` / `shell` | `tools/filesystem.ts`、`tools/runtime-tools.ts` |
| v1.5+  | macOS OS Sandbox（`sandbox-exec` policy）执行 shell                                       | `sandbox/macos-sandbox.ts`、`sandbox-policy.ts` |
| Host   | HTTP API + SSE + Session/Run 持久化 + 静态文件服务 + 原生工作区选择器                                  | `host/*`                                       |
| Web    | React 18 + Vite 前端（Session Sidebar / 连续 Timeline / 流式答案）                              | `web/`                                         |

**现状结论**：`src/runtime/` 不再是冻结区，而是"**谨慎修改区**"——改动需带回归测试，但不再有"不做 X"的硬边界承诺（除本文件 §10 明示的非目标）。

***

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
│  state.ts · scratchpad.ts · checkpoint-port.ts · observer-port.ts │
│  trace.ts · side-effect.ts · output-guard.ts                  │
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

依赖方向（无环）：`Host/CLI → Bootstrap → Runtime`；Runtime 通过 Harness 生成模型视图、通过 `CheckpointWriter` 提交恢复快照、通过 `RuntimeObserver` 发布诊断观测；默认文件 checkpoint 与 Console Observer 适配器均不被 Runtime 反向依赖。

***

## 3. 模块清单（文档契约锚点）

> 本清单由 `tests/docs-contract.test.ts` 与代码比对锁定：新增/删除工具或 Trace 事件类型必须同步修改本文件。

### 3.1 后端源码

| 文件                                                | 职责                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/cli.ts`                                      | CLI 入口：`npm run cli "任务"` / `--resume <runId>` / `--run-id <id>`                                                                                                               |
| `src/runtime/agent.ts`                            | Agent Loop 主循环：迭代预算、重试/恢复、防死循环、Side-Effect 集成、决定 Checkpoint 提交时机                                                                                                                 |
| `src/runtime/state.ts`                            | AgentState：status / iteration / currentStep / 工具统计 / pendingAction / lastToolError                                                                                             |
| `src/runtime/scratchpad.ts`                       | 工作记忆：completedSteps / failedSteps / invalidSteps / nextStep，随 system 注入不被裁剪                                                                                                    |
| `src/harness/context-harness.ts`                  | Harness 入口：生成当轮临时模型视图，统一指令、历史、Scratchpad 与响应清理                                                                                                                              |
| `src/harness/context-manager.ts`                  | ContextManager：只裁剪当前请求视图，按完整历史 turn 淘汰；保留 system + 当前 user turn；Messages + Tool Schema 统一预算                                                                                       |
| `src/harness/context-state.ts`                    | 可恢复的 Harness 状态：conversation summary 与已摘要前缀计数；随 checkpoint 保存                                                                                                                        |
| `src/harness/conversation-summarizer.ts`          | 增量结构化摘要适配器；只总结即将从模型视图移出的完整旧轮，不删除 canonical transcript                                                                                                                       |
| `src/harness/scratchpad-view.ts`                  | Scratchpad 的有界模型投影：最近步骤、字段截断与硬 token 上限                                                                                                                                          |
| `src/harness/model-context.ts`                    | 模型上下文能力配置：显式 Run 模型优先（source=`run_model`），环境变量仅 CLI/legacy fallback；保守 token 估算                                                                                                |
| `src/bootstrap/runtime-bootstrap.ts`              | 默认本地 Runtime 装配：注册 File/Shell Tool，创建 legacy Run sandbox，canonicalize Host 授权的 Workspace，并注入执行上下文、checkpoint writer 与 Console Observer                                                    |
| `src/runtime/contracts.ts`                        | Runtime 输入契约：Host/bootstrap 注入 `runId + workspaceRoot + permissionMode`，模型不可覆盖                                                                                                                   |
| `src/runtime/trace.ts`                            | 结构化事件轨迹（18 类事件，见 §3.3）                                                                                                                                                         |
| `src/runtime/checkpoint-port.ts`                  | Runtime checkpoint 快照契约与 `CheckpointWriter` 持久化端口，不含文件系统实现                                                                                                                        |
| `src/persistence/file-checkpoint-store.ts`        | 默认本地 JSON checkpoint 适配器：`.checkpoints/<runId>.json` 原子写、读取与路径管理                                                                                                                |
| `src/runtime/observer-port.ts`                    | Runtime 诊断观察端口；接收隔离快照，Observer 修改或抛错均不影响执行语义                                                                                                                                    |
| `src/observability/console-runtime-observer.ts`   | 默认 CLI/本地 stdout 渲染器；Runtime 源码不直接输出控制台                                                                                                                                          |
| `src/runtime/side-effect.ts`                      | 副作用三态生命周期 + canonical operation key 去重                                                                                                                                         |
| `src/runtime/output-guard.ts`                     | 单工具结果 16KB 硬上限（UTF-8 安全截断）                                                                                                                                                     |
| `src/llm/llm.ts`                                  | OpenAI 兼容 `/chat/completions` 封装（默认 SSE 流式、完整 Tool Call 分片组装；可用 `LLM_STREAMING=0` 回退 JSON；总超时、有限重试、响应校验；`max_tokens` 按当前请求模型逐请求解析）                                             |
| `src/tools/tools.ts`                              | 工具注册表 / 执行 / Schema 导出 / effect 契约 / validateResult / resolveOperationKey                                                                                                      |
| `src/tools/filesystem.ts`                         | listDir / readFile / writeFile（含可写区权限与原子写）                                                                                                                                     |
| `src/tools/runtime-tools.ts`                      | searchText / createDir / moveFile / deleteFile / shell                                                                                                                         |
| `src/sandbox/sandbox-manager.ts`                  | 工作区生命周期、resolveWorkspacePath、assertInsideRoot、cleanupWorkspace                                                                                                                 |
| `src/sandbox/macos-sandbox.ts`                    | macOS `sandbox-exec` 启动器（timeout 10s、输出限 64KB）+ **能力探测**（probeSandboxAvailability，fail-closed 门）                                                                               |
| `src/sandbox/sandbox-policy.ts`                   | seatbelt 策略生成（default-deny + 白名单 + `networkAccess` 网络能力开关，默认 false）                                                                                                            |
| `src/host/server.ts`                              | node:http 服务器 + 统一错误兜底                                                                                                                                                         |
| `src/host/routes.ts`                              | 路由分发：/sessions、/runs、/workspace、静态文件 + SPA fallback                                                                                                                            |
| `src/host/run-manager.ts`                         | Session 连续上下文 + 活跃 Run + SQLite 历史/事件 + SSE；启动时 running/stopping→interrupted；创建 Run 时快照 provider/baseUrl/model（原子元组）并绑定模型能力；终态统一走 finalizeRun 原子管线（status+event 同一事务，幂等，失败不广播） |
| `src/host/run-events.ts`                          | HostEvent 类型 + SSE 编码                                                                                                                                                          |
| `src/host/workspace.ts`                           | Host 持有的当前 Workspace（原生 macOS picker，绝不把绝对路径暴露给 LLM）                                                                                                                           |
| `src/host/persistence/store.ts`                   | 薄 RunStore 接口（Session/Run CRUD + Event append/list）                                                                                                                            |
| `src/host/persistence/sqlite-store.ts`            | 原生 `node:sqlite` 实现；默认 `REPO_ROOT/.data/payaso.db`（`PAYASO_DB_PATH` 可覆盖，失败回退 `:memory:`）                                                                                       |
| `src/host/persistence/settings-store.ts`          | Provider metadata（settings 表 key='app' JSON blob，**无 raw apiKey**）+ 默认项 + .env 一次性导入 + legacy 凭证迁移（先写 SecretStore 后剥 SQLite）                                                   |
| `src/host/secrets/secret-store.ts`                | SecretStore 接口 + 稳定 secret key（`model-provider:<id>:api-key`）+ 组合根工厂（macOS=Keychain，其他平台=Unsupported，测试=Memory）                                                                |
| `src/host/secrets/macos-keychain-secret-store.ts` | macOS Keychain：`security` CLI + spawnSync 参数数组（service=PayasoAgent，错误对外脱敏）                                                                                                     |
| `src/host/secrets/memory-secret-store.ts`         | MemorySecretStore（仅测试/注入）与 UnsupportedSecretStore（非 macOS 明确失败，不回退明文）                                                                                                          |
| `src/host/index.ts`                               | Host 启动入口（PORT 可覆盖，默认 4500；组合根：创建 SecretStore 并注入）                                                                                                                             |

### 3.2 Web 前端

```
web/src/
├── main.tsx / App.tsx      React 入口 + 布局 + 全局状态
├── api.ts                  fetch 封装（含 settings/模型配置）+ SSE EventSource
├── hooks/useEventStream.ts SSE 连接/重连/按 seq 去重
├── types.ts                HostSession / HostRun / HostEvent / ModelProviderView / FileEntry
├── format.ts               时间/大小格式化
└── components/             Sidebar / SessionItem / WorkspaceSection / Timeline(思考/工具卡片/压缩提示)
                            / InputBar(ComposerParts, 逐模型下拉) / ShellBar / SettingsModal / FileModal
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
["llm_call","tool_call","tool_call_invalid","tool_result","tool_result_invalid","final_answer","tool_error","context_trim","context_usage","context_compaction","recovery_decision","side_effect_skip","side_effect_uncertain","tool_output_truncated","shell_sandbox_started","shell_sandbox_denied","scratchpad_update","error"]
```

<!-- /docs-contract:events -->

***

## 4. 核心机制现状

### 4.1 Agent Loop（`agent.ts`）

```
for (i = startIter .. MAX_ITERATIONS=10):
  ├─ 0.    注入有界 Scratchpad + 已有 Conversation Summary 到 system
  ├─ 0.5   超过输入预算 80% → 按完整旧轮增量摘要，压至约 65%
  │         canonical transcript 不删除；Harness state 随 checkpoint 恢复
  ├─ 1.    chat(messages, getSchemas(), onStreamDelta, modelConfig?)
  │         ├─ SSE delta → Host 批量持久化 → Web 增量显示
  │         └─ 完整组装 assistant/tool_calls 后才进入 Loop
  │         └─ 无 tool_calls → stripThink → final_answer → status=completed
  └─ 2.    逐个 tool_call（v1.6 Invocation Pipeline：Parse → Validate → Resolve →
        │      Side-effect preparation → Execute；①②③ 失败 = 可恢复 invocation error，
        │      工具不执行、不创建 side-effect，结构化错误回传模型修正，trace 记 tool_call_invalid）：
        ├─ 2a. non_idempotent → resolveOperation（replay / uncertain / start）
        ├─ 2b. isBlocked 防死循环（同 tool+input 失败超限 / 已 invalid → 禁调）
        ├─ 2c. non_idempotent → begin(opKey) + saveCheckpoint()（persist 失败禁止 execute）
        └─ 2d. 执行：read/idempotent 重试 ≤2；non_idempotent 零重试
              ├─ success → validate(raw) → guard(16KB) → 按 valid/invalid 分支
              └─ throw   → non_idempotent markUncertain / 其余 recordFailure+重试
```

常量：`MAX_ITERATIONS=10`、`MAX_RETRY=2`（总尝试 3）。上下文预算由 `model-context.ts` 按**当前 Run 实际选中模型**解析（`resolveModelContextConfig({ model })`，source=`run_model`）：输入参数 > 内置模型表 > 保守 fallback；仅在无显式 modelConfig（CLI/legacy）时走环境变量路径。

### 4.2 三层状态职责

| 模块         | 内容                                  | 持久化          | LLM 可见       | 裁剪影响    |
| ---------- | ----------------------------------- | ------------ | ------------ | ------- |
| State      | runId/status/iteration/统计/lastError | ✔ checkpoint | ✗            | ✗       |
| Scratchpad | completed/failed/invalid/nextStep   | ✔ checkpoint | ✔（有界投影）     | 仅模型视图截断 |
| Harness Summary | 旧完整轮的结构化增量摘要               | ✔ checkpoint | ✔（注入 system） | 增量替换旧前缀 |
| Messages   | 完整 canonical ChatML 历史               | ✔ checkpoint | ✔（最近完整轮）   | 原文不删除   |

### 4.3 关键保证（与测试对应）

* **Tool Output Guard**：`validateResult` 看完整 raw，其后一切（trace/scratchpad/messages/replay）只用 ≤16KB 的 guarded 结果，防止大输出把 Context 撑爆。

* **Side-Effect Safety**：`executing → succeeded | uncertain`；`succeeded` 同 key 回放不重跑；`executing/uncertain` 不再自动执行；execute 前必须先持久化 executing。

* **Operation Identity (v1.5)**：`toolName::canonicalKey`；`canonicalPathKey` 把 `./work/a.txt` 与 `work/a.txt` 归一为同一 key，且不暴露宿主绝对路径。

* **Sandbox 两层校验**：字符串级（禁 `..`/绝对路径/盘符）+ realpath 级（禁 symlink 逃逸、根不是 symlink、悬空链接拒绝）。

* **Checkpoint/Resume**：每步至少保存一次；resume `startIter = iteration-1`，不延长预算；workspace 沿用不清理。

* **Context Compaction V1**：输入估算超过当前 Run 模型预算的 80% 时，Harness 从最旧完整轮开始选取前缀并增量更新结构化 summary，目标回落到约 65%；模型视图使用 `system + bounded scratchpad + summary + recent complete rounds + current turn`。完整 transcript 永不因 compaction 删除，summary 状态随 checkpoint/resume 恢复；`context_compaction` trace 可审计。

* **Run 模型绑定（v1.6）**：每个 Run 的 model snapshot（provider/baseUrl/apiKey/model 原子元组）是 Context Budget、`context_usage` trace 与 LLM `max_tokens` 的唯一模型来源；环境变量仅作为无显式 ModelConfig 时的 fallback。Runtime 拿到 Run 模型后不得再读 `OPENAI_MODEL` 决定能力（`tests/model-binding.test.ts` 锁定该保证，`context_usage.configSource="run_model"` 可审计）。

* **True Cancellation（v1.6）**：AbortSignal 是唯一取消机制，传播链 Host AbortController → runAgent（迭代边界 + tool\_call 间检查）→ chat（HTTP/流式）→ ToolContext.signal → shell 进程组终止（detached spawn + SIGTERM→SIGKILL）。状态机 running→stopping（abort 已发出）→stopped（执行真正退出）；重复 stop 幂等。non\_idempotent 工具被 abort 打断时保持 uncertain 语义（`tests/cancellation.test.ts` 锁定）。

* **Shell Network Isolation（v1.6）**：文件系统能力 ≠ 网络能力。profile 在 deny default 之外按 `SandboxPolicy.networkAccess` 显式 `(deny network*)`/`(allow network*)`；shell 固定 deny（curl/perl 等任意运行时的 socket 连接均被 OS 层拒绝，含 localhost），workspace 内文件操作不受影响（`tests/shell-network.test.ts`）。LLM Tool Schema 不暴露任何网络开关——网络权限只来自 Host/Policy，不由模型参数决定。

* **Provider 凭证隔离（v1.6 SecretStore）**：API Key 唯一存放在 SecretStore（macOS Keychain，service=PayasoAgent，account=`model-provider:<providerId>:api-key`）；SQLite settings blob 只存 metadata（baseUrl/models/hasApiKey）。Settings 读 API（`GET /settings*`）绝不返回 key；Provider 编辑为明确三态（undefined=保持 / 非空=替换 / null=清除）。legacy 明文在启动时自动迁移：**先写 SecretStore 成功后才剥 SQLite**，失败 fail-closed（凭证不丢，Host 明确报错），迁移幂等；删除 Provider 同步 best-effort 清理 Secret。Run 启动时 metadata + SecretStore 合成原子 ModelConfig（`tests/settings.test.ts` Case 1-12 锁定）。

* **Atomic Run Finalization（v1.6）**：terminal Run persistence 是原子的 —— 终态状态与其对应终态事件在同一个 SQLite 事务内提交（`RunStore.finalizeRun`），COMMIT 前崩溃两者都不存在、COMMIT 后崩溃两者都已落库。不变量：`completed ⇔ run_completed`、`failed ⇔ run_failed`、`stopped ⇔ run_stopped`，且每 Run 至多一个终态/终态事件（重复 finish 幂等 no-op）。顺序固定：Runtime 终局 → 原子持久化 → 内存发布 → SSE（durability 优先于 delivery；持久化失败不广播终态、不降级为单独 update/append，Run 保持原非终态）。stopping 为非终态中间态，独立持久化，不与 run\_stopped 混写（`tests/finalize.test.ts` 锁定）。

***

## 5. 工具全景（10 个）

| 工具           | effect              | operation key                             | 说明                                                                                                                                                                       |
| ------------ | ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `calculator` | idempotent          | fallback JSON(args)                       | 数学表达式（仅数字/运算符白名单，`Function` 求值）                                                                                                                                          |
| `getWeather` | read                | fallback JSON(args)                       | mock 城市天气                                                                                                                                                                |
| `listDir`    | read                | `path:<canonical>`                        | 列目录条目，不跟随 symlink                                                                                                                                                        |
| `readFile`   | read                | `path:<canonical>`                        | UTF-8 ≤1MB，二进制/超大 → invalid                                                                                                                                              |
| `writeFile`  | idempotent          | `path:<canonical>:contentLen:<n>:sum:<s>` | 原子写（tmp+rename），≤1MB                                                                                                                                                     |
| `searchText` | read                | `path:<canonical>:pattern:<p>`            | 子串查找，回前 20 匹配                                                                                                                                                            |
| `createDir`  | idempotent          | `path:<canonical>`                        | 单层创建，父目录需存在                                                                                                                                                              |
| `moveFile`   | **non\_idempotent** | `src:<canonical>:dst:<canonical>`         | 拒绝覆盖已存在目标                                                                                                                                                                |
| `deleteFile` | idempotent          | `path:<canonical>`                        | 文件不存在幂等返回                                                                                                                                                                |
| `shell`      | **non\_idempotent** | `cmd:<command>`                           | macOS sandbox-exec 执行，cwd=workspaceRoot，timeout 10s，输出 64KB；**网络默认 deny**（独立 capability，shell 永远显式 false）；**fail-closed**：sandbox-exec 不可用（如 macOS 26）时拒绝执行，绝不跑无沙箱 shell |

**写区权限**：`input/` 只读、仅 `work/` 与 `output/` 可写 —— 仅对 legacy per-run sandbox 生效（见 §8 已知缺口 #2）。

***

## 6. Host API 契约

| 方法       | 路径                                                          | 功能                                                                                  |
| -------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| POST     | `/runs`                                                     | 创建 Run（`{task}`），立即返回 runId，后台执行                                                    |
| GET      | `/runs`                                                     | 从 SQLite 列出当前与历史 Run（Host 重启后仍存在）                                                   |
| GET      | `/sessions`                                                 | 列出持久化 Session（不返回 workspaceRoot）                                                    |
| GET      | `/sessions/:id`                                             | Session 元数据                                                                         |
| GET/POST | `/sessions/:id/runs`                                        | 获取连续对话轮次 / 在 Session 内创建下一轮 Run                                                     |
| GET      | `/runs/:id`                                                 | 单个 Run 元数据                                                                          |
| POST     | `/runs/:id/resume`                                          | 从 checkpoint 恢复                                                                     |
| POST     | `/runs/:id/stop`                                            | True Cancellation：running→stopping（abort signal 全链路传播），执行真正退出后才 stopping→stopped；幂等 |
| GET      | `/runs/:id/events`                                          | SQLite 历史事件回放 + 当前活跃 Run 实时 SSE；支持 Last-Event-ID                                    |
| GET      | `/runs/:id/files`                                           | 工作区文件树（深度≤6，数量≤500）                                                                 |
| GET      | `/runs/:id/files/*`                                         | 读取工作区内文件（≤1MB）                                                                      |
| GET      | `/workspace` / DELETE `/workspace` / POST `/workspace/open` | 当前 Workspace 查询/清空/原生选择器                                                            |
| GET/POST | `/settings/models`，PATCH/DELETE `/settings/models/:id`      | 模型提供方 CRUD；**读 API 只回 hasApiKey/mask，key 绝不出 Host**（写入路径：key → SecretStore）         |
| GET/POST | `/settings`，`/settings/default`                             | 默认模型查询 / 设置（providerId + modelId 成对校验）                                              |
| POST     | `/settings/available-models`                                | 拉取 OpenAI 兼容端点 `/models` 目录（可用存储密钥代拉，明文不出服务端）                                       |

SSE 事件 = Runtime Trace 18 类 + Host 生命周期 6 类（含 v1.6 `run_stopping`）+ `assistant_delta / reasoning_delta`。delta 在 Host 约 16ms 合并后持久化；前端使用 SQLite `seq`/SSE id 去重。

***

## 7. 运行方式

```bash
# 要求 Node.js >= 22.5（node:sqlite；.nvmrc 固定 22，CI 同为 Node 22 / macOS）
npm install
(cd web && npm install)   # 前端独立 Vite 工程，依赖单独安装
cp .env.example .env      # OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL（也可在 Web 设置面板配置）
npm run dev               # Host(4500) + Vite(5173)，开发模式
npm start                 # build:web + Host，单端口 4500（UI+API）
npm run cli "帮我计算 15*37"
npm run test:all          # 31 个确定性套件（无 LLM）
npm run test:host         # Host API 集成（需 LLM）
npm test                  # Agent E2E（需 LLM）
npm run test:stress       # 压测 26 场景（需 LLM）
```

***

## 8. 安全边界与已知缺口（如实记录）

> 本节是"家丑清单"：审计/上线前逐条核对。已修复项保留删除线与验证结果，其余条目 = 现状事实 + 建议动作。

| #     | 缺口                                                                                                                                        | 位置                                                                                                       | 影响与建议                                                                                                                                                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| \~\~1 | **shell 沙箱网络放开**：策略含 `(allow network*)`，与注释"Network out of scope"矛盾\~\~ **已修复（v1.6 Shell Network Isolation）**                             | `sandbox/macos-sandbox.ts`                                                                               | profile 按 `SandboxPolicy.networkAccess` 显式 `(deny network*)`/`(allow network*)`，shell 固定 deny（`forWorkspace` 显式传入 false）；`tests/shell-network.test.ts` 用 localhost TCP server 证明 curl/perl 连接均被 OS 层拒绝，且 allow 模式对照组成功。网络是独立 capability，未来由 Browser/Network provider 提供，不隐式授予 shell |
| 2     | **正式 Workspace 整根可写（设计边界，非缺口）**：`assertWritableZone` 仅对 legacy Run Sandbox 保留 `work/`/`output/` 白名单                                       | `tools/filesystem.ts:181`                                                                                | 用户显式授权的真实 Workspace 是 Agent 项目根，需支持根目录 `work-test.txt` 与项目源码修改；安全边界是不得越出 Workspace Root                                                                                                                                                                                             |
| 3     | **~~Checkpoint 写入非原子~~** **已修复**                                                                                                          | `persistence/file-checkpoint-store.ts`                                                                   | 默认适配器以同目录唯一 tmp 写入后 `rename` 原子替换；失败时清理 tmp。Runtime 只依赖 `CheckpointWriter` 端口                                                                                                                                                                                                                  |
| 4     | **~~`run_stopped`~~~~SSE 事件缺失~~**  **已修复**                                                                                                | `host/run-manager.ts`                                                                                    | `stop()` 不再预先改终态，统一由 `finish(run, "stopped")` 设状态并发布事件                                                                                                                                                                                                                              |
| 5     | **~~resume 无"正在运行"守卫~~** **已修复**                                                                                                          | `host/run-manager.ts`                                                                                    | 同一 Host 进程内，已有 running runId 时 `resume()` 直接拒绝，不替换内存记录、不启动第二个 Agent                                                                                                                                                                                                                 |
| 6     | **~~`readBody`~~~~无大小限制~~**  **已修复**                                                                                                      | `host/routes.ts`                                                                                         | Run JSON 请求体限制 64KB；同时检查 `Content-Length` 和实际流式字节，超限返回 413                                                                                                                                                                                                                          |
| 7     | **~~LLM 层无重试、无防御解析、无流式输出~~** **已修复**                                                                                                      | `llm/llm.ts`                                                                                             | 默认解析 OpenAI-compatible SSE，正文/推理增量输出，Tool Call 参数完整组装并校验后才执行；保留 240s 总超时、有限重试、JSON fallback 与响应形状校验                                                                                                                                                                                 |
| 8     | ~~os-sandbox / workspace 两个确定性套件 FAIL~~ **已修复**：`sandbox-exec` 在某些外层受限运行环境中无法应用 profile（`sandbox_apply: Operation not permitted`，exit 71） | `sandbox/macos-sandbox.ts`、`tools/runtime-tools.ts`、`tests/os-sandbox.test.ts`、`tests/workspace.test.ts` | 修复 = 运行时能力探测 `probeSandboxAvailability()` + **fail-closed 门**；不可用则 shell 拒绝执行，可用则跑完整隔离矩阵。该能力取决于实际运行上下文，不应仅按 macOS 版本判断                                                                                                                                                              |
| 9     | **~~system（含 Scratchpad）的模型视图尚未单独压缩~~** **已修复（Context Compaction V1）**                                                                    | `harness/context-harness.ts`、`harness/scratchpad-view.ts`                                                | Scratchpad 有界投影；旧完整轮增量 summary；canonical transcript 不删除；summary 随 checkpoint 恢复，并以 `context_compaction` / `context_usage` 观测                                                                                                                                            |
| 10    | **~~`.env`~~~~存真实 API 密钥~~** ~~（不入库，但磁盘明文）~~ **部分修复（v1.6 SecretStore）**：SQLite 明文已迁移至 Keychain，`.env` 本身仍为磁盘明文                            | 项目根 `.env`                                                                                               | 导入完成后建议从 `.env` 移除 `OPENAI_API_KEY` 行；后续可加"导入后清理"提示                                                                                                                                                                                                                                 |
| 11    | **~~思考标签保留在历史~~** **已修复**                                                                                                                 | `runtime/agent.ts`                                                                                       | `reasoning_content` 与 content 内嵌 `<think>` 块都不再写入下一轮 messages/checkpoint；Trace 仍可记录 provider reasoning 供观测                                                                                                                                                                          |

***

## 9. 测试矩阵（基线日实测）

| 套件                                                                                                                                                                                                                                                                                                                | 命令                               | 状态                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| 确定性 31 套件（无真实 LLM；含 Context Compaction、三档文件系统权限、macOS seatbelt 沙箱、Workspace 生命周期与软删除回收站、Host 启停/路由、SQLite 持久化、LLM transport mock、Run 模型绑定、Cancellation、Shell 网络隔离、Side-Effect、Provider/SecretStore、docs contract） | `npm run test:all`               | 31 套件全绿为合并门槛；workspace shell 用例依赖本机 sandbox-exec 可用性（受限环境按 fail-closed DENIED，见 §8 #8） |
| Keychain 集成（独立运行，不进 run-all）                                                                                                                                                                                                                                                                                      | `npx tsx tests/keychain.test.ts` | 需 macOS + `security` CLI；随机测试账户，测后清理；不可用则如实 SKIP                                                |
| Host 集成                                                                                                                                                                                                                                                                                                           | `npm run test:host`              | 需 LLM（`tsx --env-file=.env`）；CI 在配置 `OPENAI_API_KEY` secret 时自动执行，否则跳过                          |
| Agent E2E                                                                                                                                                                                                                                                                                                         | `npm test`                       | 需 LLM                                                                                           |
| 压测                                                                                                                                                                                                                                                                                                                | `npm run test:stress`            | 26 场景，需 LLM，非确定性                                                                                |

***

## 10. 明确非目标（当前不做）

* 模型能力缓存、跨 Provider 自动降级/故障转移（多 Provider 手动选择与 Run 级模型绑定已支持，见 §4.3；LLM 层仍仅做单请求有限重试）

* 网络能力粒度控制（域名白名单、代理、流量审计）：shell 只保留 `networkAccess` deny/allow 二态开关；Browser/Network capability 属后续阶段，不通过 shell 实现

* 工具执行超时（除 shell 的 10s 上限）；LLM 请求已有总超时 + AbortSignal 取消，shell 已支持进程组级取消（v1.6），其余工具取消语义取决于工具自身

* 流式/分页 Tool Output；长期 Memory / RAG；跨 Session 编排（单个 Run 的 `MAX_ITERATIONS=10` 仍为硬预算）

* checkpoint 生命周期清理（Trace/Host Event 已由 SQLite 持久化）

* 用户鉴权 / 多租户（runId 单租户；Host 仅监听 127.0.0.1）

* 非 macOS 上的 shell 工具（`sandbox-exec` 仅 darwin）；**macOS 上 sandbox-exec 不可用时 shell 自动禁用**（fail-closed，见 §8 #8）

***

## 11. 文档维护约定（防漂移）

1. **版本锚点**：本文件头部 `CURRENT_VERSION` 与代码中版本注释（`v1.5 融合身份` 等）保持同步；跨版本改动必须同步本文件。
2. **契约测试**：`tests/docs-contract.test.ts` 用 §3.3 的机器可读 JSON 块锁定 **工具清单** 与 **Trace 事件清单**。改代码不改文档 → `npm run test:all` 红。
3. **清单纪律**：§3 模块清单按"新增/删除文件"同步增删；§8 缺口在修复后移入"已修复"并在对应测试标注，防止家丑清单失效。
4. **新增文档**：新文档一律带版本锚点 + Superseded 关系说明，防止出现第四份无主文档。
