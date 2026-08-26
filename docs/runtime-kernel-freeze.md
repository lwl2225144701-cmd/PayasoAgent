# PayasoAgent Runtime Kernel Freeze Baseline

> **⚠️ 本文档已过时（Superseded）。** 描述的是 v1.3.3 Kernel Freeze 基线；代码已演进到 v1.5 + Host API + Web UI（写工具 / shell / workspace 均已实现，Freeze 声明已实际被打破）。**当前架构以 [architecture-current.md](./architecture-current.md) 为准**。本文件仅保留作为 Freeze 基线的历史记录。

> 文档定位：Kernel 阶段总结 — 以 `src/runtime/` 代码与现有测试为准，梳理"这个 Runtime 现在能保证什么"，并明确 Kernel / Harness 的分层边界。
>
> 核心原则：**不证明 Runtime 很强，只说它已验证过的边界；不夸大能力，不脑补未实现特性。**

---

## 1. 阶段目标

### 1.1 起点与演进路径

从最精简的 LLM 调用循环出发，遇到真实问题再做最小修复，不提前引入抽象层：

```
v1.0  基础 Agent Loop
  └─ LLM → tool_call → Tool → result → LLM
  └─ 无状态、无持久化、无安全边界

v1.1  最小可观测 + 状态
  └─ State / Trace / Scratchpad
  └─ Sandbox 工作区（input/work/output）
  └─ 路径解析与基础沙箱边界

v1.2  Tool Result Validation + 死循环防护
  └─ 区分 execute 成功 vs 结果有效
  └─ invalid result 不进 completedSteps
  └─ 失败参数记录 + isBlocked 禁调

v1.3  Tool Effect Contract + Side-Effect Safety
  └─ effect: read / idempotent / non_idempotent
  └─ non_idempotent 必须显式 getOperationKey
  └─ executing / succeeded / uncertain 生命周期
  └─ execute 前持久化 executing；uncertain 不盲目重放

v1.3.3  Tool Output Guard
  └─ 16KB per-result 硬上限
  └─ validate 看 raw；后续 Runtime 统一用 guarded
```

### 1.2 Runtime 职责边界（Kernel 负责的事）

| 属于 Runtime Kernel | 不属于 Kernel（留给 Harness / Extension） |
|---|---|
| Agent Loop 迭代与预算控制 | Memory / RAG / 长期记忆 |
| State / Scratchpad / Messages 管理 | Planner / Task Decomposition |
| Context trimming（短期上下文裁剪） | Reviewer / Self-Critique |
| Tool 执行编排（含 Retry / Recovery） | Model Adapter / Provider Abstraction |
| Tool Result Validation | Skills / Tool Registry 扩展框架 |
| Tool Effect Contract 语义执行 | MCP / External Tool Protocol |
| Side-Effect Safety 生命周期 | Multi-Agent Orchestration |
| Tool Output Guard（单结果 16KB） | Prompt Engineering / System Prompt 模板 |
| Checkpoint / Resume（最小本地 JSON） | Web UI / API Server |
| Sandbox 路径边界（workspace 内） | writeFile / shell / 有副作用的宿主能力 |
| Trace 事件输出 | 日志聚合 / 监控面板 |
| runId 安全注入（LLM 不可控） | User Auth / Multi-Tenant |

---

## 2. 当前架构

### 2.1 目录树与模块职责

```
PayasoAgent/
├── src/
│   ├── runtime/                # Kernel 层（本文档定义为 Freeze 区）
│   │   ├── agent.ts            # Agent Loop 主循环（LLM→Tool→LLM，iteration 预算）
│   │   ├── state.ts            # AgentState：status / iteration / 统计 / pendingAction / lastError
│   │   ├── scratchpad.ts       # 短期执行进度（completed/failed/invalid/nextStep，随 system 注入不被裁剪）
│   │   ├── context.ts          # ContextManager：按轮分组裁剪 messages（保留 system+最后 user）
│   │   ├── trace.ts            # 结构化事件（12 类事件，step/timestamp 自增）
│   │   ├── checkpoint.ts       # 最小 JSON 持久化（.checkpoints/<runId>.json）
│   │   ├── side-effect.ts      # SideEffectGuard：operation identity + executing/succeeded/uncertain 生命周期
│   │   └── output-guard.ts     # guardToolOutput：单 Tool result 限 16KB，UTF-8 安全截断
│   │
│   ├── tools/                  # Tool 层（Kernel 的边界接口，不算 runtime 但属于 Kernel Freeze 契约）
│   │   ├── tools.ts            # Tool 注册 / 执行 / Schema 导出 / validateResult / resolveOperationKey
│   │   └── filesystem.ts       # 只读沙箱工具：listDir / readFile（无 write/delete/shell）
│   │
│   ├── sandbox/
│   │   └── sandbox-manager.ts  # 工作区生命周期：createWorkspace / resolvePath / assertInsideWorkspace / cleanupWorkspace
│   │
│   ├── llm/
│   │   └── llm.ts              # 最小 OpenAI 兼容 chat/completions 封装（fetch，无 SDK，无 Provider 抽象）
│   │
│   └── cli.ts                  # 入口：npm start "任务" / --resume <runId> / --run-id <id>
│
├── tests/                      # 验证集合（非 Kernel 代码，但定义 Kernel 的保证）
│   ├── run-all.ts              # 确定性套件聚合：7 套件，无 LLM，秒级
│   ├── tool-contract.test.ts   # runId 边界 + effect 契约 + getOperationKey 注册校验
│   ├── operation-identity.test.ts  # canonical key 命名空间隔离 + 参数顺序归一化
│   ├── operation-replay.test.ts    # crash 后 uncertain 阻断：重复副作用 executions=1
│   ├── side-effect.test.ts         # begin/succeed/markUncertain + resolveOperation 语义
│   ├── output-guard.test.ts        # 16KB 截断 + UTF-8 字符边界 + metadata
│   ├── filesystem-tools.test.ts    # listDir/readFile 行为 + 大文件/二进制判定
│   ├── sandbox-manager.test.ts     # resolvePath/assertInsideWorkspace 边界（../ 绝对路径 symlink cleanup）
│   ├── agent.test.ts               # Agent E2E（需 LLM，含死循环/恢复/无效结果路径）
│   ├── diag-large-700k.test.ts     # 大输出修复验证：700KB → guarded ≤16KB，Context 不撑爆
│   └── stress.test.ts              # 压测编排器 + 23 场景（5 组：长链/大输出/恢复/副作用/沙箱）
│
├── sandbox/
│   └── workspaces/            # 运行时工作区（<runId>/{input,work,output}）
│
├── .checkpoints/              # checkpoint JSON（未入库，本地文件）
│
└── docs/
    └── runtime-kernel-freeze.md  # 本文档
```

### 2.2 模块依赖方向（无循环）

```
cli.ts
  └─ runtime/agent.ts
       ├─ llm/llm.ts                    # 纯 I/O，不反向依赖
       ├─ tools/tools.ts + filesystem.ts  # Tool 不反向依赖 runtime
       │    └─ sandbox/sandbox-manager.ts # 路径解析独立
       ├─ runtime/state.ts
       ├─ runtime/scratchpad.ts
       ├─ runtime/context.ts
       ├─ runtime/trace.ts
       ├─ runtime/checkpoint.ts        # checkpoint 只写状态快照，不读回
       ├─ runtime/side-effect.ts       # 纯 Map，不依赖 agent
       └─ runtime/output-guard.ts      # 纯函数，无依赖
```

---

## 3. Agent Loop

### 3.1 主循环流程

定义在 [agent.ts](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/agent.ts)

```
for (i = startIter .. MAX_ITERATIONS):
  ┌─ 0. 注入 Scratchpad 到 system prompt（每次重写 messages[0]）
  │     保证：即使 messages 被裁剪，LLM 仍能看到完整执行进度
  │
  ├─ 0.5 ContextManager.process() → 按轮裁剪（超出 4000 字符时丢弃最早 assistant+tool 块）
  │
  ├─ 1. chat(messages, getSchemas()) → assistantMsg
  │     若 tool_calls 为空：stripThink → 最终答案，saveCheckpoint("completed")，return
  │
  └─ 2. 逐个处理 assistantMsg.tool_calls:
        ├─ 2a. Side-Effect Safety（仅 non_idempotent）
        │     resolveOperation → replay / uncertain / start
        │     replay    → push tool message（首次结果），continue
        │     uncertain → push uncertain 说明，continue
        │     start     → 继续
        │
        ├─ 2b. 死循环防护 isBlocked(toolName, input, MAX_RETRY)
        │     失败次数超限 或 已记录 invalid → push blocked 消息，continue
        │
        ├─ 2c. (仅 non_idempotent) sideEffectGuard.begin(key) + saveCheckpoint()
        │     persist 失败 → Runtime Error，禁止 execute
        │
        └─ 2d. 工具执行（重试策略：
                 non_idempotent → effectiveRetries=0，失败即 uncertain，不重试
                 read/idempotent → effectiveRetries=MAX_RETRY=2）
              ├─ try execute() → rawResult
              │    ├─ validateToolResult(toolName, rawResult)  → vr
              │    ├─ guardToolOutput(rawResult)               → guarded（后续只使用 guarded.content）
              │    │     truncated 时 emit tool_output_truncated 事件
              │    ├─ markExecuted(sideEffectGuard, tool, args, result) → succeeded
              │    ├─ vr.valid ? completeStep / save / push result
              │    │           : recordInvalid  / save / push recoveryMsg
              │    └─ break
              └─ catch err
                   ├─ non_idempotent → sideEffectGuard.markUncertain(key)
                   ├─ recordFailure + saveCheckpoint
                   └─ attempt 耗尽 → push recovery 消息，break，交还 LLM 决策

超过 MAX_ITERATIONS → status="failed"，saveCheckpoint，throw
```

### 3.2 关键常量（设计边界，不作为 Bug）

| 常量 | 值 | 位置 | 语义 |
|---|---|---|---|
| `MAX_ITERATIONS` | 10 | [agent.ts:31](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/agent.ts#L31) | 单次运行执行预算（resume 不延长剩余预算） |
| `MAX_RETRY` | 2 | [agent.ts:32](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/agent.ts#L32) | read/idempotent 工具的重试次数（总尝试 = 1 + 2） |
| `MAX_CONTEXT_TOKENS` | 4000 | [agent.ts:33](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/agent.ts#L33) | ContextManager 裁剪阈值（粗略字符数，非 token） |

### 3.3 Retry / Recovery / Dead-loop 保护

```
          execute throw
              │
              ├─ non_idempotent ──→ markUncertain ──→ 无重试 ──→ Recovery（交还 LLM）
              │
              └─ read/idempotent ──→ attempt ≤ MAX_RETRY ? Retry : Recovery（交还 LLM）
                                        │
                                        ▼
                              attempt 内连续重试，不回到 LLM

Dead-loop 防护：
  同 tool + input → retries > MAX_RETRY  或  已记录 invalid
    └─ isBlocked = true → 再次收到同参数直接 push blocked 消息，不 execute
```

---

## 4. State / Scratchpad / Context

### 4.1 三者职责分离

| 模块 | 存储内容 | 持久化？ | 被 LLM 看到？ | 裁剪影响？ |
|---|---|---|---|---|
| **State** ([state.ts](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/state.ts)) | runId、status、iteration、调用统计、currentError、pendingAction、lastToolError | ✓ checkpoint 全量快照 | ✗（仅 Runtime 内部用） | ✗ |
| **Scratchpad** ([scratchpad.ts](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/scratchpad.ts)) | completedSteps、failedSteps、invalidSteps、nextStep、lastResult | ✓ checkpoint 全量快照 | ✓（每轮注入 system prompt） | ✗（不随 messages 裁剪） |
| **Messages** ([context.ts](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/context.ts)) | 标准 ChatML：system / user / assistant / tool | ✓ checkpoint 全量快照 | ✓（直接送入 LLM） | ✓（超出上限时按轮裁剪） |

### 4.2 Scratchpad 注入机制

```
messages[0] = {
  role: "system",
  content:
    SYSTEM_PROMPT                   # 静态规则（如"计算必须用 calculator"）
    + "\n\n"
    + toSystemText(scratchpad)      # 动态执行进度（每轮重写）
}
```

关键保证：**Scratchpad 永远在 system 消息第一条里，不参与裁剪。** ContextManager 的裁剪策略强制保留 `messages[0]`（system）+ 最后一条 user，因此执行进度不会因长链任务丢失。

### 4.3 Context Trimming 策略

定义在 [context.ts](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/context.ts)

```
保留（不裁剪）：
  ├─ 第一条 system（含 Scratchpad）
  └─ 最后一条 user（原始任务）

其余消息按"轮"分组：assistant + 其后续 tool messages = 一块

裁剪：从最早块开始丢弃，直到 estimateTokens ≤ maxLength
  estimateTokens = Σ JSON.stringify(message).length（粗略字符数）
```

### 4.4 运行状态枚举

```
AgentStatus:
  ├─ "running"    → 正常循环中
  ├─ "completed"  → 无 tool_call 且返回最终答案
  └─ "failed"     → 顶层异常 或 MAX_ITERATIONS 触顶

currentStep 粒度：
  llm_call → tool_call:<name> → tool_result / tool_result_invalid / tool_error / tool_blocked → final_answer → error
```

---

## 5. Tool Runtime

### 5.1 ToolContext 注入边界

定义在 [tools.ts:9-12](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/tools/tools.ts#L9-L12)

```ts
export interface ToolContext {
  runId: string;  // 只来自 Agent State.runId，不出现在 Tool Schema，LLM 不可见不可传
}
```

**Runtime 执行时的调用栈（谁来注入 runId）：**

```
runAgent() → execute(toolName, args, { runId: state.runId })
                                  ▲
                                  │ 只允许这个入口
                            Tool 内部的 path 解析
                              └─ resolvePath(context.runId, relativePath)
                              └─ assertInsideWorkspace(context.runId, realPath)
```

安全保证（已由 `tool-contract.test.ts` 验证）：
- Schema 中不出现 `runId` 字段名（LLM 看不到）
- 即使恶意 tool_call 在 args 里塞 `runId`，工具只信 `context.runId`
- 不同 runId 调用互不串（工作区隔离）

### 5.2 Result Validation（执行成功 ≠ 结果可用）

两个正交维度：

```
execute() throw                    → tool_error（执行维度失败）
execute() return + validateResult  → tool_result（valid=true） 或 tool_result_invalid（valid=false）
```

```
                    ┌─ valid=true   → completeStep → completedSteps 入队
                    │                  → push tool result
validateResult ─────┤
                    └─ valid=false  → recordInvalid → invalidSteps 入队
                                       → push recoveryMsg（建议 LLM 修正/换方法）
                                       → 不进 completedSteps（不计入进度）
                                       → isBlocked 记录（同参数不得重复依赖）
```

### 5.3 Tool Output Guard（v1.3.3）

定义在 [output-guard.ts](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/output-guard.ts)

```
execute → rawResult（可能 700KB）
    │
    ├─ validateToolResult(toolName, rawResult)    ← 看完整 raw，业务有效性不被截断影响
    │
    └─ guardToolOutput(rawResult) → guarded.content（≤ 16KB 原则）
          │
          ├─ truncated=true  → emit tool_output_truncated(originalBytes, returnedBytes)
          │
          └─ 后续统一使用 guarded.content：
                ├─ markExecuted() → 存 succeeded 结果（回放不爆）
                ├─ completeStep() → Scratchpad.completedSteps.result（system 不被撑）
                ├─ messages.push() → tool message（Context 不被撑）
                └─ Trace tool_result / tool_result_invalid 事件（日志不爆）
```

**这是 Context 不被撑爆的唯一防线。** 大 Tool result 如果绕过了它直接进入 `messages + scratchpad.system`，就会同时出现在两份拷贝里，ContextManager 又不能裁剪 system 消息 → OOM/worker crash。

---

## 6. Sandbox

### 6.1 Workspace 结构

定义在 [sandbox-manager.ts](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/sandbox/sandbox-manager.ts)

```
<sandboxRoot>/workspaces/<runId>/
    ├── input/     # 预置只读输入（Agent 任务前置数据放这里）
    ├── work/      # Agent 可操作区（当前仅只读工具，实际不写）
    └── output/    # 结果输出（当前无写工具，预留）
```

默认 sandboxRoot = `<projectRoot>/sandbox`，可被 `SANDBOX_ROOT` 环境变量覆盖（测试指向临时目录）。

### 6.2 权限模型

当前 Runtime 暴露的文件能力：**只读，无写入/删除/执行。**

```
listDir(path)   读目录条目（不跟随 symlink，仅列名）
readFile(path)  读 UTF-8 文本（≤1MB；二进制返回 invalid；超 1MB 返回 invalid）
```

均为 `effect: "read"`。**writeFile / deleteFile / shell / 任意宿主命令当前不在 Kernel 能力范围内。**

### 6.3 两层路径校验

文件工具的 `guardPath()` 会依次执行两层，任何一层不通过即 `tool_error` 阻断：

```
Layer 1: resolvePath(runId, relativePath)  —— 字符串级
  ├─ relativePath 为空 → 拒绝
  ├─ 绝对路径（含 Windows 盘符）→ 拒绝
  ├─ path segments 含 ".." → 拒绝
  ├─ 拼接 root + segments 后仍必须是 root 或 root 子路径
  └─ runId 正则：[A-Za-z0-9_-]{1,128}（禁止路径分隔符）

Layer 2: assertInsideWorkspace(runId, absPath)  —— 真实路径级
  ├─ 字符串前缀：abs 必须 === root 或 startsWith(root+sep)
  ├─ workspace 根本身不能是 symlink（防止根被偷换）
  ├─ realpath 解析：目标/最近存在祖先 的 realpath 必须仍在 realBase 之下
  ├─ 若目标不存在但本身是悬空 symlink → 拒绝
  └─ macOS 的 /var → /private/var 等系统级 symlink 被正确处理（只 realpath 一次基准）
```

### 6.4 Cleanup 边界

`cleanupWorkspace(runId)` 只能删 `<sandboxRoot>/workspaces/<runId>/` 单段目录：

- 不允许删 `sandbox/` 根
- 不允许删 `workspaces/` 集合目录
- runId 经过正则校验（无 `..` / 分隔符）
- relative(`workspacesDir`, root) 必须无 `..`、无分隔符、非空

Sandbox 逃逸攻击路径在 `sandbox-manager.test.ts` + `stress.test.ts` 中有覆盖，当前验证全部阻断：
- `../` 穿越
- 绝对路径 `/etc/passwd`
- Windows 盘符 `C:\`
- symlink 指向 workspace 外（含悬空 symlink）
- cleanup 路径构造越权

---

## 7. Tool Effect Contract

定义在 [tools.ts:14-34](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/tools/tools.ts#L14-L34)

### 7.1 三类 effect 语义

| effect | 副作用强度 | 自动 Retry？ | 需要显式 getOperationKey？ | 典型工具 |
|---|---|---|---|---|
| **read** | 纯读取，无状态变更 | ✓ 最多 MAX_RETRY | 否（fallback JSON.stringify(args)） | getWeather、listDir、readFile |
| **idempotent** | 可重复执行，同参→等价结果 | ✓ 最多 MAX_RETRY | 否（fallback JSON.stringify(args)） | calculator（纯函数） |
| **non_idempotent** | 高风险副作用，重复执行后果不可逆 | ✗（effectiveRetries=0，一次失败即 Recovery） | **是（注册期强制校验，缺失则注册失败）** | appendEntry、flakyWrite、crashTool（压测夹具） |

### 7.2 non_idempotent 强制 getOperationKey（注册期 Fail-Fast）

```ts
// tools.ts:register() 内部
if (
  tool.effect === "non_idempotent" &&
  typeof tool.getOperationKey !== "function"
) {
  throw new Error(`Tool "${tool.name}" 声明为 non_idempotent 但未实现 getOperationKey，注册失败...`);
}
```

这是**编译期后的第一防线**：non_idempotent 工具如果没明确说明"什么叫同一个操作"，根本进不了注册表。

### 7.3 effect / getOperationKey 不泄露给 LLM

`getSchemas()` 只取 `{name, description, parameters}`，Schema JSON 中不出现 `effect`、`getOperationKey` 字段。LLM 的 Tool 视图与 Runtime 内部契约完全解耦。（由 `tool-contract.test.ts` 验证）

---

## 8. Operation Identity

### 8.1 Canonical Key 格式

```
operationIdentity(tool, args) = `${tool.name}::${resolveOperationKey(tool, args)}`
```

- **跨工具命名空间隔离**：即使两个 Tool 参数完全相同，也会因 `tool.name` 前缀而不会冲突
- **non_idempotent 必须使用显式 canonical key**：不允许 fallback 到 `JSON.stringify(args)`

### 8.2 resolveOperationKey 策略

```
有显式 tool.getOperationKey(args)
  └─ 使用其返回值（权威身份，由 Tool 作者定义"什么叫同一个操作"）

无显式 getOperationKey 且 effect ≠ non_idempotent
  └─ fallback JSON.stringify(args)（read / idempotent 允许）

无显式 getOperationKey 且 effect === non_idempotent
  └─ 抛错（注册期已拦截，此处为防御兜底）
```

### 8.3 同操作 vs 不同操作的区分

**例：写文件 Tool**

```
getOperationKey = (args) => `write:${args.path}:${args.content}`

  path=a.txt content=hello  →  write:a.txt:hello  （同一 canonical key）
  path=a.txt content=hello  →  write:a.txt:hello  （同上 → 被去重）
  path=a.txt content=world  →  write:a.txt:world  （内容不同 → 不同操作，不错杀）
  path=b.txt content=hello  →  write:b.txt:hello  （路径不同 → 不同操作，不错杀）
```

文件路径的 canonicalization 责任在 Tool 作者（在 `getOperationKey` 内部处理路径归一化）。Kernel 不做自动路径 canonicalization，只做命名空间前缀 + 显式 key 字符串相等比较。

---

## 9. Side-Effect Safety

> **核心设计立场：at-most-once oriented safety，不是 exactly-once。**
>
> Runtime 一旦无法 100% 确认"某 non_idempotent 操作从未执行过副作用"，就**绝对不会再次自动执行它**。宁可返回 uncertain 让用户/上层处理，也不伪造"成功"或冒重复副作用的风险。

### 9.1 操作状态模型

定义在 [side-effect.ts](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/side-effect.ts)

```
                begin()            succeed(result)
  nonexistent ──────────► executing ───────────────► succeeded
                              │
                              │ execute throw / crash
                              ▼
                          uncertain   ────────►  持久化，resume 后仍是 uncertain
                                                  不允许再次自动执行
```

| 状态 | 再次收到同 key 请求 |
|---|---|
| `succeeded` | **replay**：返回首次成功结果，不重新 execute |
| `executing` | **uncertain disposition**：不 execute，返回 uncertain 说明给 LLM |
| `uncertain` | **uncertain disposition**：同上 |
| `nonexistent` | **start**：正常开始，需先持久化 `executing` 再 execute |

### 9.2 Agent Loop 集成点（agent.ts 中关键顺序）

```
收到 tool_call（non_idempotent）
    │
    ├─ [1] resolveOperation → 先判 disposition（防重放 / 防 uncertain 重跑）
    │
    ├─ [2] isBlocked 死循环防护
    │
    ├─ [3] sideEffectGuard.begin(opKey)        ← in-memory 设为 executing
    │   └─ saveCheckpoint()                     ← **持久化 executing**（必须在 execute 前）
    │        persist 失败 → Runtime Error，禁止 execute
    │
    ├─ [4] execute()                            ← 真正执行
    │     ├─ success → markExecuted()  → succeeded（存 guarded result）
    │     └─ throw   → markUncertain() → uncertain
    │
    └─ [5] saveCheckpoint()                     ← 结果态持久化（用于 resume）
```

**关键不变量：** non_idempotent 工具的 execute 开始前，`.checkpoints/<runId>.json` 中必须已写入 `state=executing` 的记录。万一进程在 execute 中途被 SIGKILL，checkpoint 里有这个 executing 记录，resume 时 resolveOperation 命中 `executing` → uncertain disposition → 不会再跑。

### 9.3 non_idempotent 禁止自动 Retry

```ts
// agent.ts:292
const effectiveRetries = toolDef?.effect === "non_idempotent" ? 0 : MAX_RETRY;
```

- `read` / `idempotent`：总尝试 = 1 + MAX_RETRY = 3 次
- `non_idempotent`：总尝试 = 1 次。首次失败 → 直接 markUncertain → Recovery（交还 LLM）

理由：execute throw 的瞬间，我们不知道副作用发生到哪一步。自动重试等于在"也许已经写了一半"的状态下再写一次，必然重复副作用。

---

## 10. Checkpoint / Resume

### 10.1 保存内容

定义在 [checkpoint.ts:14-25](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/checkpoint.ts#L14-L25)

```
.checkpoints/<runId>.json = {
  runId, task, status, iteration,          // 运行元数据
  scratchpad: Scratchpad,                  // 执行进度（完整）
  messages: ChatMessage[],                 // 消息历史（完整，含裁剪前）
  state: AgentState,                       // 状态快照
  sideEffects?: ExecutedOperation[],       // v1.3：non_idempotent 操作记录（含 state=succeeded/executing/uncertain）
  savedAt: ISOString
}
```

### 10.2 保存时机（每步至少一次）

```
save() 在以下节点被调用：
  ├─ non_idempotent begin() 执行前（persist executing 态）
  ├─ tool_result 有效后（succeeded）
  ├─ tool_result_invalid 后
  ├─ tool_error（重试每一次失败 + 重试耗尽）
  ├─ final_answer 前 → status=completed
  ├─ 顶层异常 → status=failed
  └─ MAX_ITERATIONS 触顶 → status=failed
```

### 10.3 Resume 语义

```ts
startIter = resume ? Math.max(0, resume.iteration - 1) : 0;
```

- **不延长** `MAX_ITERATIONS` 预算：恢复后从 `iteration-1` 开始重跑当前轮，但总预算仍 ≈ 10 轮
- `sideEffects` 从 checkpoint 完整恢复：已 succeeded → replay；已 executing/uncertain → 阻断
- `scratchpad.completedSteps` 完整恢复 → 已完成步骤不重写
- **Workspace 不 cleanup、不重置**：沿用原 `<runId>/` 目录（`createWorkspace` 为幂等复用）

### 10.4 uncertain operation 的 Resume 处理

Resume 时 `seed = checkpoint.sideEffects` 被完整灌入 `createSideEffectGuard(seed)`，含 `state=executing/uncertain` 的记录。这些操作在恢复后的 Loop 中：

- 不会被 replay（只 replay succeeded）
- 不会被重新 execute
- 只会返回不确定信息，交由 LLM / 用户决策下一步

---

## 11. Tool Output Guard

### 11.1 为什么引入

**修复前的缺口链**（压测 `large-read-700k` 场景真实出现的问题）：

```
readFile 返回 700KB 文本
    │ rawResult 同时进入两份拷贝
    ├─ messages.push({ role: "tool", content: rawResult })
    └─ completeStep(scratchpad, rawResult) → completedSteps[0].result → toSystemText() → messages[0].content（system）
    │
    ▼
messages 总字节 ≈ 1.4MB → worker 崩溃（fetch body 过大 / V8 string 分配异常）
ContextManager 无法裁剪 messages[0]（system 必须保留）→ 兜底失败
```

**缺口位置不是 readFile 读了 700KB（1MB 限制下是允许的），而是 Runtime 把完整 raw 结果不带限制地送进了 Context 两条路径。**

### 11.2 16KB per-result 边界

```ts
MAX_TOOL_OUTPUT_BYTES = 16 * 1024;   // 硬上限
HEAD_BYTES = 6 * 1024;                // 保留前 6KB
TAIL_BYTES = 4 * 1024;                // 保留后 4KB
TRUNCATION_MARKER = "[OUTPUT TRUNCATED]";
```

> 注：实际截断后字节 ≈ 6KB + marker 字节 + 4KB，略小于上限但不会超过。

截断策略 UTF-8 字符边界安全：若截断点落在多字节字符内部（`buf[end]` 是续字节 `10xxxxxx`），回退到该字符开头；尾部同理。避免出现半个汉字/表情导致的乱码或 JSON 解析失败。

### 11.3 validate 看 raw，后续只使用 guarded

```
rawResult  →  validateToolResult(toolName, rawResult)   ← 完整，不截断（业务有效性判断必须看全）
           ↘  guardToolOutput(rawResult)                ← 截断，此后 messages/scratchpad/trace/succeeded 全用 guarded.content
```

这个顺序是刻意的：例如 `readFile` 对超大/二进制返回 `[sandbox-tool-invalid]` 标记，validateResult 必须看到这整段标记（它本身很短，不触发截断）；如果先截断再 validate，可能把标记切坏。

### 11.4 观测性：`tool_output_truncated` 事件

截断发生时 Trace 写入：

```ts
{ type: "tool_output_truncated", tool, originalBytes, returnedBytes }
```

可用于事后审计：某个 Tool 输出经常被截断 → 上层应考虑分页/流式/分块读取策略。

### 11.5 700KB 场景修复前后数据（压测 v1.3.3 实测）

| 指标 | 修复前（FAIL） | 修复后（PASS） |
|---|---|---|
| 读取字节数 | ~700KB | ~700KB（不变） |
| `msgBytes`（checkpoint messages 总 JSON 长度） | ~1.4MB（Context 撑爆） | ~25KB |
| `completedSteps[0].result.length` | ~700KB | ~10KB（截断后） |
| `tool_output_truncated` 事件 | 无（无此机制） | 有，originalBytes≈700KB returnedBytes≈10KB |
| Agent 进程结果 | worker 崩溃 / 响应异常 | 正常返回答案（首句/行数） |

---

## 12. Trace / Observability

定义在 [trace.ts](file:///Users/luweiliang/Downloads/myProject/PayasoAgent/src/runtime/trace.ts)

### 12.1 当前事件类型（12 类）

| 事件 | 触发时机 | 关键字段 |
|---|---|---|
| `llm_call` | 每次 LLM 调用后 | messageCount, iteration, response, hasToolCalls |
| `tool_call` | 工具执行前（已过 side-effect + blocked 判定） | tool, args |
| `tool_result` | 工具执行成功且结果有效 | tool, result, durationMs |
| `tool_result_invalid` | 工具执行成功但 validateResult 判无效 | tool, result, reason |
| `final_answer` | LLM 返回无 tool_call 且输出最终答案 | content, totalSteps |
| `tool_error` | 工具 execute throw | tool, error, attempt, exhausted |
| `context_trim` | 每轮 messages 裁剪后 | beforeMessages, afterMessages |
| `recovery_decision` | 重试耗尽 / 不确定态，交还 LLM 决策 | tool, decision |
| `side_effect_skip` | non_idempotent 同 key 被去重回放 | tool, key, replayed=true |
| `side_effect_uncertain` | non_idempotent 命中 executing/uncertain | tool, key |
| `tool_output_truncated` | Tool Output Guard 截断发生 | tool, originalBytes, returnedBytes |
| `scratchpad_update` | completeStep() 后同步 | currentStep, completedSteps, lastResult |
| `error` | 顶层未捕获异常（含 MAX_ITERATIONS） | message |

### 12.2 Trace 用途

- **调试**：每步实时 `printEvent`，问题可单步回放
- **审计**：checkpoint 不存 Trace，但 stdout 日志保留；压测 `.stress-logs/<id>.log` 全量留存
- **非持久化**：当前 Trace 是内存对象，不写入 checkpoint。需要持久化 Trace 属于 Harness 层能力。

---

## 13. 测试与压测结论

### 13.1 测试分层

```
确定性测试（npm run test:all，7 套件，无 LLM，秒级）
  ├─ tool-contract         17 pass    runId 边界 / effect 注册校验 / fallback 语义 / Schema 不泄露
  ├─ operation-identity     3 pass    跨工具命名空间 / fallback 参数顺序 / 显式 key 归一化
  ├─ operation-replay       3 pass    crash 后 uncertain 阻断 / resume 防重放 / succeeded 回放
  ├─ side-effect           N pass     begin/succeed/markUncertain / resolveOperation 三态语义
  ├─ output-guard          N pass     边界字节 / UTF-8 字符边界截断 / metadata / 空串
  ├─ filesystem-tools      N pass     listDir/readFile 行为 / 大文件判 invalid / 二进制判定
  └─ sandbox-manager       N pass     ../../../ / 绝对路径 / symlink 逃逸 / cleanup 边界

Agent E2E（npm test，需 LLM）
  └─ agent.test.ts         覆盖死循环 / 恢复 / invalid 结果 / 正常路径

定向诊断（需 LLM）
  └─ diag-large-700k.test.ts   修复后验证：guardedResultBytes ≤16KB，msgBytes ≤50KB

压测（npm run test:stress，需 LLM，23 场景）
  └─ stress.test.ts         5 组：长链/大输出/失败恢复/副作用安全/Sandbox 攻击
```

### 13.2 已验证关闭的问题（即 Kernel 现在提供的保证）

| 保证 | 验证场景 | 当前结论 |
|---|---|---|
| **Sandbox 逃逸**（../ 绝对路径 symlink cleanup） | `sandbox-traversal` / `sandbox-absolute` / `sandbox-symlink` / `sandbox-cleanup-root` / sandbox-manager.test.ts | **全拦截，PASS** |
| **non_idempotent 重复副作用**（崩溃后重试 / 同 key 重复请求 / resume 重跑） | `se-crash-after-effect` / `se-flaky-retry-dedup` / `se-dedup-same-key` / `se-resume-phase2` / operation-replay.test.ts | **不重复，executions=1** |
| **Recovery / Resume same-key 重放**（已成功操作 resume 后不重写） | `se-resume-phase2` / `longchain-resume` | **不重写，头部不变，步骤增长** |
| **大 Tool Output 撑爆 Context**（700KB readFile → messages + system） | `large-read-700k` / diag-large-700k.test.ts | **msgBytes 从 1.4MB 降至 ~25KB，PASS** |
| **状态恢复**（crash 后 completedSteps 不丢、不重写） | `longchain-resume` / `se-resume-phase2` | **头部不变 + 步骤增长 + 无重复 step 号** |
| **runId 安全边界**（LLM 不可见不可控、args 不覆盖、Schema 不泄露） | tool-contract.test.ts 前半 | **全通过** |

### 13.3 真实 Runtime FAIL vs LLM 行为波动

压测 v1.3.3 全量 23 场景结论：**19 PASS / 4 FAIL**

| 场景 | 结果 | 分类 | 是否可信为 Runtime 缺口 |
|---|---|---|---|
| `longchain-cap` | FAIL | 长链任务 12 步触顶 | **设计边界**（MAX_ITERATIONS=10，非安全缺陷） |
| `large-read-binary` | FAIL | LLM 未调用 readFile，invalid 事件=0 | **LLM 行为，不可信**（二进制检测本身在 output-guard + filesystem test 中已验证） |
| `se-dedup-same-key` | FAIL | LLM 未按要求重复调用同参数 appendEntry | **LLM 行为，不可信**（去重语义在 operation-identity / operation-replay 单测中已验证） |
| `sandbox-e2e-hostfile` | FAIL | LLM 未尝试读取受限路径，readFile 被拦=0 | **LLM 行为，不可信**（边界拦截在 sandbox-manager.test.ts + sandbox 组场景中已验证） |

> 结论：**压测剩余 4 个 FAIL，没有新的真实 Kernel 安全缺口需要本轮修复。** 3 个是 LLM 非确定性，1 个是明确的设计边界（MAX_ITERATIONS）。

---

## 14. 已知边界

### 14.1 MAX_ITERATIONS=10

**定位：execution budget 设计边界，不作为安全缺陷。**

```
单次运行循环：for (i = startIter .. MAX_ITERATIONS=10)
  ├─ 长于 10 步的任务 → 触顶后 status="failed" + throw
  └─ resume 不延长预算（startIter = iteration-1，剩余预算仍从 10 递减）
```

压测 `longchain-cap`（12 步纯计算链）和 `resume-phase2`（resume 后续跑）都因该上限无法在单次运行中完整完成。长链任务如需突破，属于 Harness 层工作（切分子任务 / 多次 resume / Planner 级拆解），不在 Kernel Freeze 范围内。

### 14.2 其他明确的 Kernel 非目标

以下能力**明确不属于当前 Runtime Kernel**，不要擅自往 `runtime/` 目录加实现：

- **exactly-once delivery / transactional tool**：Kernel 只做 at-most-once oriented safety。exactly-once 需要 Tool 端支持幂等 token / 事务回滚，属于 Tool/Harness 设计。
- **超时机制**：`slowTool` 场景当前 Runtime 不提供 `abortSignal` / `timeout` 包装，工具可无限阻塞直至自身返回或 throw。
- **流式 / 分页 Tool Output**：只做一次性截断（前 6KB + 标记 + 后 4KB），不负责偏移读取 / 分块 / 迭代。
- **多模型 / 多 Provider 切换**：`llm/llm.ts` 只有单组环境变量，无路由/降级/缓存。
- **长期 Memory / RAG**：Scratchpad 是短期单 run 进度，不跨 run 持久化（除了 checkpoint 用于 resume 同一条 run）。
- **用户鉴权 / Multi-Tenant**：runId 是单租户命名，没有 ACL / 用户隔离语义。
- **写入类宿主能力**：writeFile / deleteFile / shell 执行当前均未提供。需要时在 Harness 层单独引入并重新评估副作用契约。

---

## 15. 阶段结论

### 15.1 版本定义

```
PayasoAgent Runtime Kernel Freeze Baseline
            ~ v1.3.3 ~
```

`src/runtime/` 目录（含 `src/tools/tools.ts` Tool 契约）进入**谨慎修改区**。

### 15.2 Kernel Freeze 后的变更策略

```
进入 Kernel Freeze 后：
  ├─ 修 Bug / 安全缺口：可以改，但必须带回归测试
  ├─ 加"方便" / 抽象 / 扩展性：不进 runtime/，放 Harness/Extension 层
  └─ 任何 effect contract 语义变更（新增 effect 类型、改变 uncertain 策略等）
       → 必须先经过设计评审 + 完整压测回归，再考虑是否打破 Freeze
```

### 15.3 Harness / Extension 层优先承接的能力

以下演进方向**明确属于下一层，不进 Kernel**：

```
Harness / Extension 层 Roadmap（非 Kernel）
  ├─ Memory / RAG / 跨 Run 长期记忆
  ├─ Model Adapter / Multi-Provider 路由 / 缓存 / Fallback
  ├─ Planner / Task Decomposition / Sub-agent 编排
  ├─ Reviewer / Self-Critique / Verifier 回路
  ├─ Skills 框架 / Tool Registry 动态加载 / MCP 协议桥接
  ├─ Prompt 模板系统 / System Prompt 配置化
  ├─ writeFile / appendFile / shell 等有副作用宿主能力（重新评估契约）
  ├─ API Server / Web UI / 鉴权 / 多租户
  ├─ Trace 持久化 + 聚合面板 / 指标监控
  └─ 长链任务自动 resume（绕开 MAX_ITERATIONS 预算的 Harness 级编排）
```

---

## Runtime Kernel Freeze Checklist

### ✅ 已冻结（Kernel 保证，Freeze 后慎改）

| # | 能力 | 验证来源 |
|---|---|---|
| F-1 | LLM → Tool → Result → LLM 基本循环（含 iteration 预算） | agent.test.ts / stress |
| F-2 | State / Scratchpad / Messages 三分层（Scratchpad 随 system 注入，不被裁剪） | agent.test.ts / agent.ts 代码 |
| F-3 | Context trimming：保留 system + 最后 user + 按轮裁剪中间块 | context.ts / longchain-mixed |
| F-4 | runId 只由 Runtime 注入，LLM 不可见不可控（Schema 无 + args 不覆盖） | tool-contract.test.ts |
| F-5 | Tool 执行编排：read/idempotent 自动 Retry（MAX_RETRY=2），non_idempotent 零重试 | agent.ts:292 / recover-flaky-retry |
| F-6 | Result Validation：execute 成功 vs 结果有效正交（invalid 不进 completedSteps） | agent.ts:330-373 / recover-invalid-chain |
| F-7 | Dead-loop 防护：同 tool+input 失败超限 / 已 invalid → isBlocked 禁调 | scratchpad.ts / agent.test.ts |
| F-8 | Tool Effect Contract：read / idempotent / non_idempotent 三类 + 注册校验 | tools.ts:39-50 / tool-contract.test.ts |
| F-9 | non_idempotent 必须显式 getOperationKey，禁止 fallback JSON.stringify | tools.ts:100-108 / tool-contract.test.ts |
| F-10 | Operation Identity 命名空间隔离（toolName::canonicalKey） | side-effect.ts:18-23 / operation-identity.test.ts |
| F-11 | Side-Effect Safety 三态：executing / succeeded / uncertain + 生命周期 | side-effect.ts / operation-replay.test.ts |
| F-12 | non_idempotent execute 前持久化 executing（persist 失败禁止执行） | agent.ts:281-290 |
| F-13 | succeeded 同 key 去重回放，不重跑副作用 | side-effect.ts:95-97 / se-diff-keys / se-resume-phase2 |
| F-14 | executing/uncertain 不盲目重放，返回 uncertain 说明 | side-effect.ts:98-100 / se-flaky-retry-dedup |
| F-15 | Checkpoint/Resume 最小 JSON 持久化（7 字段 + sideEffects） | checkpoint.ts / longchain-resume |
| F-16 | Tool Output Guard 16KB per-result（UTF-8 安全截断） | output-guard.ts / output-guard.test.ts |
| F-17 | validate 看 raw result，后续 Runtime 统一用 guarded result | agent.ts:301-315 / diag-large-700k |
| F-18 | Sandbox 两层路径校验：字符串级 + realpath 级（防 ../ / 绝对 / symlink） | sandbox-manager.ts / sandbox-manager.test.ts |
| F-19 | Cleanup 只删单 runId 段目录，禁止删集合级以上 | sandbox-manager.ts:143-163 / sandbox-manager.test.ts |
| F-20 | Trace 12 类结构化事件（side-effect / output-truncated 等关键路径有埋点） | trace.ts / 压测日志 |

### ⚠️ 已知边界（设计取舍，非 Bug，Freeze 内暂不改）

| # | 边界 | 说明 |
|---|---|---|
| B-1 | `MAX_ITERATIONS=10` 硬预算 | 长链任务单次运行必触顶；resume 不延长预算。如需更长任务在 Harness 层切分+编排多次 resume。 |
| B-2 | `MAX_CONTEXT_TOKENS=4000` 粗略字符数估计 | 非精确 token，不做 tiktoken 级别分词；Provider 级限制在上游 LLM 服务处理。 |
| B-3 | 无 Tool 执行超时机制 | 工具可无限阻塞；需要时在 Harness 层用 AbortController 包装。 |
| B-4 | at-most-once oriented safety，非 exactly-once | 不确定态绝不自动重试；确定态才回放。exactly-once 需要 Tool 支持幂等 token，不在 Kernel 承诺范围。 |
| B-5 | Tool Output Guard 仅一次性截断（前 6KB + 标记 + 后 4KB） | 不分页 / 不偏移 / 不流式 / 不按 LLM token 预算动态调整。 |
| B-6 | 只提供只读文件工具（listDir / readFile） | writeFile / deleteFile / shell 明确不提供。需要时作为 Harness 扩展重新评估契约与安全边界。 |
| B-7 | 单模型 / 单 Provider（一组环境变量） | 无多模型路由、缓存、重试降级，属于 Harness。 |
| B-8 | 单 runId 命名空间（非多租户） | 无用户 ACL、跨 run 隔离策略，属于 Harness/平台层。 |
| B-9 | Trace 仅内存对象 + stdout，不持久化 | 日志保留依赖调用方（压测 `.stress-logs/` 是 runner 自己做的）。持久化 Trace 属于 Harness。 |

### 🚧 明确留给下一阶段（Harness / Extension，不进 Kernel Freeze）

| # | 能力 | 归属层 |
|---|---|---|
| H-1 | Memory / RAG / 跨 Run 长期记忆 | Harness |
| H-2 | Planner / Task Decomposition / Sub-agent 编排 | Harness |
| H-3 | Reviewer / Self-Critique / Verifier 回路 | Harness |
| H-4 | Model Adapter / Multi-Provider 路由 / 缓存 / Fallback | Harness |
| H-5 | Skills 框架 / Tool Registry 动态加载 / MCP 协议桥接 | Extension |
| H-6 | Prompt 模板系统 / System Prompt 配置化 | Harness |
| H-7 | 写入类宿主能力（writeFile / appendFile / mkdir / shell） | Extension（需重新评估 effect contract） |
| H-8 | Tool 执行超时 / 取消 / 并发控制包装 | Harness |
| H-9 | 长链任务自动切分 + 多轮 resume 编排（突破 MAX_ITERATIONS） | Harness |
| H-10 | API Server / Web UI / 用户鉴权 / Multi-Tenant | Platform / Harness |
| H-11 | Trace 持久化 + 聚合查询 + 指标监控面板 | Platform |
| H-12 | Checkpoint 后端升级（DB / 云端存储 / 版本化） | Platform / Harness |
| H-13 | exactly-once Tool（事务回滚 / 幂等 token 协议） | Extension + Tool Contract 扩展 |
| H-14 | 分页 / 流式 / 分块 Tool Output 协议 | Extension（在 Output Guard 之上加能力） |
