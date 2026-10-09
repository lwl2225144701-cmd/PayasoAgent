# 内置 Provider 模型目录刷新（MiMo v2.6 案例）

> 状态：**第一、二层已实现**（启动自动探测 + 目录缓存；能力归一化 + 刷新资格放宽）；第三层见 §5
> 回归：`tests/builtin-catalog-refresh.test.ts`（已登记进 `tests/run-all.ts`）

## 1. 问题

配置 MiMo Token Plan（`xiaomi-token-plan-cn` 等内置 Provider）时，设置页识别不到 MiMo 新发布的 **v2.6 系列**（`mimo-v2.6-pro` / `mimo-v2.6-flash` / `mimo-v2.6-pro-ultraspeed`），只能看到 v2.5。

## 2. 根因：三层都是"构建期静态数据"

| 层 | 位置 | 症状 |
|---|---|---|
| ① 内置目录 | `@earendil-works/pi-ai` 的 `providers/data/*.json`（`generatedAt: 2026-09-05`） | Token Plan 三个区域只含 `mimo-v2.5` / `mimo-v2.5-pro` |
| ② 保存校验 | `settings-store.ts` 的 `内置提供方不支持模型` 拒绝 | 目录外的模型 ID 即使手输也存不进去 |
| ③ 运行时 | `llm.ts` 调 `getPiAiProviderModel` | 目录外的模型拿不到 `api` / `baseUrl` / `compat`，直接抛错 |

更根本的边界（`docs/guides/pi-ai-使用指南.md` §1 已写明）：**静态内置 Provider 的 `refresh()` 是空操作**，而设置页对内置 Provider 的「刷新/检测」按钮读的正是这份静态目录——所以按钮在点多少次都不会变。自定义 Provider 才走真正的 `GET /models`。

结论：供应商上新与依赖升级之间必然存在时间差，靠"升级 pi-ai"无法根治，只能把**远端探测**接进内置 Provider。

## 3. 设计

四个部分各自解决一层，且互为兜底。

### 3.1 本地模型补丁（overlay）—— 解决 ①

`src/host/pi-ai-providers.ts` 的 `BUILTIN_MODEL_OVERLAY`：把官方文档已确认、但 pi-ai 静态目录尚未收录的模型补进目录。只声明与模板模型不同的字段，`api` / `baseUrl` / `compat` / `reasoning` / `thinkingLevelMap` 从同 Provider 的模板模型（`mimo-v2.5`）继承——同协议族无需重复声明。

- 目录与运行时同时生效（`providerRuntimeModels`），①③ 立即闭环；
- 同 id 时**静态条目优先**（`overlay` 做去重后追加），依赖升级后补丁自动让位，无需人工下线；
- 补丁只做加法：v2.5 保持可见，旧配置不失效。

### 3.2 远端 `/models` 合并 —— 解决"下一个 v2.7"

`available-models.ts` 的 `fetchBuiltinProviderCatalog(piProviderId, baseUrl, apiKey)`：远端结果与内置目录取并集。

- **内置条目权威**：视觉、思考档次、`contextWindow` 等只有注册表知道，远端只补缺字段，不覆盖；
- 远端独有的模型直接进入目录，`contextWindow` 缺失时由 `model-context.ts` 的 `MODEL_CAPABILITIES` 注册表兜底（v2.6 已登记 1M / 128K）；
- 两条路由复用同一逻辑：`/settings/available-models`（编辑态，providerId 已存）与 `/settings/available-models/preview`（新增态，可选 `piProviderId`）。

远端刷新的资格由 `isRemoteRefreshableProvider()` 判定，条件是**协议事实**（Provider 级 https 地址 + Bearer + OpenAI 约定的 `{baseUrl}/models` 端点，完整表格与排除项见 §3.7）。结果通过 `PiAiProviderInfo.refreshable` 下发给设置页，决定按钮文案与是否发起探测。

### 3.3 模型准入名单 —— 解决 ②

`settings` blob 新增 `builtinDiscoveredModels: Record<piProviderId, string[]>`：一次成功的远端探测把结果记为该 Provider 的「可保存模型名单」，校验集合 = **静态目录（含补丁）∪ 准入名单**。

关键取舍：

- **fail-closed**：探测失败（401/500/超时）不写名单，拼错的模型 ID 依旧被拒；
- **并集而非替换**：端点抖动返回子集时，已配置模型不会突然变成无法保存；
- **带上限**（200，FIFO 淘汰最旧）：名单只放宽校验，不表示当前可用性，多留旧 id 无行为风险；
- **跨重启持久化**：它是 blob 的一部分，重启后新增/编辑仍然有效。

### 3.4 运行时合成 —— 解决 ③

`resolvePiAiRuntimeModel(providerId, modelId)`：先查目录（静态 + 补丁），未命中再由 `getPiAiDiscoveredModel` 按同族模板合成等价 `Model`（`api` / `baseUrl` / `compat` 继承模板；上下文窗口由设置页按模型配置覆盖，`llm.ts` 的 `modelContext` 优先取配置值）。

两个刻意的保守决定：

- 合成只对 `refreshable` 的 Provider 生效——否则会把配置错误掩盖成"能跑"；
- `input` 取 `['text']` 而不继承模板的 `['text','image']`：远端 `/models` 无法可靠声明图片输入，视觉一律走设置页显式开关（与自定义端点同一套规则，由 `llm.ts` 补 `image`）。

### 3.5 前端

设置页「检测并同步模型（含远端）」按钮仅在 `provider.refreshable` 时使用远端路径：

- 编辑态用已存密钥（`fetchAvailableModels`），表单里刚输入的新密钥优先（`preview`），因为保存前服务端读到的还是旧值；
- 远端失败**不阻断**：回退到内置目录，并把原因放进同步对话框的 `syncError`（表单级错误会被对话框挡住，用户看不到）；
- 新增态没有密钥时提示「填写 API 密钥后可同时检测远端模型」。

## 3.6 第一层：启动后台探测 + 目录缓存（根治「必须有人点刷新」）

§3 的方案让「点击检测」能拿到远端新模型，但**仍依赖有人去点**。第一层把目录来源从
「静态目录 + 手动点击」变成「**自动探测的远端目录**，静态目录退为冷启动回退」。

### 机制

1. **启动后台探测**（`src/host/builtin-catalog-probe.ts`）：`startHost` 在 `server.listen`
   成功**之后** fire-and-forget 调 `refreshBuiltinModelCatalogs(manager)`。
   - 就绪探针不等它 —— **不阻塞启动**：`server.listen()` 回调成功后才 `void` 派发，
     全程不 `await`。有效证据是**应用自身日志的顺序**：`listening` → `[context] …` →
     `首次使用：…`（同步启动路径的最后一条）都出现在
     `[catalog] … 远端目录已刷新` **之前**，说明探测结果是在同步启动路径跑完之后才回来的。
     （注意：后台任务封装会追加 `[status: running]` 这类元数据，它不是应用输出，不能
     拿它当顺序证据。）
   - 探测失败只返回 `ok:false` 结果并打 WARN，**永不 reject**，绝不把启动变成进程退出；
   - 只探「已配置密钥 + `isRemoteRefreshableProvider`」的 Provider，有界并发（3）+
     单次超时（12s），避免启动瞬间对同批端点发起风暴；
   - 日志只打 `piProviderId` 与模型数，**不打 baseUrl/apiKey/响应原文**。

2. **目录缓存**（settings blob 的 `builtinRemoteCatalog`）：与 `builtinDiscoveredModels`
   同处一个 blob、同一次 `writeSettings` 原子落盘。
   - 存**合并后的目录**（静态 ∪ 远端）+ `fetchedAt` + `stale`；
   - **失败不丢目录**：保留上次成功的模型列表，只把 `stale` 置位；
   - **首探失败不凭空造空目录**：从未成功过时 no-op（缓存保持不存在，准入名单也不放宽）。

3. **读取优先级**：`GET /settings/pi-ai/providers` 走 `mergeCachedRemoteCatalog(静态目录, 缓存)`
   —— 纯函数，不发网络。冷启动首探未完成 → 纯静态目录；探测成功 → 含远端新模型；
   探测失败 → 上次成功结果 + `catalogStale` 供 UI 提示。设置页因此**无需点刷新**就能看到新模型。

### 为什么缓存「合并目录」而不是「远端原始条目」

pi-ai 升级后本地补丁会变（同 id 自动让位），若缓存存远端原始条目、合并发生在读取时，
补丁变化就要求缓存失效。存合并结果 + 读取时仍用 `mergeCachedRemoteCatalog` 叠一层，
两条路径（实时网络 / 读缓存）合并规则一致，目录永远同构；补丁升级只影响静态那半边。

### 验收（第一层，实测）

| 场景 | 结果 |
|---|---|
| 冷启动有已配置的内置 Provider | 应用日志出现 `[catalog] … 远端目录已刷新`，且排在 `首次使用：…`（同步启动路径最后一条）之后 |
| `GET /settings/pi-ai/providers` | 无需点刷新即含远端独有且属于对话类别的模型 |
| 探测失败 | `catalogStale=true`，模型列表沿用上次成功结果（不被清空） |
| 恢复成功 | `catalogStale` 消失 |

## 3.7 第二层：能力归一化 + 放宽刷新资格

第一层解决了「新模型何时出现」，第二层解决两件事：**出现的模型能力对不对**，
以及**哪些供应商能被探测**。

### 能力归一化（`provider-url.ts`）

`/models` 响应里能读到的能力，现在会进模型元数据：

- **视觉**（`extractVision`）：只在供应商**显式声明**时填——`input_modalities` /
  `modalities` / `architecture.input_modalities` 列表，或 `supports_vision` 布尔标志。
  缺字段返回 `undefined`，绝不猜（视觉开关继续交给设置页手工勾选）。
- **分类**（`classifyProviderModel`）：补上 `asr` 段锚定识别（`mimo-v2.5-asr` 之前被
  误判成对话模型）。

**优先级不变且是硬约束**：静态注册表 > 远端声明 > 用户手填。远端声明只对「远端独有的
新模型」生效，不会把已知模型改坏——`mergeBuiltinsAndRemote` 里静态条目在前、远端只补缺。

### 目录合并收敛为单一实现

`fetchBuiltinProviderCatalog`（实时网络）与 `mergeCachedRemoteCatalog`（读缓存）原先
各写一遍合并规则；现在共用 `mergeBuiltinsAndRemote`。这样"两条路径同构"是**结构性保证**
而不是靠同步维护的约定，测试也直接断言两者的目录完全一致。

顺带修掉第一层的目录污染：**非对话模型（embedding / tts / asr / image）不再进对话
Provider 的可选目录**——否则默认模型有可能落在 TTS 上。注意只过滤「展示」，准入名单
仍记远端全部 id：分类是启发式，宁可让用户手动补一个被误分类的真实模型，也不能把可用的
对话模型挡在门外。

### 刷新资格放宽（`isRemoteRefreshableProvider`）

资格由**协议事实**决定（稳定，不像模型清单会随发布而变）：Provider 级 https 地址 +
全部模型走 Bearer + OpenAI 约定的 `{baseUrl}/models`。因此 `openai-completions` 与
`openai-responses` 同族放行——新增覆盖 **`openai`、`xai`**（此前 19/33 → 21/33 可刷新）。

**刻意不放行**（宁可少覆盖也不猜）：

| 排除对象 | 理由 |
|---|---|
| `anthropic-messages`（anthropic / minimax-cn / kimi-coding / vercel-ai-gateway） | 鉴权头是 `x-api-key` + `anthropic-version`，且路径约定各供应商不同（官方 `${baseUrl}/v1/models`，emulation 可能带 `/anthropic` 前缀），无凭据无法验证 |
| 混合 API（openrouter / fireworks / github-copilot） | 单一 baseUrl 下多种 wire，推不出唯一鉴权与路径 |
| 非标准 API（google / mistral）、按模型地址（opencode-go 等） | 没有统一可探端点 |

### 为什么不提取 `reasoning`

`/models` 声明的推理能力**没有消费者**：`PiAiModelInfo.reasoning` 前端声明了但设置页
不读；而 `thinkingLevels` 依赖 `thinkingLevelMap`，远端不提供它——编造推理能力或思考
档次会让设置页给出端点无法识别的参数。运行时走 `getPiAiDiscoveredModel` 合成（用同族
模板的 `compat`），与设置页展示 `['off']` 不冲突：不配档次就不发思考参数，模型按端点
默认行为运行。这项留作已知缺口，见 §5。

### 验收（第二层，实测于新 build 后的运行实例）

| 检查项 | 实测结果 |
|---|---|
| 可刷新 Provider 数 | `19/33 → 21/33`（新增 `openai`、`xai`） |
| `openai` / `xai` 的 `refreshable` | `true` / `true` |
| 仍排除的对照组 | `anthropic` / `minimax-cn` / `openrouter` / `github-copilot` / `google` / `mistral` 全为 `false` |
| 对话目录 | `mimo-v2.5, mimo-v2.5-pro, mimo-v2.6-pro, mimo-v2.6-flash` —— TTS / ASR / embedding 已被过滤（此前 8 个含 4 个非对话模型） |
| 视觉能力 | `mimo-v2.6-pro` → `text+image`（本地补丁）；`mimo-v2.5-pro` → `text`（静态 text-only **未被远端改写**） |

## 4. 边界（刻意不做的事）

- **不升级 pi-ai 到 1.x**：`0.85.1 → 1.1.0` 跨度大（`openai` SDK / provider API / 类型），先用本地补丁 + 远端合并解除阻塞；升级作为独立事项评估（见 §5）。
- **不改自定义 Provider 路径**：它本来就走远端，无变化。
- **不做 provider 级远端 `fetchModels` 集成**（`models.refresh()`）：那是 pi-ai 动态 Provider 的模型，改动面更大；当前方案用现成的 Host 安全请求链（`provider-url.ts`，协议白名单 / 超时 / 响应体上限 / 不回显凭证）已达目标。
- **不保存远端响应原文**：只存模型 ID 名单与用户显式配置的能力字段。

## 5. 后续（第三层 + 已知缺口 —— 尚未实施）

前两层已让「任何供应商上新」对用户透明，且能力声明能被正确读取；仍剩一处结构性缺口与
两类刻意保守的边界：

- [ ] **第三层：依赖升级自动化（CI diff 报警）**
  - 定期拉取各内置 Provider `/models`，与 pi-ai 静态目录做 diff 报警（新增/下线都报）；
  - 报警触发依赖升级 PR，测试 + 真实调用验证通过后由人工 review 合并；
  - 覆盖率指标进 CI：`静态度能识 / 远端返回数`，低于阈值即红。
  - **性质不同**：这是流程/流水线而非运行时代码，且会连带引爆 pi-ai 1.x 迁移 →
    建议独立立项，等第一、二层跑出真实 diff 噪音数据后再决定自动化程度。
    （2026-10 评估过一版并临时撤销：对用户可见问题无改进、CI 需先配凭据才会生效、
    报警后"自动开 PR"仍缺失，故暂不做——留待有人能持续看它时再启用。）
- [ ] **`anthropic-messages` 供应商的远端刷新**（anthropic / minimax-cn / kimi-coding /
  vercel-ai-gateway）：需按鉴权头（`x-api-key` + `anthropic-version`）与路径约定
  （`${baseUrl}/v1/models` vs `${baseUrl}/models`）逐家验证，**必须有真实凭据做集成
  验证**，不能只靠 mock。在那之前保持不放行（见 §3.7 的表格）。
- [ ] **远端 `reasoning` 声明的消费**：`thinkingLevelMap` 仍只来自静态注册表，远端独有
  的推理模型在设置页只能选「不设置」。要放开需先确定该模型接受的参数值——同样需要真实
  端点验证。
- [ ] 评估升级 `@earendil-works/pi-ai` 至 1.x，届时清理 `BUILTIN_MODEL_OVERLAY`（同 id 自动让位，可安全保留）。

## 6. 测试

`tests/builtin-catalog-refresh.test.ts`（无真实网络与 LLM，`/models` 与上游全部 mock）：

1. **补丁**：四个 Token Plan / API 计费 Provider 目录与运行时均含 v2.6，能力 1M / 128K / vision / reasoning / `thinkingFormat=deepseek` 正确；
2. **资格**：`refreshable` 真值表（cn→true、`minimax-cn`→false、`opencode-go`→false）；
3. **合并**：远端独有模型入列、内置元数据不被覆盖、顺序契约（内置在前、远端追加）、无重复；
4. **准入**：未探测→400；探测失败→400（不放宽）；探测成功→200；**重启后**名单仍可保存，拼错的 ID 依旧被拒；
5. **合成**：目录外已探测模型能解析出 `openai-completions` + 正确 `baseUrl` + `compat`，非 refreshable Provider 不合成；
6. **第一层（启动缓存）**：
   - 无缓存 → 纯静态目录（冷启动状态）；
   - 有缓存 → 远端独有模型入列、**静态条目能力逐字段不被改写**、`fetchedAt` 透出；
   - `refreshBuiltinModelCatalogs` 成功→写缓存+准入名单，`GET /settings/pi-ai/providers`
     无需点刷新即含远端新模型；失败→`catalogStale=true` 且模型列表沿用上次成功结果；
   - 网络异常**永不 reject**，且首探失败不写缓存、不放宽准入（fail-closed）。
7. **第二层（能力归一化 + 资格放宽）**：
   - 刷新资格真值表：`openai`/`xai`→true；`anthropic`/`minimax-cn`/`kimi-coding`、
     `openrouter`/`fireworks`/`github-copilot`、`google`/`mistral`/`opencode-go`→false；
   - `vision`：架构声明图片→`true`、声明纯文本→`false`、供应商不表态→`undefined`（不猜）；
   - 分类：`asr`/`tts`→`audio`、`text-embedding-*`→`embedding`，**不进对话目录**；
   - 准入名单仍保留非对话 id（分类是启发式，不阻断手动补入）；
   - 静态条目视觉能力不被远端改写（含 text-only 的 `mimo-v2.5-pro` 保持无视觉）；
   - **读缓存路径与实时路径目录完全一致**（共用 `mergeBuiltinsAndRemote` 的结构性保证）。
