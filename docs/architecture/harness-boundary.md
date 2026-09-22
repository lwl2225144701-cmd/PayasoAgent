# Runtime / Harness / Host 职责边界

当前已进入 Context Compaction V1：引入可恢复的增量 conversation summary，但不引入长期 Memory、RAG 或会话树系统。

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Host | Workspace、Session/Run、模型与权限授权、持久化、API | 拼接模型上下文、执行 Tool Loop |
| Harness | system/权限指令、conversation history 投影、Scratchpad 模型视图、Tool Schema 与 token 预算、模型响应清理 | 执行工具、重试副作用、保存产品状态 |
| Runtime | Agent Loop、工具调用、重试与 Recovery、Side-Effect Safety、取消、执行状态、决定何时提交恢复快照和发布观测信号 | 决定模型看到哪些历史、模型上下文窗口配置、选择持久化介质或日志输出方式 |
| Bootstrap | 注册具体 Tool、创建旧 Sandbox fallback、canonicalize Workspace Root、组装执行上下文、持久化适配器与 Observer | Agent 决策、上下文投影、产品持久化 |

## 当前调用关系

```text
Host 选择 Workspace / Model / Permission
  ↓ Bootstrap 生成 AgentExecutionContext、注册本地 Tool、注入 CheckpointWriter / RuntimeObserver
  ↓
Runtime 持有完整 transcript 与执行状态
  ↓ 每轮 prepareTurn
Harness 生成临时 model view
  ├─ base system + permission
  ├─ bounded Scratchpad view
  ├─ conversation summary
  ├─ recent complete rounds
  └─ 当前 user turn
  ↓
LLM → Runtime Tool Loop
```

`Runtime` 决定 checkpoint 的提交时机和快照内容，并只调用 `CheckpointWriter` 端口；默认本地适配器负责 `.checkpoints` 路径、JSON 编码与 tmp + rename 原子写。Harness 的预算裁剪与摘要只影响当轮请求，不反向覆盖 canonical transcript。摘要状态作为 `harnessState` 随 checkpoint 恢复，不修改 Runtime 的 Tool、Side-Effect、Recovery 或 Cancellation 语义。

Runtime 的诊断输出只调用 `RuntimeObserver`。默认 Console Observer 位于 `src/observability/`；Host 的结构化 Trace/SSE 仍走 `onTrace`。Observer 收到的是隔离快照，且其异常会被吞并，不得通过修改对象或抛错改变执行、checkpoint 或副作用安全结果。

## 第一阶段文件归属

- `src/harness/context-harness.ts`：Runtime 使用的上下文端口及默认实现
- `src/harness/context-manager.ts`：模型消息预算与完整历史轮裁剪
- `src/harness/model-context.ts`：模型窗口、输出预留、安全预留与 token 估算
- `src/harness/instructions.ts`：基础与权限指令
- `src/harness/scratchpad-view.ts`：Runtime Scratchpad 到模型文本的投影
- `src/harness/context-state.ts`：可恢复的 summary 与已摘要消息计数
- `src/harness/conversation-summarizer.ts`：旧完整轮的增量结构化摘要
- `src/runtime/agent.ts`：仅调用 Harness，不再自行拼接或裁剪模型上下文
- `src/bootstrap/runtime-bootstrap.ts`：具体 Tool 与 Workspace 执行上下文的装配入口
- `src/runtime/contracts.ts`：Runtime 消费的最小 `AgentExecutionContext` 契约
- `src/runtime/checkpoint-port.ts`：Runtime 消费的快照与 `CheckpointWriter` 端口，不含文件系统实现
- `src/persistence/file-checkpoint-store.ts`：默认本地 JSON checkpoint 适配器及 resume 读取能力
- `src/runtime/observer-port.ts`：Runtime 诊断观察端口及异常隔离
- `src/observability/console-runtime-observer.ts`：CLI/本地默认控制台渲染器

Runtime 只接受已经授权的 `runId + workspaceRoot + permissionMode`，以及显式注入的 `CheckpointWriter` 和 `RuntimeObserver`。它不会自行选择目录、创建真实 Workspace、canonicalize 用户路径、注册 File/Shell Tool、决定 checkpoint 文件位置或直接写 stdout；checkpoint resume 与执行上下文不一致时会在 LLM/Tool 执行前 fail closed。non-idempotent 工具执行前的 `executing` 快照若提交失败，工具仍然禁止执行。
