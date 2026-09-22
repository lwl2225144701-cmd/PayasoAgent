# 长任务与超时处理方案

## 目标

- 正常长任务不再因运行超过 15 分钟失败。
- 超时由发生阻塞的具体层负责，不由 Agent Loop 统一计时。
- 长命令进入后台任务系统，不阻塞模型回合。
- 不增加前端“继续运行”入口。

## 目标结构

```text
Agent Loop                     不设置固定总超时
├── LLM                       连接超时 + 流空闲超时
├── 普通工具                   工具级 deadline，返回 TOOL_TIMEOUT
├── Shell 前台                 有界超时，超时后终止进程树
└── Background Job            独立长任务，无普通执行超时
    ├── Session 级所有权
    ├── 并发与输出上限
    ├── 增量输出
    ├── 有界 wait
    ├── 完成通知
    └── 显式 kill / Session 删除 / Host 关闭清理
```

## 核心改造

### 1. 统一超时原语

新增共享超时模块，提供：

- `deadline()`：组合上游取消与本层超时。
- `clampTimeout()`：校验默认值和最大值。
- `idleWatchdog()`：流式空闲计时，收到数据后续期。
- `timeoutOf()`：识别具体超时来源。

### 2. 分层处理超时

- LLM 使用连接超时和流空闲看门狗，持续输出时不超时。
- 普通工具声明自己的超时预算，超时返回结构化 `TOOL_TIMEOUT`。
- Shell 保留当前硬终止进程树机制。
- Agent Loop 删除固定 15 分钟总时限。

### 3. 升级后台任务

将现有 Background Job 从 Run 级改为 Session 级：

- 后台执行不使用普通 Shell 超时。
- 不随单个 Run 结束而销毁。
- 支持增量读取输出和完成通知。
- `wait` 保持有界；等待超时只返回 `running`。
- 用户显式 kill、Session 删除或 Host 关闭时统一清理。

### 4. 防失控边界

- 后台任务并发限制。
- 输出大小限制。
- Agent 重复工具调用保护。
- 完成通知连续唤醒次数上限。
- LLM、普通工具和前台 Shell 各自保留超时。
- 用户停止和 Host 关闭继续传播取消信号。

## 实施顺序

1. 新增共享超时模块及单元测试。
2. 将 LLM 改为连接超时 + 流空闲超时。
3. 在 `ToolInvocationProcessManager` 接入工具级结构化超时。
4. 将 Background Job 升级为 Session 级所有权。
5. 增加增量输出、完成通知和唤醒上限。
6. 删除 Host 固定 15 分钟 Run 超时。
7. 更新架构文档和回归测试。

## 验收标准

- 活跃 Run 超过 15 分钟仍可正常执行。
- LLM 无数据、工具卡死和 Shell 卡死能在各自边界内终止。
- Background Job 不因当前 Run 结束被误杀。
- Background Job 完成后 Agent 能收到通知并读取结果。
- `wait` 到期返回 `running`，不作为工具失败。
- Session 删除和 Host 关闭后不存在孤儿进程。
- 不新增前端恢复或“继续运行”交互。

## 实施状态（2026-02 已按本方案落地）

| 步骤 | 落地 | 代码/测试 |
|---|---|---|
| 1. 共享超时原语 | ✅ `deadline()/clampTimeoutMs()/idleWatchdog()/timeoutOf()` | `src/util/timeout.ts` + `tests/timeout-primitives.test.ts` |
| 2. LLM 连接+空闲看门狗 | ✅ 移除单请求总时限；`PAYASO_LLM_CONNECT_TIMEOUT_MS`（默认 30s）/ `PAYASO_LLM_IDLE_TIMEOUT_MS`（默认 120s），持续输出不断流不超时，超时不重试 | `src/llm/llm.ts` + `tests/llm.test.ts`（25 例） |
| 3. 工具级 TOOL_TIMEOUT | ✅ Tool 声明 `timeoutMs`（缺省 `PAYASO_TOOL_TIMEOUT_MS` 默认 5 分钟），ProcessManager 以 deadline 包裹 execute；到期返回结构化 `TOOL_TIMEOUT`（不重试、非业务失败、副作用不确定置 `uncertain`）；trace `tool_error` 带 `timeout:'tool'` | `src/runtime/tool-invocation/process-manager.ts` / `state-machine.ts` + `tests/tool-timeout.test.ts` |
| 4. Background Job → Session 级 | ✅ 注册表按 sessionId 索引；Run 终态不再回收；`shellJob` 跨 Run 可见；清理时机 = 显式 kill / Session 删除 / Host 关闭；用户停止仍经父信号传播取消 | `src/sandbox/background-jobs.ts` + `src/tools/runtime-tools.ts` + `src/host/{session-service,run-manager,run-lifecycle-service}` |
| 5. 增量输出/完成通知/唤醒上限 | ✅ 执行器 `onOutput` 滚动缓冲 + `offset` 增量读取（shellJob output 支持）；settle 入会话通知队列（有界 64）；Agent Loop 迭代边界/收尾竞态注入通知，连续唤醒上限 3（真实进展后重置） | `tests/background-jobs.test.ts` + `tests/job-notification.test.ts` |
| 6. 删除 Host 15 分钟总时限 | ✅ 移除 `AGENT_RUN_TIMEOUT_MS` 保险丝与 `abortReason:'timeout'` 路径；挂死请求由 LLM/工具层边界兜底 | `src/host/run-lifecycle-service.ts` + `tests/host-timeout.test.ts`（连接超时语义 + 旧保险丝失效回归：超过其值的 Run 正常 completed） |
| 7. 文档与回归 | ✅ architecture-current / .env.example / README / run-all 注册 3 个新套件（87 套件全绿） | `docs/architecture-current.md`、`web/src/{api,types}.ts`（新增事件类型）、`tests/background-jobs.test.ts`（含 Session 删除/Host 关闭回收联动） |

**相对原方案的落地偏差（均符合"超时由阻塞层负责"的目标）**：
- LLM 空闲看门狗起于尝试创建时（prefill 首 token 等待计入空闲窗口），收到任一 stream event 即续期。
- 工具级 deadline 对 shell 按"大于其内部命令级超时上限 + 30s 裕量"声明，避免吞掉 `[shell-timeout]` 结构化结果；外层只兜底执行器自身卡死。
- 完成通知的"连续唤醒上限"在模型做出真实进展（执行工具调用）后重置；通知不随 Run 结束丢弃，留在会话队列供后续 Run 消费。
- 看门狗/deadline 定时器故意不 `unref()`：保证即使事件循环内没有其他 keep-alive 句柄，超时保护也必然触发。
