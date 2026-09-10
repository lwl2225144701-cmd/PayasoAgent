# 会话展示流畅度审计（第二轮：长会话路径）

> **实施状态：§3 的问题已按 §7 的批次 1–4 全部落地，见 §8（含「主动不做」的三项及理由、
> 已验证 / 仍未验证清单）。§1–§7 保留审计当时的原始论证，其中 §3.3 含一处勘误。**
>
> 审计对象：PayasoAgent Web 前端（`web/`，React 18.3.1）会话展示链路。
> 方法与边界：纯静态代码证据 + 真实持久化数据（`.data/payaso.db`，只读）+ 真实语料解析微基准。
> **未修改任何源码**（本文档除外）。
> 前置文档：`docs/streaming-render-optimization.md`（第一轮，已实施于 commit `dba4101`）。

---

## 0. 一句话结论

第一轮已把「**单条活跃消息的逐帧 markdown 全量解析**」结构性消除（已落地、有效）。
本轮审计的结论是：**剩下的卡点不在流式逐帧，而在「一个会话里 N 个历史回合的挂载方式」**——
每个历史回合各自开一条 SSE 并全量回放、Vite/Host 侧 HTTP/1.1 只有 6 条并发连接、
每个 mermaid 图挂载即串行渲染、以及 `React.memo` 因 props 身份每次刷新都变而**全线失效**。

典型场景：打开一个 25 回合、含 11 个 mermaid 图的会话（本期真实数据）——
会产生 25 条 SSE 请求 / 1.6 MB 事件回放 / 11 次串行 mermaid 渲染 / 25 次 Timeline 挂载。

---

## 1. 与第一轮优化的边界（先排除法）

| 环节 | 现状 | 判定 |
|---|---|---|
| SSE 入口 `web/src/api.ts` | 每 chunk `JSON.parse` → `onEvent` | 正常，非瓶颈 |
| 合帧 `useEventStream.ts:86-95` | rAF 对齐帧边界 + 隐藏页 250ms 回退 | 已实施，正确 |
| 增量文本 `useEventStream.ts:69-75` | 独立 `streamedText`，非 delta 帧不触引用 | 已实施，正确 |
| 流式纯文本 `CollapsibleText.tsx:62-67` | 流式期间 `<div pre-wrap>`，不 parse | 已实施，正确 |
| 时钟下沉 `Timeline/index.tsx:120-130` | 1s tick 只在 ExecutionPanel 内 | 已实施，正确 |
| App 级轮询 | **不存在**（无 `setInterval` 拉 `/runs`） | 无问题 |
| Host 16ms 合帧 | `src/host/run-manager.ts` | 无问题，不必动 |
| 滚动条动画 | `useConversationScroll` 直接设 `scrollTop`，无 smooth | 方向正确（见 D） |

**结论**：流式单帧路径已经干净。本轮全部问题集中在「多回合会话的挂载 / 身份 / 首次渲染」。

---

## 2. 实测数据（`.data/payaso.db` 只读查询）

库规模：**120 runs / 57 sessions / 37,392 events / 26 MB**。

### 2.1 单会话事件量（最重的 5 个）

| session | runs | events | payload |
|---|---|---|---|
| `722feaac…` | **25** | **5,392** | **1.61 MB** |
| `5d4e72e4…` | 6 | 5,262 | 1.37 MB |
| `0e80c32b…` | 5 | 4,264 | 1.20 MB |
| `ab3e28e2…` | 1 | 3,778 | 0.75 MB |
| `34e0f7bf…` | 5 | 2,869 | 0.80 MB |

单 run 最大：**3,778 events / 749 KB**（一个回合）。

### 2.2 事件体积构成（全库）

| type | 条数 | 总字节 |
|---|---|---|
| `reasoning_delta` | 19,861 | 3.79 MB |
| `assistant_delta` | 14,414 | 2.70 MB |
| `scratchpad_update` | 440 | 1.17 MB |
| `tool_result` | 440 | 1.16 MB |
| `llm_call` | 346 | 0.59 MB |

> 注：客户端 `mergeStreamingEvents`（`stream-state.ts:15-35`）会把**相邻同 messageId 的 delta 合并成一个事件**，
> 所以前端 `events` 数组远小于 DB 里的 delta 条数。这不是问题，反而是有效保护。

### 2.3 终端事件完整性（验证一条假设，结果：假设不成立）

假设「历史 run 缺少终端事件 → `useEventStream` 不 close → SSE 永久挂住 → 占满 6 条连接池」。
**数据否证**：

| status | 数量 | 对应终端事件 | 数量 |
|---|---|---|---|
| completed | 74 | `run_completed` | 74 |
| failed | 10 | `run_failed` | 10 |
| interrupted | 31 | `run_interrupted` | 31 |
| stopped | 5 | `run_stopped` | 5 |

**120/120 run 恰好各有一条终端事件，零缺失。** 所以当前数据下不会永久泄漏连接。
风险是**瞬时连接风暴**（6 条并发上限 + 排队），不是死锁 —— 但仍应修，理由见 §3.1。

### 2.4 真实会话语料 markdown 解析基准

取会话 `722feaac…` 的 20 条 `final_answer`（40,741 字符，28 个代码块），
用项目自身栈（`react-markdown@10` + `remark-gfm@4` + `react-dom/server.renderToStaticMarkup`）测量：

| 指标 | 值 |
|---|---|
| 整会话 20 条全量 parse | **35.71 ms** |
| 单条平均 | 1.79 ms |
| 单位成本 | 0.877 µs/char |

**判定**：一次性 35.7 ms ≈ 2 帧，可接受，**不是主因**。
且 `CollapsibleText` 是 `memo` 且 `text` 是字符串（按值比较）→
历史答案在后续重渲中**不会重新 parse**。这一点很重要，它把 §3.3 的后果限制住了。

---

## 3. 问题清单（按严重度）

### 3.1 🔴 P0 — 每个历史回合各开一条 SSE，会话打开 = 连接风暴 + 全量回放

**证据链**：

1. `web/src/components/Timeline/index.tsx:277` —— `useEventStream(run.runId, true, …)` 在**每个** Timeline 实例内调用。
2. `web/src/App.tsx:942` —— `displayedSessionRuns.map(...)` 渲染**该会话全部 run**，无窗口化、无虚拟化。
3. `src/host/routes.ts:403` —— `const live = …get('live') !== '0'`，默认 `true`。
4. `src/host/run-manager.ts:1469` —— `subscribe()` 先 `for (const item of this.store.listEvents(runId))` **同步回放全部历史**，
   然后 `set.add(sink)` 把 sink 留在订阅表里，直到收到终端事件（或 Host 关闭）。
5. `src/host/server.ts:5,16` —— `node:http`，**HTTP/1.1**。SSE 占用同源 6 连接上限。

**后果**：打开 `722feaac…`（25 runs）→ 一次性发起 25 条 EventSource →
浏览器按 6 条并发排队 → 每条串行回放该 run 的全量事件（合计 **5,392 events / 1.61 MB**）→
每条 `JSON.parse` + `mergeStreamingEvents` + `setEvents` → 25 次 Timeline 挂载与重渲。
**每次切走再切回都会重来一遍**（Timeline 重新挂载 → `useEffect` 重建连接）。

**为什么必须修**：
- 已完成 run 的事件是**只读、不可变**的，用「长连接 + 回放 + 等终端事件再关」来取是过度设计，
  代价是一个 HTTP 连接 + 一次订阅表登记 + EventSource 重连逻辑。
- 6 条并发上限意味着**最多 6 条历史连接会挤占正在流式的 live run 的连接**。
  这正是「切换会话/打开长会话时，正在跑的回合显示卡住不动」的成因。

### 3.2 🔴 P0 — Mermaid 挂载即渲染，无 IntersectionObserver

**证据**：

- `web/src/components/MermaidBlock/index.tsx:167` —— 渲染 effect 在**挂载时立即**执行（deps 含 `chart/fontSize/themeTick/stackWideChart`），未做可见性判断。
- `web/src/components/MermaidBlock/index.tsx:120-126` —— `enqueueRender` 全局**串行链**，所有图排队渲染，永不同时跑。
- 全仓库 `web/src` **没有任何 `IntersectionObserver`**（已 grep 确认）。

**后果**：`722feaac…` 含 **11 个 mermaid 图（5,025 字符）**。打开会话 →
11 次 `mermaid.render` **串行**执行，**包括视口外、用户根本看不到的图**。
mermaid.render 单次成本远高于 markdown parse（含 dagre 布局 + DOM 度量 + `getBBox`），
且 `mermaid` 主包 ~1 MB（`web/dist/assets/` 里 `architectureDiagram-*` 单 chunk 即 151 KB）。

**诚实标注**：本轮**没有**实测到单次 mermaid.render 的毫秒数——本机未安装 Playwright 浏览器，
未做浏览器内测量。**这是高置信度推断，不是实测结论**，验收时必须按 §5 的配方实测确认。
但「视口外也渲染」是代码事实，与成本高低无关：**这是纯粹的浪费，应当消除**。

### 3.3 🟠 P1 — `React.memo` 全线失效：run 对象与回调身份每次刷新都变

**证据**：

1. `web/src/App.tsx:164` —— `setRuns(runResp.runs)`，`/runs` 每次返回全新 JSON 对象，身份全变。
2. `web/src/App.tsx:340-346` —— `currentSessionRuns` / `displayedSessionRuns` 派生时 `filter().sort()`，**每次 render 新数组**。
3. `web/src/components/Timeline/index.tsx:265` —— `memo(function Timeline(...))`，**默认浅比较，无自定义 comparator**。
4. `web/src/App.tsx:943-953` —— 传入 `run={run}` + `onRetryCommand={handleCreateRun}`。
5. `web/src/App.tsx:298` —— `currentModelSelection` 是**每次 render 重建的对象字面量**，
   而它是 `createRunNow` 的 useCallback 依赖（`App.tsx:492-533`），于是连环传染：
   `currentModelSelection` → `createRunNow` → `handleCreateRun` → `onRetryCommand`。
   **单这一条就足以在每次 App render 时击穿 Timeline 的 memo**，与 `run` 身份无关。

> 📌 **勘误（本文档初版写错，此处更正）**：初版称 `handleCreateRun` 的依赖数组含 `latestSessionRun`。
> 事实上含它的是 `handleSendQueuedNow`（`App.tsx:534-560`），`handleCreateRun` 的依赖是
> `[createRunNow, sendQueue.length, sessionBusy]`。结论（memo 全线失效）不变，但**成因不同**：
> 真正的传染源是 `currentModelSelection` 的对象字面量，而不是 run 对象直接进回调依赖。

**触发点**（每回合至少 2 次，长会话下每次都是全体重渲）：
`App.tsx:525`（创建后）、`App.tsx:562-564`（终态对账）、`App.tsx:702 / 713`（停止 / 恢复）、`App.tsx:564`（打开会话）。

**后果**：**每次回合边界都会重渲会话内全部历史 Timeline**，并重建其 `buildStructure`。
`memo` 在此完全不起作用（不是「挡不住自身 setState」，是**根本没进入 bail-out 分支**）。

**缓解事实**（避免高估）：`CollapsibleText` 是 `memo` + `text: string`（按值比较）→
历史答案不会重新 parse markdown。`ToolActionRow` 的 `JSON.stringify(args, null, 2)`（`:103`）
在 `open &&` 之内，默认收起，无额外成本。所以后果是「重渲 + 结构重建」，不是「重解析」。

### 3.4 🟠 P1 — 流式每帧仍有 O(累计文本) 重算：`buildStructure` 里的 `stripThinkTags`

**证据**：

- `web/src/components/Timeline/index.tsx:351-354` —— `structure = useMemo(buildStructure, [run, events, rawFinalAnswer, finalParsed])`。
  流式中 `events` 与 `rawFinalAnswer` **每帧都变** → 每帧全量重建。
- `web/src/components/Timeline/index.tsx:893-894` —— 在 step 循环内对**每一个历史 `llm_call`** 执行
  `stripThinkTags(llm.response ?? '')` 与 `stripThinkTags(llm.reasoning ?? '')`。
- `web/src/format.ts:44-65` —— `stripThinkTags` 是 2 趟全局正则 + 1 次 `match` + 1 趟 `replace`，
  **O(全串)**，并且中途有 `[...]`/`trim()` 分配。
- `web/src/components/Timeline/index.tsx:878-881` —— `globalThinkingAcc` 每帧对全部 `reasoning_delta`
  做 `filter().map().join('')`，O(累计 reasoning 文本)。

**关键点**：`llm_call` 事件一旦写入就**不可变**，其 `stripThinkTags` 结果每帧重算是**纯浪费**。
全库 `llm_call` 共 346 条 / 0.59 MB；单个重回合里有几十条不成问题，
但对**边流式边积累工具步骤**的回合，每帧的重算量随回合推进单调增长。

> 这是第一轮文档 §2 的 P4 项，被列为「非主因」——同意其不改变数量级，
> 但它是**每帧稳定存在的 O(文本) 项**，且修法廉价（WeakMap 缓存），故升到 P1。

### 3.5 🟡 P2 — 滚动跟随在 paint 之后修正，天然差一帧

**证据**：`web/src/hooks/useConversationScroll.ts:28-34`

```
observer = new ResizeObserver(() => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(follow);   // follow: scroller.scrollTop = scroller.scrollHeight
});
observer.observe(content); observer.observe(scroller);
```

**问题**：内容增长 → ResizeObserver 回调（**paint 之后**）→ 排到**下一帧** rAF 才 `scrollTop = scrollHeight`。
也就是说新增的那一行**先被画在视口下方**，下一帧才被拉回视口内。
高帧率流式下这表现为末行「蠕动 / 抖动」，而不是严丝合缝地跟随。

**次要问题**：

- 容器没有设 `overflow-anchor: none`。流式时图片（附件 `loading="lazy"`、工具预览图）
  和 mermaid 图异步撑高时，浏览器滚动锚定会与程序化 `scrollTop` 相互拉扯。
- `App.tsx:742` 的 `scrollIntoView({ behavior: 'smooth' })` 与流式期间的自动跟随
  **同时生效时会互相打断**（`followingRef` 只在 `sessionId`/`sentRunId` 变化时重置，
  `currentRunId` 变化不在其中）。点击历史回合 mark 时若正在流式，会出现滚动回弹。

**正确方向**：流式文本这一路应当用 `useLayoutEffect`（DOM 变更后、**paint 前**）**同步**跟随；
ResizeObserver + rAF 保留给**异步**撑高（图片 / mermaid）兜底。

### 3.6 🟡 P2 — 无虚拟化，且未使用 `content-visibility`

`App.tsx:942` 常驻渲染全部 run 的完整 DOM。全仓库无 `content-visibility`（已 grep）。
长会话下这是内存与布局成本的线性来源。

### 3.7 🟡 P3 — TurnNavigator 每个 App render 重挂监听并布局抖动

**证据**：`web/src/components/TurnNavigator/index.tsx:79-128`，
effect 依赖 `[runs]`，而 `runs`（`App.tsx:936` 传的 `currentSessionRuns`）**每次 render 都是新数组**。

**后果**：每次 App render → 拆装 `scroll`/`resize` 监听 + 对**每个 run** 执行一次
`document.getElementById`；滚动时 rAF 处理器内对每个可见 run 调 `getBoundingClientRect()`
（`TurnNavigator/index.tsx:96-112`），是读-布局抖动，且随 run 数线性增长。

---

## 4. 改造方案

### P0-1　已完成 run 不再走 SSE（一次性取回），SSE 只服务 live run

**Host 侧**：新增只读端点 `GET /runs/:runId/events`（直接返回 `store.listEvents(runId)` 的 JSON 数组，
与 `subscribe` 的回放同源，语义一致、可加 `Cache-Control`）。

**Web 侧**：
- `Timeline/index.tsx:277` 按状态分流：

```tsx
const isLive = run?.status === 'running' || run?.status === 'stopping';
const { events, streamedText } = useEventStream(
  optimistic ? null : (run?.runId ?? null),
  isLive,                 // 只有 live run 才开 SSE；已完成 run 走一次性 fetch
  !optimistic && isLive ? onRunTerminal : undefined,
);
```

- `useEventStream` 内：`live === false` 时改用 `fetch(/runs/:id/events)` 一次 `setEvents`，
  **完全不创建 EventSource**（也就不存在自动重连问题）。
  ⚠️ 不要简单地把现有 `live` 传 `false` —— `src/host/routes.ts:403` 的语义是
  「回放完 `sink.end()`」，而 EventSource 在流结束时**必然自动重连**（`api.ts` 的 `retry: 3000`），
  这正是 `Timeline/index.tsx:273-276` 注释里踩过的坑。**必须换成 `fetch`，或让 EventSource 收到终态后 close。**

**收益**：会话打开从 N 条 SSE 降为 0 条 SSE；事件取回转成可并发的普通 XHR，
**不再挤占 live run 的连接**；去掉 N 次订阅表登记与 N 次 EventSource 生命周期。
后端零破坏性（纯新增路由）。

**配套（可选、立即见效）**：历史 run 的 Timeline 分批挂载
（`requestIdleCallback` / 每帧 2~3 个），避免 25 次挂载挤在同一帧。

### P0-2　Mermaid 进入视口附近才渲染

```tsx
// MermaidBlock/index.tsx
const [visible, setVisible] = useState(false);
useEffect(() => {
  const node = chartRef.current;
  if (!node || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
  const io = new IntersectionObserver(
    (entries) => { if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } },
    { rootMargin: '600px 0px' },   // 提前一屏渲染，滚动到时已经画好
  );
  io.observe(node);
  return () => io.disconnect();
}, []);
```

- 渲染 effect（`:167`）加 `if (!visible) return;` 前置守卫。
- 占位视图必须**预留高度**（`min-height` + `contain-intrinsic-size`），否则渲染完成时会把下方内容顶开，
  触发滚动跳动——这会抵消收益。
- `rootMargin` 提前量是刻意设计：既避免视口外浪费，也避免「滚到了还是空白」。
- 主题切换 / 宽度变化的重渲（`themeTick`、`fontSize`）逻辑不变。

### P1-3　恢复 `memo` 的有效性

两条都要做，只做一条仍会失效：

1. **稳定 run 对象**：`refreshRuns` 里按 `runId` 复用上一次的对象，仅当渲染相关字段真的变化才替换：

```tsx
setRuns((prev) => {
  const byId = new Map(prev.map((r) => [r.runId, r]));
  return runResp.runs.map((next) => {
    const old = byId.get(next.runId);
    return old && isRenderEqual(old, next) ? old : next;
  });
});
```
   或在 `Timeline` 上加自定义 comparator，覆盖**所有实际影响渲染的字段**
   （`runId/status/updatedAt/result/error/workspace*/task/turnIndex` + 回调 props）。
   ⚠️ 只比 3 个字段会漏更新；两条路径二选一即可，但字段清单必须完整。

2. **稳定回调**：把 `handleCreateRun` 依赖里的 `latestSessionRun` 换成 ref 读取
   （`App.tsx:492-533`），否则即使 run 对象稳定，`onRetryCommand` 仍每次变。

3. 顺手 `useMemo` 包裹 `currentSessionRuns` / `displayedSessionRuns`（`App.tsx:340-346`）。

### P1-4　`buildStructure` 去掉每帧重复解析

- 用 `WeakMap<HostEvent, { thinking: string | null; visible: string }>` 缓存 `llm_call` 的 `stripThinkTags` 结果
  （事件对象不可变，天然是完美缓存键）。
- `globalThinkingAcc` 改为在 `mergeStreamingEvents` 的增量路径上顺带累加，而不是每帧 `filter/map/join` 全量。
- 进一步（可选）：把 structure 拆成 `settledSteps`（按 step 数做签名 memo）与 `activeStep`（每帧重算），
  这一步同时为 §3.3 的 memo 生效创造条件。

### P2-5　滚动跟随改为 paint 前同步

- 新增 `useLayoutEffect`，依赖为「流式文本 / 事件版本」，在 DOM 提交后**同步**置 `scrollTop = scrollHeight`。
- 保留 `ResizeObserver + rAF` 作为异步撑高（图片 / mermaid）的兜底。
- 给滚动容器加 `overflow-anchor: none`。
- `App.tsx:742`：进入导航滚动前先把 `followingRef` 置 false（或统一走 ref），避免 smooth 滚动被自动跟随打断。

### P2-6　`content-visibility` 兜底长会话

给每个 run 包裹层加：

```css
.content-visibility: auto;
contain-intrinsic-size: auto 800px;   /* 高度估值，避免滚动条跳动 */
```

**优先级说明**：这一步成本极低、风险极小，且**不依赖** P1-3。
但它与 P0-2 的 IntersectionObserver 有协同（视口外内容不再参与布局）。
真正的手写虚拟化（动态高度 + 自动滚动 + 活跃 run 保活）复杂度高，
**建议放到最后**，并且很可能在 P0-2 + P2-6 落地后不再必要。

### P3-7　TurnNavigator 依赖稳定化

- effect 依赖从 `[runs]` 改为稳定的 id 串（如 `runs.map(r => r.runId).join('\u0000')`）。
- 滚动处理器内缓存 `getBoundingClientRect` 结果，避免每帧对全部 run 读取布局。

---

## 5. 验收与测量配方（必须实测，不接受推断）

第一轮已建立「headless Chrome + CDP Tracing」方法（`docs/streaming-render-optimization.md` §4），本轮复用：

1. **会话打开耗时**：headless Chrome 加载应用 → 点击侧栏会话 `722feaac…` →
   `performance.mark` 到「最后一个 mermaid `<svg>` 出现 + 一次 `requestIdleCallback`」；
   统计 `RunTask` 中 **>50ms 长任务数与总阻塞时长**。
2. **对照实验**：同一流程分别打开「25 runs / 11 mermaid」与「1 run / 0 mermaid」会话，
   差值即 §3.1 + §3.2 的净成本；再对 P0-1 单独关闭 mermaid 复测，可把两者分离。
3. **连接数**：Network 面板（或 CDP `Network.enable`）统计会话打开瞬间的
   `text/event-stream` 请求数 —— **改造前应为 N，改造后应为 0（除 live run）**。
   这是 P0-1 最直接的验收指标。
4. **放大网络成本**：DevTools 限速 Slow 4G，让 1.61 MB 回放的代价显性化。
5. **流式期间**：在 live run 流式时反复切换会话，确认 live 流的 delta 不再停顿
   （验证「6 连接池被历史 SSE 挤占」这一因果）。
6. **微基准回归**：把 §2.4 的脚本固化为回归门禁（真实语料 + 项目自身栈），
   防止未来改动把 settled 答案拉回逐帧 parse。

---

## 6. 明确排除 / 未验证事项

- ❌ **不是** SSE 网络接收问题，**不是** Host 16ms 合帧问题，**不是** 模型首 token 延迟问题
  （这三项第一轮已定位为独立变量，本轮不重复怀疑）。
- ❌ **不是** markdown 解析问题：实测整会话 35.7 ms，且 `CollapsibleText` 的 string props
  已阻止历史答案重复解析。
- ⚠️ **未实测**：单次 `mermaid.render` 的毫秒数（本机无 Playwright 浏览器，未做浏览器内测量）。
  §3.2 的「成本高」是基于包体积与串行化的推断；「视口外也渲染」是代码事实。
  验收时按 §5.2 分离测量。
- ⚠️ **未实测**：滚动「差一帧」的肉眼可见程度。§3.5 是基于代码时序的推断
  （ResizeObserver 回调在 paint 后 + rAF 再延一帧），需要用真实录屏 / `PerformanceObserver('long-animation-frame')` 确认。
- ✅ **已否证**：历史 run 缺终端事件导致 SSE 永久挂住 —— 120/120 全部有终端事件（§2.3）。

---

## 7. 建议的实施顺序

| 批次 | 内容 | 风险 | 预期 |
|---|---|---|---|
| 1 | P0-2（mermaid 视口门控）+ P2-6（content-visibility） | 极低 | 会话打开的主要卡顿 |
| 2 | P0-1（已完成 run 改一次性 fetch，新增宿主只读路由） | 中（新增路由 + 客户端分支） | 连接风暴归零，live 流不再被挤 |
| 3 | P1-3（run 身份 + 回调稳定化） | 中（字段清单要完整） | 回合边界不再全体重渲 |
| 4 | P1-4 + P2-5 + P3-7 | 低 | 每帧 O(文本) 与大滚动布局归零 |
| 5 | 手写虚拟化 | 高 | 仅在 1+2 后仍不足时才做 |

---

## 8. 实施状态（本轮已落地）

### 8.1 已完成

| 项 | 改动 | 关键文件 |
|---|---|---|
| P0-2 | mermaid 视口门控：`IntersectionObserver`（提前 600px）+ 区分「未进视口」与「渲染中」两种占位，占位块保留 180px 高度 | `web/src/components/MermaidBlock/index.tsx`、`MermaidBlock.module.css` |
| P0-1 | 宿主新增 `RunManager.listRunEvents()` 与 `GET /runs/:id/events/snapshot`；前端 `fetchRunEvents()`；`useEventStream` 引入显式 `mode: 'live' \| 'snapshot'`，snapshot 路径**不创建 EventSource**（因此绕开 `?live=0` 的自动重连陷阱）；`Timeline` 按 `run.status` 分流 | `src/host/run-manager.ts`、`src/host/routes.ts`、`web/src/api.ts`、`web/src/hooks/useEventStream.ts`、`Timeline/index.tsx` |
| P1-3 | 新增 `reconcileRuns()` 复用未变化 Run 的引用（带编译期护栏）；`currentModelSelection` 加 `useMemo`（这才是回调身份传染的真正源头，见 §3.3 勘误）；`currentSessionRuns` / `displayedSessionRuns` 加 `useMemo` | `web/src/run-reconcile.ts`、`web/src/App.tsx` |
| P1-4 | `llm_call` 的 `stripThinkTags` 结果按事件对象 WeakMap 缓存（事件不可变，每帧重跑纯属浪费） | `Timeline/index.tsx` |
| P2-5 | 滚动跟随改为在 `ResizeObserver` 回调内**直接**补齐（该回调本就在布局后、绘制前；此前多排一次 rAF 正是差一帧的来源）；暴露 `stopFollowing`，修掉「点历史回合时平滑滚动被流式自动贴底打断」 | `web/src/hooks/useConversationScroll.ts`、`App.tsx` |

**顺带清理**：`useEventStream` 里 `isConnected` 是 set 后从未被读取的死状态，随重写一并移除（唯一调用方未解构它）。

### 8.2 主动决定「不做」（含理由）

- **P2-6 `content-visibility: auto` —— 暂不加**。它会让视口外 mermaid 的 `clientWidth` 读不到，
  而该宽度驱动 mermaid 的 `fontSize` 与「宽图转竖排」判定（`MermaidBlock/index.tsx:176-190`），
  会导致每张图白渲染两次 —— 比不加更慢。要做需先让宽度测量与可见性解耦。
- **P3-7 TurnNavigator —— 未改代码**。其 effect 依赖 `[runs]` 而 `runs` 每次 render 变新数组，
  根因已被 P1-3 的 `useMemo` 消除（`currentSessionRuns` 现在按 `[runs, currentSessionId]` 稳定），
  再改属于无效 churn。滚动处理器内的逐 run `getBoundingClientRect` 保留待观测。
- **未加 `overflow-anchor: none`**。这是常见「优化」，但用户向上翻阅时，视口上方图片/mermaid
  异步撑高会把阅读位置顶跑 —— 浏览器的滚动锚定此时是**帮忙**的。净收益为负。

### 8.3 已验证 / 未验证

**已验证（可复跑）**：

- `web` 与仓库根 `tsc` 全部通过。
- 全量确定性测试集 `npm run test:all` **退出码 0**。该 runner 对每个套件用 `execFileSync` 执行并以
  `process.exit(passed === results.length ? 0 : 1)` 收口（`tests/run-all.ts:97-111,124`），
  因此「退出码 0」等价于「全部已注册套件通过」，其中包含本轮新增的
  `run-reconcile`（9 项）与 `run-events-snapshot`（9 项）。
- 新增 `tests/run-events-snapshot.test.ts` 用真实 HTTP 断言了快照端点的核心契约，
  其中一条是**两条取回路径的一致性**：`/events/snapshot` 与 `/events?live=0` 必须给出同一事件序列。
- lint：用 `git worktree` 检出 `HEAD` 做对照，确认本轮改动**零新增**告警
  （差异仅为行号位移：Timeline +3、useConversationScroll +1）。
  ⚠️ 注意对照方法：用绝对路径在项目外跑 biome 会**跳过项目配置**而漏报，
  必须在项目根目录内运行才有效。

**仍未验证（不要当成已解决）**：

- ⚠️ 单次 `mermaid.render` 的毫秒数 —— 本机无 Playwright 浏览器，未做浏览器内测量。
  「视口外也渲染」是代码事实（浪费确定存在），但**消除它省下多少毫秒仍是推断**。
- ⚠️ 滚动「差一帧」的肉眼可见程度 —— 基于代码时序的推断，需真实录屏或
  `PerformanceObserver('long-animation-frame')` 确认。
- ⚠️ `memo` 恢复后的实际收益 —— 引用稳定性已在代码与单测层面锁定，
  但「回合边界不再全体重渲」的实际毫秒收益需按 §5 的真实录制验证。
- ⚠️ **端到端流畅度未做真实浏览器验收**：上述改动均未在真实流式会话 + 长会话切换下录过 Performance trace。
