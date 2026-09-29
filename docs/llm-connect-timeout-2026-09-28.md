# LLM 连接超时排查报告：长上下文首字节超过 30 秒

- **记录日期：**2026-09-28
- **问题类型：**LLM 连接超时（`LLM request timed out: no response received within 30000ms`）
- **涉及 Run：**turn 21 / 26（`deepseek-v4-1-flash`，ark）、turn 29 / 31 / 32 / 33（`step-5-preview`，stepfun）
- **状态：**已定位根因；代码尚未修改。

## 1. 这次的问题

多轮对话之后，LLM 请求的「首 token」偶发超过 30 秒，触发客户端连接超时，整个 Run 直接 `failed`——连「嗯？」这种空任务也在第一轮就挂。

- 当天 6 次超时全部发生在会话变长之后（turn 21 / 26 / 29 / 31 / 32 / 33）；早盘上下文小时（turn 1–20）一次没有。
- 同模型紧邻的 turn 成功/失败交错：turn 30（completed）单轮「请求→完成」**28s / 34s**，turn 31（failed）**30s 超时**——首 token 本就贴着 30s 线，负载一抖就越线。
- 网络链路是通的：stepfun / ark 的 DNS+TCP+TLS 都在 350ms 内完成。不是断网、不是 Provider 宕机。

## 2. 根因

**每轮都在改写请求的最开头，把 provider 默认就有的前缀缓存作废了，于是 33 万 token 历史每轮全量 re-prefill。**

- 所有 provider 都有前缀缓存（deepseek 系 / stepfun / MiniMax），且只匹配「从头逐字相同」的段——这件事是**模型无关**的，不是「谁家有没有缓存」。
- [`buildModelView`](../src/harness/context-harness.ts)（约 L517–L522）把 system 拼成 `内核指令 + 计划 + 草稿 + 旧轮摘要 + 进度提醒`：只有「内核指令」稳定，其余每轮都变；而这条 system 是 messages 的**第 0 号**、排在全部历史之前（`splice`/`unshift`，约 L533–L536）。
- 于是缓存从头就断：ark 实测每轮 `cacheReadTokens` 恒为 **2048**（内核指令稳定头），之后 system 剩余部分 + 全部历史每轮重新 prefill。反证：`conversationHistory` 复用的历史本身是 append-only、字节一致的，唯一不稳定源就是这条 system。
- 放大因素（非根因）：连接超时默认 30s（[`DEFAULT_LLM_CONNECT_TIMEOUT_MS`](../src/llm/llm.ts) L40），且 [`shouldRetry`](../src/llm/llm.ts)（L859–L866）对超时一律不重试——一越线就立刻 `failed`。

因果链一句话：**前缀被改断 → 缓存作废 → 33 万 token 每轮全量 re-prefill → 首 token 贴着并偶发越过 30s 线 → 超时。**

## 3. 分层认知：哪里按模型、哪里模型无关

对照 DSH 的分工，看清哪些层「按模型」、哪些「模型无关」——这把「该修哪里」讲清楚：

| 层 | DSH | Payaso 现状 | 差距 |
| --- | --- | --- | --- |
| 压缩阈值/保留/摘要模型 | ✅ 显式按模型（`modelPolicies` 覆盖表 + `resolveModelInfo` 按模型取窗口/输出） | 半按模型：窗口按模型（settings→registry→fallback 256K），但阈值/保留/摘要全是全局常量（`0.8`/`0.65`/`0.85`，[context-harness.ts L574–L606](../src/harness/context-harness.ts)），无 per-model 覆盖表 | 可借 `modelPolicies` |
| 图片/文件 token 定价 | ✅ 按模型 route（`request-pricing`/`priceSurface`） | 固定启发式（`estimateImageTokens` 固定 tile 价，[model-context.ts L195–L215](../src/harness/model-context.ts)） | 可借，与本次无关 |
| 缓存命中 / TTFT | ❌ 无 per-model，provider 自动；harness 只稳定前缀 + 归一化 | 已模型无关归一化 `cacheRead/cacheWrite`（[token-usage.ts](../src/llm/token-usage.ts) 单一路径） | 缺「稳定前缀」这半边 |

**一句话收口：** 我们踩的坑在**第 3 行（缓存命中 / TTFT）**——这条 harness 本来就不按模型开关，只要求「别破坏前缀」+「读回 cache 字段做观测」。所以修我们问题的就是**稳定前缀**（system 冻结 + 动态内容移尾部 append），一处改动、模型无关，与 DSH「不按模型发 cache_control」一致。第 1、2 行（按模型的压缩/定价）是另一条线，治的是「冷缓存首轮 / 跨会话 / 请求体过大 / 估算不准」，不是本次根因，留作后续增强。

## 4. 需要补充的能力（必做）

**稳定前缀，让缓存命中整段历史（根治，一处改动、模型无关）：**

把 system 冻结为字节级不变的内核指令；把每轮会变的计划 / 草稿 / 摘要 / 提醒从 system 头部**移到请求末尾、作为尾部 append 的消息**。这样「冻结的 system + append-only 的历史」构成稳定前缀，provider 的前缀缓存整段命中，每轮真正重新 prefill 的只剩新增的几百 token，TTFT 从 20–30s 塌到秒级，30s 超时自然消失。

配套观测：把命中率 `cacheRead/(input+cacheRead)` 做成每轮可观测指标（Payaso 的 [`token-usage.ts`](../src/llm/token-usage.ts) 已模型无关地归一化 `cacheReadTokens/cacheWriteTokens`，单一路径），作为 TTFT 的代理，用于验证修复效果、接入后续压缩决策。

## 5. 调研发现：还可以补充的能力（可选）

| 能力 | 现状 → 目标 | 来源 |
| --- | --- | --- |
| 按模型压缩策略覆盖表（`modelPolicies`） | 压缩阈值是全局常量（`0.8` 触发 / `0.65` 目标 / `0.85` 应急，[context-harness.ts L574–L606](../src/harness/context-harness.ts)）× 按模型窗口；缺 per-model 的 `thresholdRatio` / `retainRatio` / `摘要模型` 覆盖 | DSH `compaction-basic` |
| 跨轮历史成本阈值 / 有界历史投影 | 33 万 token 命中缓存后请求体仍大、冷缓存首轮与跨会话仍满额 prefill；1M 窗口下 80% 触发阈值（≈77.6 万）形同虚设，需加「历史成本」的独立维度 | 旧报告 + 本研究 |
| 按模型图片/文件 token 定价 | 现状固定启发式（`estimateImageTokens`）；DSH 按 model route 替换（`request-pricing` / `priceSurface`） | DSH |
| 连接阶段超时可重试 / 放宽超时 | `PAYASO_LLM_CONNECT_TIMEOUT_MS` 放宽，或仅在 `llm-connect` 来源放行一次重试（区别于空闲超时）| 本研究（兜底，不替代根因修复） |

**本报告是诊断记录，不代表上述代码已修改。**