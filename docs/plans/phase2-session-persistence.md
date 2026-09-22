# PayasoAgent Phase 2 — Session / Run Persistence

> 当前实现说明；Session 连续对话与流式输出已在后续增量中补齐。Agent Loop、Tool、Side-Effect 与 Recovery 语义未改变。

## 数据位置与职责

- 默认数据库：`~/.payaso/payaso.db`
- 可通过 `PAYASO_DB_PATH` 覆盖（主要用于测试/隔离运行）。
- SQLite 保存产品历史：Run metadata、Workspace 绑定、结果/错误和 Host/Trace events。
- `.checkpoints/<runId>.json` 继续只保存 Runtime 恢复现场；Checkpoint 内容不写入 SQLite。

## Schema

`sessions`：`session_id/title/workspace_root/workspace_name/created_at/updated_at`。

`runs`：`run_id/session_id/turn_index/task/status/workspace_root/workspace_name/created_at/updated_at/result/error`。

旧版 Run-only 数据库启动时按“一 Run 一 Session”确定性迁移，不猜测旧 Run 之间的对话关系。

`events`：`id/run_id/seq/type/timestamp/payload`；`UNIQUE(run_id, seq)`，按 `seq` 重放。

## 生命周期

创建 Run 时先插入 SQLite，再启动 Agent。Runtime `onTrace` 事件先 append SQLite，成功后再 SSE 广播。完成、失败、停止同步更新 `runs`。

Session 内每次追问创建新的 Run。Host 从同 Session 已结束 Run 的 `task + result/失败摘要` 构造有预算的 `conversationHistory`；不继承 reasoning、Trace、Scratchpad 或 Side-Effect 现场。Session 创建时固定 Workspace，之后 currentWorkspace 不会覆盖它。

Host 启动时，数据库中遗留的 `running` Run 被标记为 `interrupted` 并追加 `run_interrupted` 事件；不会自动 Resume。用户通过 Web“继续运行”或 `POST /runs/:id/resume` 显式恢复。

Resume 同时校验 SQLite 与 Checkpoint 的 `workspaceRoot`；不一致时拒绝恢复，且永不使用当前 Workspace 覆盖历史绑定。

## Web

`GET /sessions` 加载会话，`GET/POST /sessions/:id/runs` 加载轮次或继续追问。Web 按 Session 顺序渲染多个 Run。

模型默认使用 OpenAI-compatible SSE。`assistant_delta/reasoning_delta` 经 Host 约 60ms 合并后写入 SQLite 并推送 Web；Tool Call 分片必须完整组装并通过 JSON 校验后才允许 Runtime 执行。前端使用 SSE `lastEventId`（SQLite seq）去重，不再使用不唯一的 `step + type`。

`GET /runs/:id/events` 先按序回放 SQLite 历史，再为活跃 Run 推送后续 SSE；重连支持 `Last-Event-ID`。所有历史 API 只返回 `workspace.name`，不返回绝对路径。
