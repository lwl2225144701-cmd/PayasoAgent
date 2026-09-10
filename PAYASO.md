# PAYASO.md — 本仓库的 Agent 约定

> 本文件会随 Run 自动注入（`workspace-write` / `full-access` 权限下）。目标：把"先跑最省的验证"和"别重复跑全量"变成默认动作。

## 验证命令（本机量级，先跑最省的再跑全量）

| 目的 | 命令 | 量级 |
| --- | --- | --- |
| 单个确定性套件（定位问题） | `node --import tsx tests/<suite>.test.ts` | ~1s |
| 全量确定性套件（无 LLM，68 个） | `npm run test:all` | ~17s（有界并发） |
| 类型检查 | `npx tsc --noEmit` | ~2s |
| 前端生产构建 | `npm run build:web` | ~5s |
| 需 LLM：Host 集成 / E2E / 压测 26 场景 | `npm run test:host` / `npm test` / `npm run test:stress` | 分钟级 |

## 跑测试的纪律（省时间，也省 context）

1. 先用**单个套件**定位失败，再用 `npm run test:all` 确认；不要为了换一个 `tail`/`grep` 切片重复跑同一条长命令。
2. `npm run test:all` 会把每个套件的完整输出写入 `.payaso/logs/run-all-*.log`，并在输出末尾打印**结论行 + 失败清单 + 日志路径 + 单个套件的重跑命令**：复查失败直接 read/grep 日志，不必重跑整轮。
3. 分钟级命令走 `shell` 的 `background=true` + `shellJob wait`，不要把长命令塞进前台阻塞调用。
4. 过滤长输出前确认关键行不会被切掉（`tail`/`grep` 最容易丢掉汇总顶部的失败行）；结论行在各命令输出的最末尾。
5. 并发是可调的：`PAYASO_TEST_CONCURRENCY=8 npm run test:all`（默认 `min(6, CPU)`）。

## 代码约定

- **单一来源**：工具输出预算与切片统一走 `src/tool-output-budget.ts`，不要另写一套截断/头尾保留逻辑。
- **契约同步**：新增/删除工具或 Trace 事件必须同步 `docs/architecture-current.md` §3.3 的机器契约块，否则 `docs-contract` 套件红。
- **注释与文档用中文**，风格与相邻文件保持一致（模块头写清"为什么存在"与契约）。
- **提交前**：`npx tsc --noEmit` + `npm run test:all`；出现 FAIL 先单独重跑该套件，确认是不是本轮改动引入的。
