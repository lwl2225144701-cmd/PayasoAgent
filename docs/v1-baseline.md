# PayasoAgent v1 — Local Agent Runtime MVP Baseline

> **版本锚点**：v1.0.0-local-mvp 候选基线
>
> **基线日期**：2026-08-26
>
> **后续状态**：本文是 Phase 2 之前的历史冻结坐标；当前实现状态以 `architecture-current.md` 与 `phase2-session-persistence.md` 为准。
>
> **文档定位**：以当前工作区实际源码为准，记录 v1 已完成的能力、已验证的边界、以及明确不属于 v1 的范围。作为下一阶段 **SQLite / Session Persistence** 开始前的冻结坐标。
>
> **历史文档状态**：
> - [`runtime-kernel-freeze.md`](./runtime-kernel-freeze.md) 已显式标记为 Superseded，仅作历史参考。
> - [`v1.0-design.md`](./v1.0-design.md) 已显式标记为 Superseded，仅作历史参考。
> - [`architecture-current.md`](./architecture-current.md) 是当前架构权威说明；本文档在其基础上为 v1 设立正式基线。

---

## A. v1 定位

PayasoAgent v1 是一个**安全优先、Local-first、可以打开真实 Workspace 并在其中执行 Agent 任务的本地 Agent MVP**。

它不是一个生产级 SaaS，也不是一个完整 Agent Framework。v1 的核心目标是：

- 在本地机器上安全地运行 LLM 驱动的工具调用 Agent；
- 让浏览器通过 Host API 启动、观察、管理 Agent Run；
- 保证副作用操作（文件写入、移动、shell 等）的可恢复性与可重复执行边界；
- 为下一阶段持久化（SQLite / Session Persistence）提供一个稳定、可对照的代码坐标。

---

## B. 当前完整架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Web UI (web/, React + Vite)                                 │
│  - 浏览器：任务输入 / Run 历史 / Timeline / 文件预览          │
└───────────────────────┬─────────────────────────────────────┘
                        │ fetch / EventSource(SSE)
┌───────────────────────▼─────────────────────────────────────┐
│ Host API (src/host/, node:http, 127.0.0.1:4500)             │
│  - server.ts / routes.ts / run-manager.ts                   │
│  - run-events.ts(SSE) / workspace.ts(本地目录选择器)         │
└───────────────────────┬─────────────────────────────────────┘
                        │ runAgent(task, checkpoint?, opts)
┌───────────────────────▼─────────────────────────────────────┐
│ Runtime Kernel (src/runtime/ + src/llm/ + src/tools/)        │
│  - agent.ts: Agent Loop（迭代/重试/恢复/防死循环）            │
│  - state.ts · scratchpad.ts · context.ts · trace.ts          │
│  - checkpoint.ts · side-effect.ts · output-guard.ts          │
│  - llm.ts: OpenAI 兼容 chat/completions                      │
│  - tools/tools.ts: 注册表/执行/Schema/effect 契约            │
└───────────────────────┬─────────────────────────────────────┘
                        │ ToolContext{ runId, workspaceRoot, onSandboxEvent }
┌───────────────────────▼─────────────────────────────────────┐
│ Sandbox (src/sandbox/)                                       │
│  - sandbox-manager.ts: 工作区生命周期 + 路径双重校验         │
│  - macos-sandbox.ts + sandbox-policy.ts: macOS seatbelt 沙箱 │
└─────────────────────────────────────────────────────────────┘
                        │
                Local Machine (真实 Workspace)
```

### 各层职责边界

| 层级 | 职责 | 明确不做的事 |
|---|---|---|
| **Web** | 用户界面、SSE 消费、Run 历史展示 | 不直接调用 Runtime / Tool / 文件系统 |
| **Host API** | HTTP 路由、Run 生命周期管理、Workspace 选择、静态文件服务 | 不执行 Tool.execute；不把真实绝对路径暴露给 LLM |
| **RunManager** | 内存 Run 状态机、SSE 广播、resume/stop 守卫 | 不替代 Runtime 做迭代控制 |
| **Runtime Kernel** | Agent Loop、状态、上下文、Checkpoint、Side-Effect Safety | 不处理用户鉴权 / 多租户 / Web 路由 |
| **Tools** | 在 ToolContext 限定的 workspaceRoot 内执行具体操作 | 不自行解析/穿越 workspaceRoot |
| **Sandbox** | 路径解析、Containment、macOS OS Sandbox 启动 | 不提供网络隔离（当前策略仍允许网络） |

---

## C. Runtime Kernel 已冻结能力

`src/runtime/` 进入**谨慎修改区**：除真实 Bug / 安全问题外，不再继续堆复杂机制。

| 能力 | 文件 | 状态 |
|---|---|---|
| **Agent Loop** | [`src/runtime/agent.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/runtime/agent.ts) | 完成：LLM 决策 → 工具执行 → 结果回传，含 `MAX_ITERATIONS=10` 硬预算 |
| **State** | [`src/runtime/state.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/runtime/state.ts) | 完成：status / iteration / step / 工具统计 / lastError |
| **Scratchpad** | [`src/runtime/scratchpad.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/runtime/scratchpad.ts) | 完成：completed / failed / invalid / nextStep，随 system 注入，不参与裁剪 |
| **Context** | [`src/runtime/context.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/runtime/context.ts) | 完成：按模型配置的 token 预算裁剪；保留 system + 最后 user |
| **Checkpoint / Resume** | [`src/runtime/checkpoint.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/runtime/checkpoint.ts) | 完成：JSON 原子落盘；resume 从 `iteration-1` 开始，不延长预算 |
| **Trace** | [`src/runtime/trace.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/runtime/trace.ts) | 完成：16 类结构化事件 |
| **Retry / Recovery** | [`src/runtime/agent.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/runtime/agent.ts) | 完成：read/idempotent 重试 2 次；non_idempotent 零重试；死循环防护 |
| **Result Validation** | [`src/runtime/agent.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/runtime/agent.ts) + [`src/tools/tools.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/tools/tools.ts) | 完成：execute 成功 vs 结果有效正交处理 |
| **Side-Effect Safety** | [`src/runtime/side-effect.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/runtime/side-effect.ts) | 完成：executing / succeeded / uncertain 三态生命周期 |
| **Operation Identity** | [`src/tools/tools.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/tools/tools.ts) | 完成：`toolName::canonicalKey`；路径类工具 canonicalization |
| **Tool Output Guard** | [`src/runtime/output-guard.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/runtime/output-guard.ts) | 完成：单结果 16KB UTF-8 安全截断 |
| **Model Context** | [`src/runtime/model-context.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/runtime/model-context.ts) | 完成：模型能力配置 + 保守 token 估算 |

---

## D. 当前 Tool 清单

**实际注册工具数量：10 个**（由 [`tests/docs-contract.test.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/tests/docs-contract.test.ts) 与代码注册表自动比对锁定）。

| # | name | effect | 主要用途 | 关键安全约束 |
|---|---|---|---|---|
| 1 | `calculator` | idempotent | 数学表达式计算 | 仅允许数字与运算符；`NaN/Infinity` 视为 invalid |
| 2 | `getWeather` | read | 查询已收录城市的 mock 天气 | 未收录城市抛异常；温度缺失/非数字视为 invalid |
| 3 | `listDir` | read | 列出 Workspace 内目录条目 | 不跟随 symlink；只接受相对路径 |
| 4 | `readFile` | read | 读取 Workspace 内 UTF-8 文本文件 | ≤1MB；二进制/超大返回 invalid；拒绝路径穿越 |
| 5 | `writeFile` | idempotent | 原子写入 Workspace 内文本文件 | ≤1MB；仅对 legacy per-run sandbox 限制 `work/`/`output/`；真实 Workspace 根目录可写 |
| 6 | `searchText` | read | 在 Workspace 文本文件中查找子串 | 单文件 ≤1MB；二进制返回 invalid；最多回传 20 个匹配 |
| 7 | `createDir` | idempotent | 创建 Workspace 内单个目录 | 父目录需已存在；已存在目录幂等 |
| 8 | `moveFile` | non_idempotent | 移动 Workspace 内文件 | 拒绝覆盖目标；路径归一化后同一 identity 只执行一次 |
| 9 | `deleteFile` | idempotent | 删除 Workspace 内文件 | 不存在的文件幂等返回；拒绝目录删除 |
| 10 | `shell` | non_idempotent | 在 Workspace 根目录执行 shell 命令 | **仅 macOS**；`sandbox-exec` 不可用时 fail-closed 拒绝执行；timeout 10s；输出限 64KB |

所有文件工具的 `workspaceRoot` 和 `runId` 均由 Runtime 注入，**不出现在 Tool Schema 中，LLM 不可见、不可覆盖**。

---

## E. Workspace v1

当前 Workspace 行为流程：

```text
用户在 Web 点击"打开 Workspace"
    ↓
Host 调用 macOS 原生目录选择器（仅本地开发/测试环境可用）
    ↓
Host 对所选目录做 realpath / 校验，记录 workspaceRoot
    ↓
Run 创建时快照绑定当前 workspaceRoot
    ↓
Runtime 将 workspaceRoot 注入 ToolContext
    ↓
File Tools + Shell 使用同一个 workspaceRoot
```

### 明确保证

- **LLM 不知道宿主真实绝对路径**：Schema 与响应中只出现相对路径。
- **LLM 无法传入或覆盖 `workspaceRoot`**：该字段由 Runtime/Host 注入，不在任何 Tool Schema 中。
- **更换 Workspace 不影响已创建 Run**：Run 创建时已经快照绑定 workspaceRoot。
- **Resume 使用原 Workspace**：恢复时沿用 checkpoint 中的 workspaceRoot，不随当前 Host Workspace 改变。
- **无 Workspace 时兼容旧 run sandbox**：退回到 `<projectRoot>/sandbox/workspaces/<runId>` 模式，保留 `input/` 只读、`work/`/`output/` 可写的 legacy 语义。

---

## F. Sandbox / 安全保证

| 安全能力 | 状态 | 说明 |
|---|---|---|
| **路径 traversal 防护** | ✅ | `../` 被字符串级拒绝 |
| **绝对路径拒绝** | ✅ | Unix 绝对路径与 Windows 盘符均拒绝 |
| **realpath containment** | ✅ | `assertInsideRoot` 要求真实解析后的路径必须位于 workspaceRoot 下 |
| **symlink 防逃逸** | ✅ | workspace 根不能是 symlink；目标/最近存在祖先的 realpath 必须仍在根下；悬空 symlink 拒绝 |
| **Run 隔离** | ✅ | 不同 runId 的工作区目录独立 |
| **Workspace A/B 隔离** | ✅ | 不同真实 Workspace 之间无法通过相对路径穿越访问 |
| **macOS OS Sandbox** | ✅（可用时） | `sandbox-exec` seatbelt 策略：default-deny + workspace 白名单 |
| **shell fail-closed** | ✅ | `sandbox-exec` 不可用时拒绝执行，不降级为无沙箱 shell |
| **Side-Effect Safety** | ✅ | non_idempotent 同 key 只执行一次；uncertain 不自动重跑 |
| **Output Guard** | ✅ | 单工具结果 ≤16KB，防止 Context 被撑爆 |
| **Checkpoint Recovery** | ✅ | execute 前持久化 executing 态；crash 后 resume 可识别 uncertain |

### 明确不保证

- **shell 网络隔离**：当前 macOS sandbox policy 仍允许 `(allow network*)`，因此 shell 命令可以访问网络。
- **shell 跨平台**：当前仅 macOS 支持；非 macOS 上 shell 工具不可用。
- **完整系统隔离**：Sandbox 目标是文件系统 containment，不是 VM/容器级隔离。

---

## G. Host API

实际路由以 [`src/host/routes.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/host/routes.ts) 源码为准：

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/runs` | 创建 Run（请求体 `{ task: string }`），立即返回 `{ runId }` |
| GET | `/runs` | 列出当前 Host 进程内存中的所有 Run（重启丢失） |
| GET | `/runs/:id` | 查询单个 Run 元数据 |
| POST | `/runs/:id/resume` | 从 checkpoint 恢复 Run；同一 running runId 拒绝重复启动 |
| POST | `/runs/:id/stop` | 请求停止 Run（在迭代边界生效） |
| GET | `/runs/:id/events` | SSE 事件流：先回放历史事件，再实时推送 |
| GET | `/runs/:id/files` | 列出该 Run 的 Workspace 文件树（深度 ≤6，数量 ≤500） |
| GET | `/runs/:id/files/*` | 读取 Workspace 内指定文件（≤1MB） |
| GET | `/workspace` | 查询当前 Host Workspace（仅返回 name，不返回绝对路径） |
| POST | `/workspace/open` | 调用 macOS 原生目录选择器打开 Workspace |
| DELETE | `/workspace` | 清空 Host 当前 Workspace |

附加：Host 还提供静态文件托管（`web/dist`）和 SPA fallback，支持 `npm start` 单端口运行。

---

## H. Web v1

前端基于 **React 18 + Vite**，源码位于 [`web/src/`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/web/src)：

| 功能 | 状态 |
|---|---|
| Run 历史列表 | ✅ 按天分组的 Sidebar |
| 任务输入 | ✅ Hero / Compact 双形态 InputBar |
| Timeline | ✅ 用户消息、LLM 思考、工具执行、最终结果 |
| Tool 执行展示 | ✅ ToolActionRow 聚合 tool_call / tool_result / tool_error |
| Think 折叠 | ✅ ThinkBlock 可折叠思考块 |
| 文件预览 | ✅ FileModal 调 `/runs/:id/files/*` |
| Workspace 打开/更换 | ✅ Sidebar 入口调用 `/workspace/open` |
| SSE 实时更新 | ✅ `useEventStream` 订阅 `/runs/:id/events` |
| 响应式布局 | ✅ 窄屏自动折叠 Sidebar |

---

## I. CLI

当前 CLI 入口 [`src/cli.ts`](file:///Users/luweiliang/Downloads/myProject/payaso_agent/src/cli.ts) 支持：

```bash
# 直接运行 Agent（任务作为位置参数传入）
npm run cli -- "帮我计算 15*37"

# 从 checkpoint 恢复指定 runId
npm run cli -- --resume <runId>

# 指定 runId（可选）
npm run cli -- --run-id <id> "任务"
```

---

## J. 测试基线

| 测试项 | 命令 | 当前结果 |
|---|---|---|
| TypeScript 类型检查 | `npx tsc --noEmit` | ✅ PASS |
| Web 构建 | `npm run build:web` | ✅ PASS |
| 确定性测试套件（无 LLM，14 套） | `npm run test:all` | ✅ 14/14 PASS |
| Host API 集成测试 | `npm run test:host` | 需 LLM，未在本次基线运行 |
| Agent E2E | `npm test` | 需 LLM，未在本次基线运行 |
| 压测 | `npm run test:stress` | 需 LLM，未在本次基线运行 |

本次已执行结果：

```text
套件: 14 | PASS: 14 | FAIL: 0
  PASS  tool-contract
  PASS  filesystem-tools
  PASS  sandbox-manager
  PASS  operation-identity
  PASS  operation-replay
  PASS  output-guard
  PASS  runtime-tools
  PASS  os-sandbox          (sandbox-exec 不可用，仅验证 fail-closed 拒绝路径)
  PASS  workspace
  PASS  context
  PASS  context-budget
  PASS  llm
  PASS  docs-contract
  PASS  side-effect
```

> 注：`os-sandbox` 在当前环境因 `sandbox-exec` 无法应用而跳过完整隔离矩阵，但 fail-closed 拒绝路径通过。

---

## K. Known Limitations

以下限制为当前代码实际存在的状态，**不作为 v1 缺陷**：

| # | 限制 | 说明 |
|---|---|---|
| 1 | **Host Run / Event 主要为内存态** | Host 重启后 Run 列表与事件历史丢失 |
| 2 | **Session Persistence / SQLite 尚未实现** | 下一阶段核心目标 |
| 3 | **`MAX_ITERATIONS = 10`** | 单次 Run 硬预算；resume 不重置完整预算 |
| 4 | **Resume 不延长迭代预算** | 长链任务需要 Harness 级多次 resume 编排 |
| 5 | **LLM Provider 层较薄** | 单 Provider、单组环境变量；无路由/缓存/降级 |
| 6 | **无长期 Memory / RAG** | Scratchpad 仅单 Run 短期记忆 |
| 7 | **无 Planner / Multi-Agent** | 当前为单 Agent Loop |
| 8 | **Shell 当前仅 macOS** | 非 macOS 不可用 |
| 9 | **Shell 网络权限尚未限制** | `sandbox-exec` policy 仍允许网络 |
| 10 | **Trace 不持久化** | Trace 事件仅内存 + stdout；checkpoint 不保存 Trace |
| 11 | **Web 部分信息仍是占位** | 例如某些空态/提示文案可能未完全产品化 |

---

## L. Out of Scope for v1

以下能力**明确不属于 v1**，避免以后把"没做"误认为 v1 缺陷：

- SQLite Session Persistence
- Model Adapter / Multi-Provider 路由
- Diff / Change Tracking
- Git 集成
- MCP 协议桥接
- Skills 框架
- 长期 Memory
- RAG
- Planner / Task Decomposition
- Multi-Agent Orchestration
- Cloud / 多租户 / 用户鉴权
- 流式 / 分页 Tool Output 协议
- 工具执行通用 AbortController / 超时包装（shell 已有 10s 自身 timeout）

---

## M. Runtime / Product v1 Freeze Checklist

### Frozen（v1 已冻结，谨慎修改）

- [x] Agent Loop 与迭代预算语义（`MAX_ITERATIONS=10`）
- [x] Tool Effect Contract（read / idempotent / non_idempotent）
- [x] Operation Identity 与 canonical key 机制
- [x] Side-Effect Safety 三态生命周期
- [x] Checkpoint / Resume 语义
- [x] Tool Output Guard 16KB 边界
- [x] Workspace Root 注入语义（LLM 不可见、不可覆盖）
- [x] Sandbox 两层路径校验与 containment
- [x] Host API 路由契约（`/runs`, `/runs/:id/events`, `/workspace`, `/runs/:id/files`）
- [x] Web 与 Host 的架构边界（浏览器不直接访问 Runtime）

### Known Boundary（已知边界，不是 Bug）

- `MAX_ITERATIONS=10` 硬预算
- Host Run/Event 为内存态，重启丢失
- macOS-only shell sandbox
- shell 网络权限未限制
- 单 Provider / 单组环境变量
- Trace 不持久化

### Next Phase（下一阶段）

- [ ] Session / Run Persistence（SQLite）
- [ ] Host 重启后恢复 Run 历史与事件
- [ ] checkpoint 生命周期管理（清理 / 配额）
- [ ] 可选：Model Adapter / 多 Provider
- [ ] 可选：Web 信息/空态产品化打磨
- [ ] 可选：shell 网络隔离策略收紧

---

## N. Git 基线准备

### 当前状态

- **Branch**：`main`
- **当前 commit**：`1a3bfc4 refactor(web): unify semantic theme colors`
- **工作区**：**不干净**，存在未提交的 Web 组件重构改动

### 未提交改动清单

```text
已修改：
  web/src/App.tsx
  web/src/components/FileModal/FileModal.module.css
  web/src/components/FileModal/index.tsx
  web/src/components/InputBar/InputBar.module.css
  web/src/components/InputBar/index.tsx
  web/src/components/ShellBar/ShellBar.module.css
  web/src/components/ShellBar/index.tsx
  web/src/components/Sidebar/Sidebar.module.css
  web/src/components/Sidebar/index.tsx
  web/src/components/Timeline/index.tsx
  web/src/format.ts

已删除：
  web/src/components/RunHeader/*
  web/src/components/StatusDot.*
  web/src/components/SummaryDrawer/*
  web/src/components/Timeline/Section.tsx
  web/src/components/Timeline/StatusFooter.tsx
  web/src/components/Timeline/ToolCard.tsx
  web/src/components/TopBar/*

未跟踪：
  "ChatGPT Image 2026年8月25日 20_50_04.png"
  web/src/components/CopyButton/
  web/src/components/IconButton/
  web/src/components/Modal/
  web/src/hooks/useClickOutside.ts
  web/src/hooks/useEscapeKey.ts
```

### 建议

建议 tag 名：`v1.0.0-local-mvp`

**在未获得用户明确授权前，不自动创建 tag / 不自动 commit / 不自动丢弃改动。**

如果决定基线化，建议流程：

1. 用户确认上述 Web 改动是否纳入 v1；
2. 用户授权后 commit（或单独 commit docs/v1-baseline.md）；
3. 用户授权后创建 tag：

```bash
git tag -a v1.0.0-local-mvp -m "PayasoAgent v1 local MVP baseline"
git push origin v1.0.0-local-mvp
```

---

## O. 文档同步说明

本次新增本文档 [`docs/v1-baseline.md`](./v1-baseline.md) 作为 v1 正式基线，未大规模重写历史文档。

已确认历史文档状态：

- [`runtime-kernel-freeze.md`](./runtime-kernel-freeze.md)：已在头部明确声明 Superseded，无需额外修改。
- [`v1.0-design.md`](./v1.0-design.md)：已在头部明确声明 Superseded，无需额外修改。
- [`architecture-current.md`](./architecture-current.md)：当前架构权威说明，其工具清单（10 个）与 Trace 事件清单（16 类）已通过 `docs-contract.test.ts` 与代码锁定，无需修改。

---

## 总结

v1 已经交付了一个**本地优先、安全可控、可打开真实 Workspace 的 Agent Runtime + Host API + Web UI MVP**。Runtime Kernel 核心机制稳定并进入谨慎修改区；Host 与 Web 提供了浏览器可用的产品入口；测试基线 14/14 通过。

下一阶段明确目标：**Session Persistence / SQLite**，解决 Host 内存态与重启后历史恢复问题。
