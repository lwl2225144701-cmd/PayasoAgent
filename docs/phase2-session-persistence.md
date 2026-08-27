# PayasoAgent Phase 2 — Session / Run Persistence

> 当前实现说明；Runtime Kernel 未修改。

## 数据位置与职责

- 默认数据库：`~/.payaso/payaso.db`
- 可通过 `PAYASO_DB_PATH` 覆盖（主要用于测试/隔离运行）。
- SQLite 保存产品历史：Run metadata、Workspace 绑定、结果/错误和 Host/Trace events。
- `.checkpoints/<runId>.json` 继续只保存 Runtime 恢复现场；Checkpoint 内容不写入 SQLite。

## Schema

`runs`：`run_id/task/status/workspace_root/workspace_name/created_at/updated_at/result/error`。

`events`：`id/run_id/seq/type/timestamp/payload`；`UNIQUE(run_id, seq)`，按 `seq` 重放。

## 生命周期

创建 Run 时先插入 SQLite，再启动 Agent。Runtime `onTrace` 事件先 append SQLite，成功后再 SSE 广播。完成、失败、停止同步更新 `runs`。

Host 启动时，数据库中遗留的 `running` Run 被标记为 `interrupted` 并追加 `run_interrupted` 事件；不会自动 Resume。用户通过 Web“继续运行”或 `POST /runs/:id/resume` 显式恢复。

Resume 同时校验 SQLite 与 Checkpoint 的 `workspaceRoot`；不一致时拒绝恢复，且永不使用当前 Workspace 覆盖历史绑定。

## Web

`GET /runs` 从 SQLite 加载历史。`GET /runs/:id/events` 先按序回放 SQLite 历史，再为活跃 Run 推送后续 SSE；SSE 重连支持 `Last-Event-ID`。历史 Run API 只返回 `workspace.name`，不返回绝对路径。
