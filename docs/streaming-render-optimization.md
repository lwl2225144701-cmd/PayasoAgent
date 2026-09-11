# 流式回复渲染性能优化方案（实施蓝图）

> 状态：定稿，可实施。本文档是只读审计结论 + 改造蓝图的合并版本。
> 审计方式：静态代码证据 + /tmp 真实解析栈微基准（未改任何项目文件）。

## 1. 背景与诊断

**应用**：PayasoAgent —— 基于 DeepSeek Harness 的 Agent 会话前端，Web 端 React 18.3.1（`web/`），模型流式回复经 SSE 推送。

**流式链路四环节**：
1. **SSE 入口**：`web/src/api.ts:310-318`，每 chunk `JSON.parse` → `onEvent`
2. **进入状态**：`web/src/hooks/useEventStream.ts:56-70`，pending 队列 + 16ms 合帧后 `setEvents`
3. **流向组件**：`web/src/components/Timeline/index.tsx:264-268`，每回合一个 Timeline，`structure = useMemo(buildStructure, [run, events])`
4. **Markdown 渲染**：`web/src/components/CollapsibleText.tsx:62-82`（streaming 分支）每次渲染整条 `ReactMarkdown` 全量 parse

**结论**：瓶颈在渲染链路，精确位置是「每 16ms 一次 commit × 每次 commit 对整条累计消息全量 react-markdown re-parse」。
- 合帧（Host `src/host/run-manager.ts:1596-1623` + Web `useEventStream.ts:65-70`）只控制 **commit 次数**（上限 ≈62/s），不控制**单次 commit 的工作量**。
- react-markdown@10 每次渲染 `createProcessor` + `runSync(parse)`，无内部缓存（`web/node_modules/react-markdown/lib/index.js:178`）。
- 实测（/tmp 微基准，真实解析栈 react-markdown@10 + remark-gfm@4 + react-dom `renderToStaticMarkup`）：

| 累计消息长度 | 单次 parse→hast→vdom | 按 60 次/s 折算 |
|---|---|---|
| 8 KB | 9.3 ms | ~56% 单核 |
| 16 KB | 20.8 ms | ~125%（超一帧预算） |
| 32 KB | 46.5 ms | ~279% |

**措辞边界**（重要）：
- 渲染审计能排除的：①「每个 SSE chunk 直接触发一次渲染」；②「合帧缺失导致掉帧」。
- **不能**排除的：SSE chunk 到达均匀性、模型首 token 延迟、上游 prefill 慢、网络间歇停顿。这些是独立变量，需单独测量（现成埋点：`llm_call_started` 事件 + `Timeline/index.tsx:109/129` 首 token 等待秒数）。
- 20.8ms 是特定机器/特定内容的样本，且不含 DOM layout/paint；「优化后降到安全线」是**目标**，需真实 Performance 录制验证。

## 2. 问题清单（按严重程度）

| # | 严重度 | 位置 | 现象 |
|---|---|---|---|
| P0 | 🔴 | `CollapsibleText.tsx:62-82` + `react-markdown/lib/index.js:178` | 每次 commit 全量 re-parse 整条消息；无 memo，同文本重渲也全额付费。16KB 超帧预算 |
| P1 | 🟠 | `Timeline/index.tsx:283-286` | 流式期间 1.2s tick 强制整棵 Timeline 重渲（驱动执行时长/阶段文案/首 token 秒数，不能删，需下沉） |
| P2 | 🟠 | `useEventStream.ts:65-70` | setTimeout(16) 非 rAF、无背压，与帧边界不对齐 |
| P3 | 🟡 | `Timeline/index.tsx:253` + `App.tsx:916` | 无 memo → App 级重渲时全部历史回合重渲；无虚拟化，长会话 DOM 常驻 |
| P4 | 🟡 | `Timeline/index.tsx:776-957` | buildStructure/join/stripThinkTags 每 commit 全量派生（比 parse 低 1-2 个数量级，非主因） |

## 3. 改造方案（7 条，按优先级）

### ① 流式期间纯文本，settled 后一次 parse 【最大收益】
- `CollapsibleText.tsx:62-82`：streaming 分支从 `ReactMarkdown` 换成 `<div style="white-space:pre-wrap; overflow-wrap:anywhere">`（不用 `<pre>`，避免长代码行横向溢出）。
- settled 分支保持完整 Markdown 解析（每次 parse 一次）。
- Mermaid / 代码增强：fence 完整或 Run 结束后处理（复用 `normalizeFences`，`CollapsibleText.tsx:12-24` 判断闭合）。
- ⚠️ `useMemo(<Markdown>,[text])` 只对 settled/同文本有效，救不了流式（text 每帧变化）。

### ② 增量 store：streamed + publishedSnapshot + metadata 【地基】
- 新建 `web/src/hooks/stream-store.ts`，`useSyncExternalStore` 形态：

```ts
interface MessageSnapshot { text: string; /* …元数据 */ }
interface StreamSnapshot { version: number; messages: ReadonlyMap<string, MessageSnapshot>; }

interface StreamStore {
  append(event: HostEvent): void;                 // O(1) 入队，绝不在 append 里触发渲染
  subscribe(listener: () => void): () => void;
  getSnapshot(): StreamSnapshot;                  // 必须返回缓存引用，不能每次新建（否则死循环）
}
```

- 按 messageId 维护：`streamed` **永远累积、绝不丢 delta**（丢「你」最终答案会变「好」）；`publishedSnapshot` 每帧只发布最新全文快照（只丢中间发布快照，不丢内容）。
- 历史消息对象引用稳定，只替换活跃消息（现状 `mergeStreamingEvents` 每批 `existing.slice()` 新建根数组，`stream-state.ts:15`，全部失效）。
- **按 key 订阅**：`useStreamMessage(runId, messageId)` 内部 `subscribeKey` + `getSnapshot` 返回缓存引用；`changedKeys` 只做 store 内部通知优化，不作为组件层接口。
- **metadata 必须保留非流式事件**：tool / terminal / approval / context usage 等不能被 message store 遗漏，否则破坏现有 Timeline 的工具/终态展示。

### ③ 拆活跃消息组件
- `Timeline/index.tsx:253` 是聚合式组件，没有真正 MessageList。最小拆法（不必重做消息架构）：

```
RunTimeline
├── ExecutionStatus      （memo）
├── ToolSteps            （memo，已完成步骤引用稳定）
├── StreamingAnswer      （单独更新，订阅 store 活跃 messageId）
└── SettledAnswer        （memo，props 快照引用稳定）
```

### ④ 加 memo
- `Timeline` / `SettledAnswer` / `ToolSteps` / `ExecutionStatus` 包 `React.memo`。
- ⚠️ 浅比较会失效：App 每次 `refreshRuns` 产生全新 run 对象（`App.tsx:161` `setRuns(runResp.runs)`）→ 自定义 comparator，覆盖**所有实际影响渲染的字段**（`runId/status/updatedAt/task/result/error/workspace` 相关字段 + 回调 props），不能只比 3 个字段。
- ⚠️ memo 挡不住组件自身 setState（`CollapsibleText.tsx:46` 的 open state、Timeline 的 tick）。「成本归零」改为「props 与引用稳定时基本跳过」。

### ⑤ rAF 发布 + 背压 【时序卫生，非 CPU 修复】
- `useEventStream.ts:65-70`：`setTimeout(16)` → 可见时 `requestAnimationFrame`；**后台标签页 rAF 会被暂停** → `document.visibilityState` 隐藏时回退低频 `setTimeout`（Chrome 对 chained setTimeout 同样节流到 ~1s）。
- 背压 = 只丢**中间发布快照**，绝不丢 delta 内容。
- 终态事件跳过 rAF **立即 flush**。

### ⑥ 1.2s tick 下沉
- 不能删除：它驱动执行时长（`Timeline/index.tsx:121/124-126`）、阶段文案「正在思考/正在分析」（`:128`）、首 token 等待秒数（`:109/129`），注释见 `:283`。
- 把计时器移进 ExecutionPanel，并**把 `modelWait` 数据与秒数计算拆开**（否则父级仍会因 `Date.now()` 相关计算更新，下沉失效）。

### ⑦ 长会话虚拟化 【最后做】
- `App.tsx:916` 全量渲染当前会话全部 Run；涉及动态高度/自动滚动（`useConversationScroll`）/活跃 Run 保活，复杂度高、收益在长会话。
- 它**不解决**当前一条 16KB 消息的 parse（那是 ① 的事），所以排最后。

## 4. 实测验证（2026-09-09，真实流式 + CDP Tracing）

用 headless Chrome CDP 对**改造前后**各跑真实流式（同任务、直接回复、不调工具），录制主线程
`ThreadControllerImpl::RunTask`，并拼出真实 markdown 源做解析基准：

**对照 run 参数**（几乎相同负载）：

| | 改造后 | 改造前 |
|---|---|---|
| 流式时长 | 200s | 219s |
| 最终文本 | 17.1KB / 8062 字符 | 17.0KB / 8249 字符 |
| output tokens | 11K | 11.5K |
| 解码速度 | 85 tok/s | 89.5 tok/s |
| SSE delta 事件数 | 965（≈4.8/s） | 935（≈4.3/s） |

**主线程 RunTask 统计**：

| 指标 | 改造后 | 改造前 |
|---|---|---|
| 任务数 | 70,284 | 37,233 |
| 平均耗时 | 0.4ms | 0.4ms |
| >16ms 任务 | **16** | **2** |
| >50ms 任务 | **2** | **0** |

**真实语料解析基准**（Node，同一栈 react-markdown@10 + remark-gfm@4，17KB 真实流式文本）：
完整渲染 **5.72ms/次**；按 commit 率推算主线程占用：@5/s → 3%、@16/s → 9%、@30/s → 17%、@62/s → 35%。

### 实测带来的三个重要修正

1. **真实 commit 率远低于"每帧一次"**：commit 率 = min(SSE 事件率, 62/s)，由模型输出速度决定。
   测试模型 ~90 tok/s → Host 每 ~200ms 推一个 chunk → **~5 commit/s**，而非微基准假设的 60/s。
   旧代码在慢模型 + 普通长度回复下 parse 成本被摊薄到主线程 ~3%，**实测不卡**（>16ms 任务仅 2 个）。
2. **真实语料 parse 比人工语料便宜**：17KB 真实 markdown = 5.72ms，而人工"重语料"（密集代码块/列表）
   16KB ≈ 20.8ms——旧报告中的"16KB=20.8ms→必卡"是**最坏情况语料**，不代表典型回复。
3. **旧代码的卡顿风险是条件性的**：在快模型（高 commit 率趋近 62/s）/ 超长回复 / 回放（live=0 快速推送）
   场景下，渲染成本 35%+（未计 React reconcile/layout，实际更高）→ 掉帧。用户报告的"一卡一卡"
   大概率来自这些场景（更快模型或更长回复），而非本次测试的慢模型场景。

**结论**：改造把每 commit 的解析成本从 O(累计文本) 结构性降为 O(增量)纯文本——在任何 commit 率下
都无 parse、无掉帧风险；本次测试虽未复现旧代码的严重卡顿（慢模型场景），但改造消除了该风险的存在
条件，且实测改造后 200s 流式无长任务、平均任务 0.4ms。**微基准的"125% 单核"应作为最坏情况上限
而非典型值引用。**

## 5. 预期与验证

- ①②③ 组合：每 commit 从"全量 markdown parse"降为"纯文本增量渲染"，任何 commit 率/文本长度下
  主线程任务均为亚毫秒级（实测平均 0.4ms）。
- ⚠️ 微基准数字（16KB=20.8ms 等）是人工重语料的最坏情况；真实语料便宜约 3.6 倍（5.72ms @17KB）。
- 真实录制方法已建立（headless Chrome CDP + Tracing + SSE 回放拼源），可复跑。

## 6. 一句话总结

①③ 消卡顿（结构性消除每 commit 的 O(文本) parse），② 是地基（谁变了才重建谁），④ 对齐帧边界
（rAF）、⑤⑥ 收尾，⑦ 留给长会话；不碰 SSE 网络接收与 Host 侧（Host 16ms 合帧已是文档化设计，
`docs/architecture-current.md:269`）。实测修正：慢模型下旧代码亦流畅，快模型/长回复/回放场景才是
旧代码的卡顿区间，改造已在该区间结构性生效。

---

## 7. 后续修正（反转 §3① 的「流式纯文本」）

> 背景：§3① 把流式分支降级为 `pre-wrap` 纯文本，用「牺牲实时 Markdown」换掉每帧 O(累计文本)
> 的解析。这个取舍在实测中确认有效，但**代价是用户能看见的**：流式期间 `**加粗**`、列表、
> 代码块全部以原始符号显示，直到整轮结束才「啪」地变成排版后的样子。用户明确要求恢复实时渲染。
>
> 这次修正不再回到「每帧全量解析」，而是把解析成本从 O(累计文本) 降为 O(尾部)。

### 做法：按「已定型块 + 尾部」分块

核心观察：**Markdown 的块级结构一旦被空行终止就不会再变** —— 后续追加只会形成新块，不会回头
改写已终止的块。于是把累计文本切成：

- `blocks`：已定型块（空行终止、且不在 fence 内）→ 交给 `memo` 化的渲染器，文本不变则解析被**整个跳过**；
- `tail`：仍在写入的当前块 → 每帧重解析，成本只与这一段有关；
- `openFence`：尾部停在未闭合 fenced code 内时的源码 → 按纯代码渲染，**绝不交给 Markdown 解析器**。

第三个字段是必需的：若把未闭合 fence 交给解析器，`normalizeFences` 会补上闭合标记，把一个
「流到一半的 mermaid」当成完整图表交给 `MermaidBlock` —— 必然语法报错并闪烁错误提示。

实现：`web/src/components/streaming-markdown.ts`（纯函数，单趟字符扫描、无正则）+
`StreamingMarkdown`（`MarkdownText.tsx`）。所有块共用**同一个** `.markdownBody` 容器：若每块各套
一层，`> :first-child{margin-top:0}` / `> :last-child{margin-bottom:0}` 会对每块生效，段间距会被吃光。
共用容器还让流式与终态的 DOM 结构一致，定型瞬间不重排。

### 实测（真实语料 + 项目自身解析栈 react-markdown@10 + remark-gfm@4）

模拟流式按实测 delta 粒度（18 字符/帧）逐帧追加。A = 每帧全量解析（§3① 之前的老做法），
C = 本次分块增量。百分数是「单帧解析耗时应占单核的比例」，按 5 commit/s（实测真实速率）
与 62 commit/s（rAF 合帧的理论上限）分别折算：

| 场景 | 帧数 | A 每帧 | C 每帧 | 耗时改善 | @5/s | @62/s |
|---|---|---|---|---|---|---|
| 真实语料 8404 字符（DB 里最长的 final_answer） | 467 | 2.47 ms | **0.13 ms** | **19.5x** | 0.1% | 0.8% |
| 稠密 Markdown 4279 字符（有空行） | 237 | 4.36 ms | 0.19 ms | 23.4x | 0.1% | 1.2% |
| 超长代码块 15306 字符（未闭合 → 走 openFence） | 850 | 0.77 ms | 0.01 ms | 109.1x | 0.0% | 0.1% |
| 单段正文 12500 字符（**无空行**） | 694 | 0.91 ms | 0.91 ms | 1.0x ❌ | 0.5% | 5.6% |
| 大表格 10369 字符（**无空行**） | 576 | 12.49 ms | 12.38 ms | **1.0x** ❌ | 6.2% | **76.8%** ⚠️ |

真实语料那行的「每帧解析字符总量」为 1,967,002 → 63,087，**降 96.8%**（仅此项统计了字符量）。

### 诚实的边界：有一类内容分不掉

**不含空行的超长块无法分块**——GFM 表格是最现实的例子：表格内部没有空行，定型前它整体都是
尾部，只能每帧整段重解析。上表最后一行显示：10KB 表格 12.4 ms/帧，改善仅 **1.0x**（等于没优化），
在 62 commit/s 的理论上限下会吃掉 76.8% 单核。这正是 §1 里"16KB 重语料 20.8ms"的同一类场景。

因此 `StreamingMarkdown` 给尾部长度设了硬上界 `TAIL_PARSE_LIMIT = 6000`：超限的尾部退化为纯文本，
等它被空行定型后再按 Markdown 渲染。**这把无界风险变回有界**，代价是病态巨型单块在流式期间
短暂以源码显示。正常回复的单块远小于该阈值（代码块另有 `openFence` 通道，根本不参与解析）。

### 与 §3① 的取舍对比

| | §3① 流式纯文本 | 本次分块增量 |
|---|---|---|
| 流式期间 Markdown | ❌ 全是原始符号 | ✅ 实时（仅超长单块降级） |
| 每帧解析成本 | 0 | O(尾部)，且 ≤ 6000 字符硬上界 |
| 每帧额外成本 | 0 | 一次 O(全文) 字符扫描（无正则/无解析） |
| 未闭合 mermaid | 不渲染（纯文本） | 源码渲染，frame 完整后渲染图表 |
| 实测单帧（真实语料） | 0 | 0.13 ms |

### 仍未验证

- 没有做真实浏览器渲染录制：上表是 Node 侧 `renderToStaticMarkup` 的解析成本，
  **不含 React reconcile / DOM layout / paint**。分块带来的额外 DOM 节点（每块一个 memo 组件）
  的实际开销需要用 Performance trace 确认。
- `TAIL_PARSE_LIMIT` 的阈值是按解析密度反推的，没有在真实「巨型表格」回复上验证过降级观感。
