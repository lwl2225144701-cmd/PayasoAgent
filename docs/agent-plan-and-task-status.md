# Agent 自计划与任务状态（Plan / Task Status）

> 目标：Agent 在多步任务里**自己列计划**，前端实时看到"要做什么 / 做到哪 / 还剩什么"，每完成一项状态即时更新。
>
> 状态：**P0 已实现（v2.2）** —— 见 §10 实现记录；P1/P2 见 §8。三道契约在 §3，落地时必须同步的文档契约块在 §9。
>
> 分层前提：**计划全部落在 Harness 层，Agent Loop 只做接线与发事件**（见 §2）。

***

## 1. 一句话方案

模型通过一个新工具 `updatePlan` **全量提交**任务清单 → **Harness** 持有计划状态、做校验/归一化/有界投影，并随 `ContextHarnessState` 一起进 checkpoint → 计划变化时由 **Runtime** 发一条 `plan_update` trace 事件（携带完整清单）→ Host 照既有链路落库 + SSE 下发 → 前端从事件派生清单，渲染在输入栏上方（只属于最新一轮 Run，见 §5）。

三个核心取舍：

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 更新语义 | **全量替换**，不做增量 patch | 前端零合并逻辑；天然幂等、可重放，SSE 重连与快照回放自动收敛 |
| 状态存储 | **事件溯源 + Harness 状态**，不给 `runs` 表加列 | 无需 DB 迁移；刷新页面 / Host 重启后从 events 表复原；`run-reconcile` 的编译期护栏不受影响 |
| 与 Scratchpad 的关系 | **分家**，各自独立 | scratchpad 是"工具执行账本"（v1.10 刚瘦身为纯行为信号），plan 是"给用户看的承诺清单"；语义与生命周期不同，混在一起会让每轮注入重新膨胀 |

***

## 2. 分层归位：为什么全部放 Harness

计划的三件事——"模型看到什么"、"跨压缩要活下来什么"、"什么算收尾"——正好是 Harness 已经拥有的三件事（`buildModelView`、`ContextHarnessState`、`emptyTurnPolicy`/`incompleteTurnPolicy`）。所以内核里不该出现 `plan` 变量。

| 职责 | 归属 | 落点 |
| --- | --- | --- |
| 数据模型 / 校验 / 归一化（≤12 项、单一 `in_progress`、id 归一） | **Harness** | `src/harness/plan.ts`（纯函数，无 IO） |
| 计划状态与持久化 | **Harness** | `ContextHarnessState.plan` → 随 checkpoint 的 `harnessState` 一起存（`normalizeContextHarnessState` 兼容旧数据） |
| 注入模型（有界投影 ≤300 token）+ 预算计量 | **Harness** | `buildModelView` 追加 plan 段；`prepareTurn` 返回 `planTokens` |
| "何时建计划 / 何时更新"的引导语 | **Harness** | `harness/instructions.ts` 新增 segment |
| 未完成计划的收尾策略（P2，可选） | **Harness policy** | 与 `incompleteTurnPolicy` 同族的钩子，例如 `planPolicy()` |
| 模型写入口 | **Harness 暴露、Runtime 装饰后接线** | `AgentContextHarness.planPort?()`；Runtime 拿到后包一层（changed → emit + save）再放进 `toolContext` |
| `plan_update` trace 事件 | **Runtime** | `apply()` 返回 `{ changed, resultText }`，Runtime 在 `changed` 时 `emit` + `save`（**事件只有一个出口**） |
| 工具调用管线 / 副作用 / schema 校验 | **Runtime**（既有） | `updatePlan` 是薄适配层，业务语义全在 Harness |

这样切带来的四个直接好处：

1. **`prepareTurn` 签名不变**（计划在 Harness 内部，不再是入参）→ 不波及 `tests/context.test.ts` 的既有调用点。
2. **`CheckpointSnapshot` 不加字段**：计划搭 `harnessState` 的既有车，`Checkpoint/Resume` 逻辑零改动。
3. **可替换**：换 Harness 实现（或测试用 fake）即换掉整套计划行为，内核不用动 —— 与 `emptyTurnPolicy` 的既有可替换性一致。
4. **策略有地方放**：将来若要"计划没做完就别收尾"，它是 Harness policy 的自然扩展，不会变成内核硬约束。

边界（同样重要）：

* Harness **不碰 trace**：不发事件、不 import `trace.ts`。变更结果以返回值交回 Runtime。
* Runtime **不做计划语义**：不校验项数、不归一化状态、不渲染清单，只做"接线 + 发事件 + 存 checkpoint"。
* `planPort` 是**可选**接口方法（与既有 `shouldStopAfterTurn?` / `refreshToolchain?` 同风格）：fake Harness 不实现也不影响编译；Runtime 拿不到 port 时工具 fail-closed 报错，不静默成功。

***

## 3. 三道契约（改这三处，测试才会绿）

### 3.1 工具契约：`updatePlan`

```json
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "description": "本次提交的完整清单（全量替换，不是增量）",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "description": "可选；沿用上次的 id 可稳定更新同一项" },
          "title": { "type": "string" },
          "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
        },
        "required": ["title", "status"]
      }
    }
  },
  "required": ["items"]
}
```

* `effect: 'idempotent'`（只改 Run 内部状态，不动外部世界）→ 不进副作用 replay 分支，无需 `getOperationKey`
* 上限：**≤12 项**、`title ≤160` 字符、同一时刻**至多 1 项 `in_progress`**（多项时最后一项生效，其余回落 `pending`，并在返回文本里说明）
* 超限 → **结构化错误**（写清上限与实际值），绝不静默截断或静默丢弃
* `items: []` = 明确清空计划（前端隐藏面板）
* 返回文本：渲染当前清单（`[计划] 2/5 完成` + 每项一行）——模型下一轮直接看到自己的计划，不依赖 system 注入
* 注册位置：`src/tools/plan-tools.ts`（新文件；已在 `runtime-bootstrap.ts` 与 `tests/docs-contract.test.ts` 接线）。
  刻意不放进 `builtin-tools.ts` —— 那里是演示工具（calculator/getWeather），核心能力不该混进去

### 3.2 事件契约：`plan_update`

| 字段 | 说明 |
| --- | --- |
| `revision` | 单调递增；同 revision 不重复发（无变化不发事件） |
| `items[]` | 全量清单（`id` / `title` / `status`） |
| `completed` / `total` | 便于 UI 与将来统计，不要求前端二次计算 |

尺寸：12 项 × 160 字符 ≈ 2KB，远低于 16KB 的工具/事件输出预算。

### 3.3 注入契约（模型不失忆）

* 有界投影：`renderBoundedPlanView(plan)` → **≤300 token**（最多 12 行，标题裁剪 80 字符，超出标注省略数）
* 注入位置：Harness 内部与 scratchpad 投影并列，追加到 system 末尾（`buildModelView`）
* 计量：`PreparedModelTurn` 增 `planTokens`（与 `scratchpadTokens` 并列）；`context_usage` 增**可选**字段 `planTokens`（旧事件无该字段，前端忽略即可；`docs-contract` 只锁事件类型名，不锁字段）

***

## 4. 后端改动（文件级）

| 文件 | 改动 |
| --- | --- |
| `src/harness/plan.ts`（新） | `PlanItemStatus` / `PlanItem` / `Plan`；`createPlan()`、`applyPlan(plan, items)`（校验 + id 归一化 + 单 `in_progress` 收敛 + `revision++`，**无变化返回原引用**）、`renderPlanResult()`、`renderBoundedPlanView()`、`normalizePlan()`（旧数据容错）。纯函数、无 IO |
| `src/harness/context-state.ts` | `ContextHarnessState.plan?: Plan` + `normalizeContextHarnessState` 容错（旧 checkpoint 无该字段 → 空计划） |
| `src/harness/context-harness.ts` | `DefaultContextHarness` 持有 plan；`buildModelView` 追加 plan 段；`PreparedModelTurn.planTokens`；**接口新增可选** `planPort?(): PlanPort`。`prepareTurn` 签名不变 |
| `src/harness/instructions.ts` | 新增 `planningSystemPrompt()` segment（软引导，见下） |
| `src/runtime/agent.ts` | **只加接线**：`toolContext.planPort` = Runtime 装饰过的 Harness port（changed 时 `emit` + `save`）。不持有 plan、不做计划语义 |
| `src/runtime/trace.ts` | 新增 `plan_update` 事件 |
| `src/tools/tools.ts` | `ToolContext.planPort?`（Runtime 注入，LLM 不可见、不可传） |
| `src/tools/plan-tools.ts`（新） | 注册 `updatePlan`：薄适配层（schema 已由 `tool-arguments.ts` 校验 → 调 port → 返回 Harness 渲染的文本） |
| `src/bootstrap/runtime-bootstrap.ts` + `tests/docs-contract.test.ts` | 各加一行 import 触发工具注册 |

关键骨架：

```ts
// harness/context-harness.ts —— 计划状态与语义都在这里
planPort(): PlanPort {
  return {
    apply: (items) => {
      const next = applyPlan(this.plan, items);          // 校验 + 归一化 + revision++
      if (next === this.plan) return { changed: false, resultText: renderPlanResult(this.plan) };
      this.plan = next;
      return { changed: true, plan: this.plan, resultText: renderPlanResult(this.plan) };
    },
  };
}
```

```ts
// runtime/agent.ts —— 只有接线、事件与落盘；计划语义仍全在 Harness
const planPort = contextHarness.planPort?.();     // fake Harness 不实现 → undefined（工具 fail-closed）
const toolContext = {
  /* ...既有 runId / workspaceRoot / approvalPort / toolchain... */
  planPort: planPort && {
    // 装饰一层：Harness 出语义，Runtime 出事件，工具只拿到字符串
    apply: (items) => {
      const applied = planPort.apply(items);
      if (applied.changed) {
        emit({
          type: 'plan_update',
          revision: applied.plan.revision,
          items: applied.plan.items,
          completed: countCompleted(applied.plan),
          total: applied.plan.items.length,
        });
        // 不额外 save()：工具成功后紧接着就有一次 checkpoint（含 harnessState）。
      }
      return applied.resultText;
    },
  },
};
```

> 为什么用"Runtime 装饰一层"而不是让工具回传结构化结果：`ToolResult` 只有 `string | ToolMultimodalResult`，且 `normalizeToolResult` 会把额外字段丢掉（`agent.ts`）——扩它会污染整条工具结果链路（trace / messages / guard）。装饰写法让 **Harness 出语义、Runtime 出事件、工具只拿到字符串**，三边都不越界，也不需要给 `ToolResult` 加变体。

软引导语（`planningSystemPrompt()`，约 5 行，避免长 prompt）：

1. 任务需要 ≥3 个步骤或多次工具调用时，**先建计划再动手**；单步任务不要建（多一次调用是浪费）
2. 开始一项 → `in_progress`，做完 → `completed`，**每项状态变化立刻更新**（用户在看进度）
3. 同时最多一项 `in_progress`；计划会演化，允许改标题/加项/删项
4. 标题写给用户看（"跑通 runtime-boundary 套件"），不写工具参数细节

***

## 5. 前端改动（文件级）

| 文件 | 改动 |
| --- | --- |
| `web/src/api.ts` | `eventTypes` 白名单加 `plan_update`（漏了 = 事件被浏览器**静默丢弃**，`frontend-sse-contract` 会红） |
| `web/src/types.ts` | `PlanUpdateEvent`（trace 事件的前端镜像） |
| `web/src/components/Timeline/plan-state.ts`（新） | `derivePlan(events): PlanView \| null`：取 **`revision` 最大**的一条（不是数组最后一条 —— 对 SSE 重连/乱序回放幂等）；无事件 → `null`。纯函数，与 `context-gauge.ts` / `preparation-retry.ts` 同风格，可确定性测试 |
| `web/src/components/Timeline/PlanPanel.tsx` + `.module.css`（新） | 清单面板：`计划 2/5` + 细进度条 + 每项 ✅ / ● / ○；运行中展开、终态折叠为一行摘要；`memo` 包裹；`<ol aria-live="polite">`，状态用图标 + 文案而非仅颜色 |
| `web/src/components/Timeline/index.tsx` | 只做派生与上抛：`derivePlan(events)` → `onPlan?.(plan)`（与 `onContextUsage` 同一模式），**不再在对话流里渲染面板** |
| `web/src/App.tsx` | 只在**最新一轮 Run** 上接 `onPlan`（`run.runId === latestSessionRunId && !pendingRun`），把计划渲染到输入栏上方；新一轮开始与切换会话时清空 |
| `web/src/components/InputBar/index.tsx` + `.module.css` | `headerSlot` 插槽：渲染在 `.conversationComposer` 上方，宽度同为 `min(860px, 100%)` 保证左右对齐 |

文档流顺序（面板已移出对话流）：

```
用户气泡
  → 执行过程（ExecutionPanel，可折叠；内部仍有"计划已建立/✅ 完成：…"变更说明行）
  → 最终结果
──────────────────────────────
[当前计划]  ← 输入栏上方，只属于最新一轮 Run
输入框
```

**计划面板的定位（v1.11 调整，取代原"用户气泡下方"方案）**：
计划是**会话级临时状态**，不是历史回合的组成部分——面板只做"当前目标"的实时指示，
展示在输入栏上方（`InputBar` 的 `headerSlot`），并在下一轮消息发出时立即清空。
历史痕迹不丢：每轮执行流里的弱化变更说明行（`derivePlanNotes`：`计划已建立 · N 项`、
`✅ 完成：…（2/3）`）仍然逐轮保留，且 `plan_update` 事件本身完整落库。
原方案"每个历史回合各带一份计划面板"因此被取代：同一份会话级计划在多个历史回合里
重复渲染，越往下滚动越像"过期副本"，而面板要回答的是"现在做到哪了"。

***

## 6. 与既有不变量的关系

| 不变量 | 影响 |
| --- | --- |
| 空回合必须有可见产出 | **不受影响**：`updatePlan` 是正常 tool_call，该回合不算空回合 |
| Finalization guard | **P0 不接入**：计划未完成**不**强制阻止收尾（误伤"先给结论/只要分析"的任务）。P2 若要加，落点是 Harness `planPolicy()`，不是内核 |
| Side-Effect Safety | `idempotent` → 不走 `resolveOperation`/replay；不触碰文件系统 |
| 防死循环 | 复用 `isBlocked`：同参数反复失败会被禁调 |
| 工具输出预算 | 返回文本 ≤1KB；事件 ≈2KB |
| Checkpoint / Resume | 计划随 `ContextHarnessState` 进 checkpoint（`harnessState` 既有通道），`normalizeContextHarnessState` 兼容旧数据；Host 重启续跑计划与 UI 都不丢 |
| Context Compaction | plan 走 system 注入（≤300 token），不依赖 transcript，压缩不掉 |
| Tool Schema 安全边界 | LLM 不能传 runId / 时间戳等 Runtime 字段；计划 id 由模型给，归一化在 Harness |
| Trace 契约 | `docs-contract` + `frontend-sse-contract` 强制同步；漏改就红 |
| Harness 可替换性 | `planPort?` 为可选方法，fake Harness 不实现仍能编译；Runtime 无 plan 语义 → 换 Harness 即换行为 |

***

## 7. 边界与明确不做

* **不强制**模型必须建计划（简单任务多一次工具调用是纯开销），只做软引导
* 不做跨 Run 的"会话级计划"：一个 Run 一份，随回合展示
* 不做计划项与工具调用的自动关联（P2 可考虑按标题关键字视觉呼应）
* 状态只保留 3 个（`pending` / `in_progress` / `completed`）；`cancelled` / `blocked` 等有真实需求再加
* 不把计划写进 `runs` 表、不新增会话级接口（事件 + Harness 状态足够复原）
* 不让 Harness 发 trace、不让 Runtime 做计划语义（§2 边界）

***

## 8. 落地阶段与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0 核心闭环** ✅ 已实现 | `harness/plan.ts` + `updatePlan` + `plan_update` + 注入 + `PlanPanel` + 契约同步 + 4 个套件（见 §10） | `npm run test:all` 全绿；mock 闭环套件覆盖 工具→事件→注入→resume→fail-closed |
| **P1 体验** ✅ 已随 P0 落地 | 终态折叠（`userToggled ?? running`）+ 进度条 + `planTokens` 计量 + `workflow.plan` 引导语 | 面板 `memo`，事件引用由既有 `mergeStreamingEvents`/`reconcileRuns` 保证稳定，不引起 Timeline 每秒重算 |
| **P2 打磨** | 计划与执行步骤的视觉呼应、PAYASO.md 引导模板、可选的 Harness `planPolicy()` | 无回归；旧会话（无 plan 事件）零变化 |

新增确定性套件（登记进 `tests/run-all.ts`，并同步 README / architecture 的套件数）：

* `tests/plan-state.test.ts`：全量替换语义、id 复用与去重、单 `in_progress` 归一化、上限报错、`revision` 单调、清空、`normalizePlan` 旧数据容错
* `tests/plan-view.test.ts`：有界投影（项数 / 标题裁剪 / token 预算 / 省略标注）
* `tests/frontend-plan-state.test.ts`：`derivePlan`（无事件 → `null`、多条取最大 revision、乱序回放幂等、字段缺失容错）
* `tests/plan-loop.test.ts`：mock LLM 驱动的完整闭环（工具 → 状态 → 事件 → 下一轮注入 → 越界报错 → 无 `planPort` 时 fail-closed）

分层护栏已落地（比原建议更强，因此没有再动 `tests/context.test.ts`）：`plan-view.test.ts` 用 `satisfies AgentContextHarness`
做**编译期**护栏（`planPort` 若变必填即编译失败），`plan-loop.test.ts` 用只转发、不实现 `planPort` 的 Harness 做**运行期** fail-closed 断言。

既有契约套件会自动兜住剩下的同步点：`docs-contract`（工具/事件清单）、`frontend-sse-contract`（前端白名单）。

***

## 9. 落地时必须同步的文档与清单

* `docs/architecture-current.md` §3.3 两个机器契约 JSON 块：tools 加 `updatePlan`、events 加 `plan_update`（**不改就红**）
* 同文件 §4.1 Agent Loop 流程图（标注"计划由 Harness 持有"）、§4.2 三层状态表补 plan 一行
* `README.md`：工具集清单加 `updatePlan`；测试命令表的套件数同步
* `PAYASO.md`（若采纳 P2 引导模板）

***

***

## 10. 实现记录（P0，v2.2）

落地的文件与本方案的差异（实现即契约，方案已同步修正）：

| 项 | 实际实现 |
| --- | --- |
| 计划状态机 | `src/harness/plan.ts`（`createPlan` / `applyPlan` / `renderPlanResult` / `renderBoundedPlanView` / `normalizePlan`） |
| 持久化 | `ContextHarnessState.plan` + `normalizeContextHarnessState` 容错；**未**改 `CheckpointSnapshot` |
| 注入口 | `DefaultContextHarness.planViewText()`（窗口 0.5%，夹 128–300 token）→ `buildModelView` 的 `systemPromptText() + planText + scratchpadText + summary`；`prepareTurn` 签名未变，新增 `planTokens` |
| 写入口 | `AgentContextHarness.planPort?()`（可选）+ `ToolContext.planPort`（工具只见文本）；Runtime 在 `agent.ts` 装饰一层，`changed` 时发 `plan_update` |
| 工具 | `src/tools/plan-tools.ts` 的 `updatePlan`（`effect: idempotent`，≤12 项 / 标题 ≤160 字符 / 单一 `in_progress`） |
| 事件 | `trace.ts` 的 `plan_update`（revision + 全量 items + completed/total）；`context_usage` 增可选 `planTokens` |
| 前端 | `web/src/types.ts`、`api.ts` 白名单、`Timeline/plan-state.ts`（`derivePlan` 取最大 revision）、`Timeline/PlanPanel.tsx` + CSS；由 `Timeline` 上抛、`App` 渲染在输入栏上方（`InputBar` 的 `headerSlot`） |
| 测试 | `plan-state`(16) / `plan-view`(9) / `plan-loop`(8) / `frontend-plan-state`(8) 四个套件，均已登记进 `tests/run-all.ts`（68 套件） |

与方案的差异（有意为之）：

* 工具放在独立的 `src/tools/plan-tools.ts`，没有塞进演示工具文件 `builtin-tools.ts`。
* 装饰层里**没有**再调 `save()`：工具成功后紧接着的既有 checkpoint 已包含 `harnessState.plan`，重复写会增加一次快照落盘。
* 多了一个方案外的 `tests/plan-loop.test.ts`：mock LLM 驱动的真实 Loop 闭环，是"计划真的能跑通"的唯一非人工证据。
* `tests/helpers/mock-runner.ts` 增加了可选 `observer`（复用既有 `silentRuntimeObserver`），让新套件的输出从 61KB 降到 <1KB。

P2（同批落地）：

* **视觉呼应**：`Timeline/plan-state.ts` 的 `derivePlanNotes` 按 revision 顺序 diff 相邻计划，
  在**发生变更的那个 step** 上落一行弱化说明（`✅ 完成：X · ▶ 开始：Y（2/3）`、`计划已建立 · 3 项`、
  `计划已清空`），由 `ExecutionPanel` 的 `planNote` 渲染（与既有 `compactionNote` 同款机制）。
* **收尾审计**：`harness/plan.ts` 的 `buildPlanReport()` + `AgentContextHarness.planReport?()`；
  Runtime 在发 `final_answer` 之前若有未完成项则发 `plan_incomplete_at_finish`（只留痕，不阻断）；
  面板终态也会折叠为「结束时仍有 N 项未完成」。
* **引导模板**：`PAYASO.md` 增加「任务计划（多步任务）」一节（多步才建、完成即重发全量清单、
  标题写给用户看、计划可演化）。

真实模型烟雾（`npm run cli`，MiniMax-M3，2026-09-10）：

* 模型按引导**主动调用** `updatePlan`，发出 `plan_update`（revision 1，3 项，第一项 `in_progress`），工具返回文本正确回灌；
* 计划**真的落进了 checkpoint**：`harnessState.plan = { revision: 1, items: [列 docs 目录结构 / 统计 .md 数量 / 汇总] }`；
* 当时的"跑不完"是另一条既有 bug（MiniMax-M3 分片 tool_call 的空串 id 覆盖，见下一段），已在本批次修掉。

修掉适配器 bug 后的真实闭环（同一探针，MiniMax-M3）：

* `tool_call_invalid` 13 → **0**，7 次成功工具调用；
* 计划真实推进：`updatePlan` 依次发出 revision 1→4，进度 `0/3 → 1/3 → 2/3 → 3/3` 全部完成；
* 收尾审计也验了两条路径：计划做完（3/3）→ 不发事件；明确不执行（0/3）→ 发
  `plan_incomplete_at_finish` 且落在 `final_answer` 之前，Run 仍正常 completed。

***

## 11. 剩余工作（P2 及以后）

| 项 | 内容 | 状态 |
| --- | --- | --- |
| P2-1 视觉呼应 | 计划变更按 step 落在执行流里（`derivePlanNotes` → `planNote` 弱化说明行） | ✅ 已实现（见下） |
| P2-2 引导模板 | `PAYASO.md` 增加「任务计划（多步任务）」一节 | ✅ 已实现 |
| P2-3 收尾审计 | Harness `planReport()` + Runtime `plan_incomplete_at_finish` 事件（只留痕，不阻断） | ✅ 已实现 |
| 未做・明确不做 | `cancelled` / `blocked` 状态、跨 Run 的会话级计划 | 有真实需求再加 |
| 未做（有意） | 把"计划没做完"变成硬约束（阻断收尾 / 强制恢复） | 会误伤"先给结论、只要分析"的任务；已按审计事件留痕，需要时再加有界提醒 |
| 未做（有意） | 计划项与工具调用的**自动连线** | 事件里没有对应关系，自动连线只能靠猜 —— 改成"按 step 落变更说明"，宁缺勿错 |
| 验收缺口 | 浏览器里看真实 run 的面板（像素与交互） | 阻塞已解除（MiniMax-M3 的工具调用已修：`tool_call_invalid` 13 → 0，计划 0/3 → 3/3 真实跑通）。剩下的是**目视验收**：面板代码、事件流、派生状态都有确定性测试与真实数据，但还没在 GUI 里看过一眼 —— 发一个多步任务即可确认 |

***
