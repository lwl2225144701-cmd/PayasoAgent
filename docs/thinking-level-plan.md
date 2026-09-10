# 思考档次（thinking level）接入方案

> 目标：在「设置 → 模型」的模型提供方里，为**每个模型**增加「思考档次」配置，
> 并在实际 LLM 请求中真正生效（DeepSeek `thinking:{type}` + `reasoning_effort`、
> Anthropic extended thinking、OpenAI reasoning_effort 等）。
> 本文是**实现前方案**，供评审后按清单执行。

## 1. 现状与结论

- **底层库已支持**：`@earendil-works/pi-ai` 内置完整思考档次体系，无需改动：
  - 类型：`ThinkingLevel = minimal | low | medium | high | xhigh | max`，外加 `off`（`ModelThinkingLevel`）。
  - 每个模型可带 `thinkingLevelMap`（pi 档次 → 厂商参数映射）；DeepSeek 内置模型已配好：
    `deepseek-v4-flash` 支持 `off/low/high/max`（`thinkingFormat: "deepseek"`，发 `thinking:{type}` + `reasoning_effort`）。
  - 工具函数：`getSupportedThinkingLevels(model)` / `clampThinkingLevel(model, level)`（主入口已导出）。
  - 统一入口：`models.streamSimple(model, context, { reasoning: level })`，内部按厂商映射、
    做档次 clamp、并自动处理思考预算封顶（Anthropic/Bedrock 调 `adjustMaxTokensForThinking`，
    OpenAI 兼容调 `clampThinkingBudgetToAnswerRoom`）。
- **Payaso 缺失**：设置 UI、SQLite 存储、RunManager 解析、LLM 请求四段链路都没有该字段。
  需要打通。

## 2. 数据流总览

```
设置页 UI (SettingsModal)
  → modelCapabilities[model].thinkingLevel      (web/src/types.ts + SettingsModal)
  → POST/PATCH /settings/models                  (routes → settings-store)
  → SQLite settings blob（StoredModelProvider.modelCapabilities）
  → getProviderCredentials(id, model)            (settings-store → store 接口)
  → RunManager.resolveModelConfig / modelConfigForRun
  → llm.ModelConfig.thinkingLevel
  → models.streamSimple(..., { reasoning })      (llm.ts chat)
  → pi-ai 按 thinkingFormat/thinkingLevelMap 映射为厂商请求参数
```

## 3. 分文件改动清单

### 3.1 `web/src/types.ts`

- 新增类型（与 pi-ai 一致）：
  ```ts
  export type ModelThinkingLevel =
    | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  ```
- `ModelCapabilitySetting` 加字段：`thinkingLevel?: ModelThinkingLevel`。
- `PiAiModelInfo` 加字段：`thinkingLevels?: ModelThinkingLevel[]`（pi 内置模型真正支持的档次，
  来自 `getSupportedThinkingLevels`；自定义端点不提供，前端用全量）。

### 3.2 `src/host/pi-ai-providers.ts`

- `toModelInfo()` 里用 `getSupportedThinkingLevels(model)` 算出 `thinkingLevels` 暴露给前端，
  供设置页下拉只显示该模型支持的档次（如 DeepSeek 只显示 off/low/high/max）。

### 3.3 `src/host/persistence/settings-store.ts`

- `ModelCapabilitySetting` 加 `thinkingLevel?: ModelThinkingLevel`（与 `vision` 并列）。
- `normalizeModelCapabilities()` 增加枚举校验：不在 7 个合法值内 → `throw`（仿 vision 校验）。
- `getProviderCredentials()` 在 `model` 提供时返回 `thinkingLevel`。

### 3.4 `src/host/persistence/store.ts`

- `getModelProviderSecret` 接口返回类型同步加 `thinkingLevel?: ModelThinkingLevel`。
- `sqlite-store.ts` 的 `getModelProviderSecret` 直接透传（无需改，类型自动跟上）。

### 3.5 `src/host/run-manager.ts`

- `resolveModelConfig()` 与 `modelConfigForRun()`：把 `secret.thinkingLevel` 透传进 `ModelConfig`。
- 不改解析语义：`thinkingLevel` 只在用户显式配置时出现，缺省保持原行为。

### 3.6 `src/llm/llm.ts`

- `ModelConfig` 加 `thinkingLevel?: ModelThinkingLevel`；`resolveEndpointConfig()` 透传。
- 新增 `activeThinkingLevel(level)`：`'off'` 与未配置等价，归一为 `undefined`
  （= 这次请求不配置思考档次）。
- **`chat()` 按"是否配置了档次"二选一**（复核后收敛的最终设计）：
  - 未配置 / `off` → `models.stream`：与引入该功能前**逐字节一致**，不引入任何新字段；
  - 配置了档次 → `models.streamSimple(..., { reasoning })`：pi-ai 的 provider 无关思考入口，
    按 `thinkingFormat`/`thinkingLevelMap` 映射厂商参数并封顶思考预算。
  - 两条路径的事件流（`thinking_delta`/`toolcall_delta`）完全一致。
- **自定义 OpenAI 兼容端点**：`reasoning` 由配置决定（`activeThinkingLevel(...) !== undefined`），
  不再恒为 `true`；`compat` 删掉硬编码的 `supportsReasoningEffort: false`，交给 pi-ai 的
  `getCompat` 按 baseUrl 自动探测。
  - 机制（两道闸门）：`streamSimple` 内 `clampThinkingLevel` 依赖 `getSupportedThinkingLevels(model)`，
    `model.reasoning === false` 时支持列表只有 `["off"]`，任何档次被 clamp 成 off；
    而后 `buildParams` 的厂商分支还要过 `compat.supportsReasoningEffort` 才发 `reasoning_effort`。
    未配置档次的请求走 `stream`，两个闸门都不参与 —— 这就是"配了才动请求"能成立的原因。
  - **实测行为（2026-09-10，抓真实请求体）**：

    | 自定义端点 | 未配置档次 | 配 `high` |
    | --- | --- | --- |
    | 通用 OpenAI 兼容 | 不发思考参数 | `reasoning_effort:"high"` |
    | `api.deepseek.com` | 不发思考参数 | `thinking:{type:"enabled"}` + `reasoning_effort:"high"` |
    | `open.bigmodel.cn`（zai） | 不发思考参数 | 原生 zai 分支 |
    | `api.together.xyz` | 不发思考参数 | 原生 together 分支 |
    | `openrouter.ai` | 不发思考参数 | `reasoning:{effort:"high"}` |

  - π 内置 provider 未配置档次时的行为**与改动前一致**（deepseek → `thinking:{type:"disabled"}`、
    anthropic 系 → 不发 thinking 字段），因为内置模型走注册表自身的 compat，且仍走旧 `stream` 路径。
  - **复核中实测到并已消除的两个副作用**（曾因无条件 `reasoning: true` + 恒走 `streamSimple` 引入）：
    1. 未配档次时四类端点被主动"关闭思考"（`thinking:{type:"disabled"}` /
       `reasoning:{enabled:false}` / `reasoning:{effort:"none"}`）——会把本来默认开思考的
       OpenRouter / GLM / Together 模型关掉；
    2. anthropic 系 provider 未配档次时多发 `thinking:{type:"disabled"}`（MiniMax 等
       Anthropic 兼容端点是否接受未知，有 400 风险），且 `maxTokens` 被
       `buildBaseOptions → clampMaxTokensToContext` 按剩余窗口钳制（实测极端情况压到
       `max_tokens: 1`，即"空回答"风险面）。
    两条副作用均由"配了档次才切换路径"消除，并各配一条回归测试（见 §3.8）。
  - **自定义端点的档次语义（无 thinkingLevelMap）**：`off` 与未配置等价；`xhigh`/`max` 会被
    clamp 成 `high` → UI 对自定义端点只显示 `off/minimal/low/medium/high` 五档。
  - **`xhigh`/`max` 静默降级**：后端校验接受 7 档，自定义端点选 `max` 实际发 `high`
    （pi-ai clamp），UI 已不提供，API 直传仍会降级 —— 属已知取舍。

> 备注：exotic 端点若需 `thinking_token_budget` 等 token 预算字段，属后续增强
> （`compat.thinkingTokenBudgetField` / `thinkingBudgets`），不在本次范围。

### 3.7 `web/src/components/SettingsModal/index.tsx`

- `ModelTag` 加 `thinkingLevel?: ModelThinkingLevel`。
- 模型标签行（现有「上下文窗口 / 最大输出 / 视觉」旁）加「思考档次」`<select>`：
  - 选项来源：`form.piProviderId` 时从 `piAiProviders` 里按模型查 `thinkingLevels`；
    自定义端点时显示 `minimal/low/medium/high`（`xhigh/max` 会静默降级为 `high`，不提供）。
  - **不提供 `off` 选项**：`off` 与「默认（不设置）」在请求层完全等价（都不介入请求），
    列出它会暗示一个我们并不会发出的"关闭思考"指令。存量 `off` 值在编辑回填时归一为空
    （后端仍接受 `off`，行为等同未配置，仅为 API 兼容保留）。
  - 空值 = 不设置（跟随默认）。
- `handleSave()`：把填写的档次并入 `modelCapabilities`（仿 vision 分支）。
- `startEdit()`：从 `m.modelCapabilities?.[model]?.thinkingLevel` 回填。
- `catalogFromPiAiProvider()` / `mergeCatalogIntoTags()`：透传 `thinkingLevels`（不自动预选档次，
  避免把用户没选的档次强写进保存数据）。
- `ModelSyncDialog`：可选在模型 meta 里显示「思考」徽标（`model.thinkingLevels` 存在且非空时）。

### 3.8 测试

- `tests/settings.test.ts`（v1.6 闭环区，仿 `cap-chat` 用例）：
  - 创建带 `thinkingLevel` 的能力覆盖 → 视图/GET 回显；
  - 凭证读取按 model 携带 `thinkingLevel`；未配置模型不带；
  - 非法档次值（如 `"ultra"`）→ 400 拒绝。
- `tests/pi-ai-provider.test.ts`：
  - `listPiAiProviderCatalog()` 的 DeepSeek 模型 `thinkingLevels` 含 `off/low/high/max` 且不含 `minimal/medium`。
- `tests/llm.test.ts`：
  - 通过 `onPayload`/fetch 捕获，断言配置 `thinkingLevel: 'high'` 时请求体出现
    `reasoning_effort: "high"`（或 DeepSeek `thinking:{type:"enabled"}`）；未配置时无该参数。

## 4. 决策点（实现时的取舍）

1. **统一走 `streamSimple`**：比逐个 API 拼 `reasoningEffort/thinkingEnabled` 干净，
   且 pi-ai 官方指南（`docs/pi-ai-使用指南.md` §6）推荐该入口。
2. **档次是「按模型」配置**（进 `modelCapabilities`），不是 Provider 级：与现有
   contextWindow/maxOutputTokens/vision 一致，粒度最细。
3. **`off` 显式关思考** vs 空值不设置：两者都保留。`off` 用于 DeepSeek 这类默认开思考的模型
   显式关掉；空值保持现状（对 deepseek 默认即发 `thinking:{type:"disabled"}`，行为不变）。
4. **不自动预选档次**：pi 内置模型同步时只暴露「支持哪些档次」供选择，不把档次写进保存数据，
   避免静默改变已有 Provider 行为。

## 5. 验收

- `npx tsc --noEmit` 通过；
- `npm run test:all`（68 个确定性套件）全绿，新增用例在 `settings` / `pi-ai-provider` / `llm` 套件内；
- `npm run build:web` 通过；
- 手动：设置页给 DeepSeek 内置 Provider 的某模型选「高」→ 保存 → 发起任务，抓请求体确认
  `thinking:{type:"enabled"}` + `reasoning_effort:"high"`；未选时请求体无思考参数。
