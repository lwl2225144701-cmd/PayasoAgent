# `@earendil-works/pi-ai` 使用指南

> 本文依据 `/Users/luweiliang/Downloads/myProject/pi/packages/ai/README.md` 和同目录 `src` 源码整理，目标是让第一次接触 `pi-ai` 的 TypeScript 开发者能够直接跑起来，并能把它接入 PayasoAgent。
>
> 重要边界：本文中的“认证完成”只表示本地配置可解析；它不等于已经访问过供应商的 `/models` 或聊天接口。静态内置 Provider 的 `refresh()` 是空操作，真正的远端模型目录探测要通过动态 Provider 的 `fetchModels`/`models.refresh()` 或应用自己的探测逻辑完成。

## 1. 安装与快速开始

### 安装

```bash
npm install @earendil-works/pi-ai
```

`TypeBox` 的 `Type`、`Static`、`TSchema` 已经从 `@earendil-works/pi-ai` 根入口导出，不需要从 `typebox` 另写一套导入：

```typescript
import { Type, type Static, type TSchema } from '@earendil-works/pi-ai';
```

当前包声明的 Node.js 最低版本是 `22.19.0`。下面示例假定使用 ESM，并通过 `tsx` 或项目自己的 TypeScript 运行器执行。

### 最短可用示例

先设置一个内置 Provider 的密钥，例如：

```bash
export OPENAI_API_KEY='sk-...'
```

保存为 `quick-start.ts`：

```typescript
import { Type, type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

// 注册全部内置 Provider。它会加载完整内置目录，适合 CLI、服务端和调试。
const models = builtinModels();

const model = models.getModel('openai', 'gpt-4o-mini');
if (!model) throw new Error('OpenAI model not found in the built-in catalog');

const getTime: Tool = {
  name: 'get_time',
  description: 'Get the current time in a timezone.',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'IANA timezone, for example UTC' })),
  }),
};

const context: Context = {
  systemPrompt: 'You are a concise assistant.',
  messages: [
    { role: 'user', content: 'What time is it in UTC?', timestamp: Date.now() },
  ],
  tools: [getTime],
};

// 非流式：返回一个最终 AssistantMessage。
const answer = await models.completeSimple(model, context);
console.log(answer.content);

// 流式：每个事件都是有判别字段 type 的联合类型。
const stream = models.stream(model, context);
for await (const event of stream) {
  if (event.type === 'text_delta') process.stdout.write(event.delta);
  if (event.type === 'error') {
    console.error(`\nrequest ${event.reason}: ${event.error.errorMessage ?? 'unknown error'}`);
  }
}
const finalMessage = await stream.result();
console.log('\nstopReason:', finalMessage.stopReason);
```

`models.completeSimple()` 和 `models.stream()` 都会通过模型所属的 Provider 自动解析认证。上例中的 `OPENAI_API_KEY` 不需要手动放入请求选项。

实际 Agent 通常只调用其中一种路径：需要实时 UI 就用 `stream()`/`streamSimple()`；只需要最终结果就用 `complete()`/`completeSimple()`。

## 2. 核心概念

### Provider、Models、Model

可以把三者理解成：

```text
Models 集合
└── Provider: openai
    ├── 模型目录: gpt-4o-mini、...
    ├── 认证: OPENAI_API_KEY / CredentialStore / OAuth
    └── 流式行为: openai-responses
```

- `Provider` 是运行时单元。它拥有 `id`、名称、模型目录、认证策略、模型刷新策略和流式实现。
- `Models` 是 Provider 集合。它按 `model.provider` 找到拥有该模型的 Provider，先处理认证，再把请求转发给 Provider。
- `Model` 是一次请求要选中的模型描述，包含 `id`、`api`、`provider`、上下文窗口、最大输出、是否支持图片/推理、价格和兼容性设置等。

因此，`Models.getModel()` 只做同步目录查找；真正请求时才会解析认证并进入 Provider 的 API 实现。

### API 实现不是 Provider

`api` 表示线协议，也就是最终发给上游的请求/响应格式。常见 API 实现包括：

- `anthropic-messages`：Anthropic Messages 协议。
- `openai-responses`：OpenAI Responses 协议。
- `openai-completions`：OpenAI Chat Completions 兼容协议。

多个供应商可以共用同一个 API 实现。例如 xAI、Groq、Cerebras、OpenRouter，以及许多自建代理都可以使用 `openai-completions`；它们仍然是不同的 Provider，因为认证、模型目录、默认地址和兼容参数可能不同。

混合 Provider 可以按 `model.api` 分发到不同实现：

```typescript
import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  name: 'My Gateway',
  auth: { apiKey: envApiKeyAuth('Gateway API key', ['GATEWAY_API_KEY']) },
  models: [
    // 这里放 api: 'anthropic-messages' 或 api: 'openai-responses' 的 Model。
  ],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});

const models = createModels();
models.setProvider(gateway);
```

### 静态目录与动态 Provider

内置静态目录由生成文件 `src/models.generated.ts` 提供。`getBuiltinModels()` 和内置 Provider 的 `getModels()` 只读这份最近生成的目录，读取是同步的。

动态 Provider 例如本地 `llama.cpp`、会变化的 OpenRouter 目录或企业代理：

- `getModels()` 仍然同步，只返回首次刷新前的空列表，或最近一次缓存/刷新结果。
- `models.refresh({ providers: ['llamacpp'] })` 才会显式触发网络获取。
- `createProvider({ fetchModels })` 会负责恢复、合并和发布动态模型列表。
- `modelsStore` 可持久化上一次目录，让应用重启后先展示缓存。

注意：`checkAuth()`/`getAuth()` 不等于 `/models` 探测；它们主要检查密钥、OAuth 或环境配置是否可解析。

## 3. 查模型与选模型

### 同步查找

```typescript
const providers = models.getProviders();
const openai = models.getProvider('openai');

const allModels = models.getModels();
const openaiModels = models.getModels('openai');
const model = models.getModel('openai', 'gpt-4o-mini');

for (const item of openaiModels) {
  console.log({
    id: item.id,
    name: item.name,
    api: item.api,
    contextWindow: item.contextWindow,
    vision: item.input.includes('image'),
    reasoning: item.reasoning,
  });
}
```

动态查找的返回类型是 `Model<Api>`。如果要使用某个 API 的专属选项，用 `hasApi()` 做类型收窄：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const model = models.getModel('anthropic', 'claude-sonnet-4-5');
if (model && hasApi(model, 'anthropic-messages')) {
  await models.complete(model, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 2048,
  });
}
```

### 静态内置目录的强类型读取

如果不需要先创建 `Models` 集合，只想从生成目录读取：

```typescript
import {
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini');
const openaiModels = getBuiltinModels('openai');
const providerIds = getBuiltinProviders();
```

### 动态目录刷新

```typescript
await models.refresh({ providers: ['llamacpp'] });
const freshModel = models.getModel('llamacpp', 'qwen3-30b');

const result = await models.refresh();
for (const [providerId, error] of result.errors) {
  console.error(`refresh ${providerId} failed`, error);
}
if (result.aborted) console.log('model refresh aborted');
```

### 推理等级

`getSupportedThinkingLevels()` 返回模型真正暴露的等级；不支持推理的模型返回 `['off']`。`xhigh` 和 `max` 是模型目录显式声明后才会出现的可选等级。

```typescript
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';

const levels = getSupportedThinkingLevels(model);
console.log(levels); // 例如 ['off', 'minimal', 'low', 'medium', 'high']
```

### Strict 与 grammar 约束

工具可以请求 Provider 侧的结构化约束：

```typescript
const strictTool: Tool = {
  name: 'edit_file',
  description: 'Edit a file.',
  parameters: Type.Object(
    { path: Type.String(), content: Type.String() },
    { additionalProperties: false },
  ),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' },
};
```

- `strict: 'prefer'`：支持时启用，不支持时退回普通工具调用。
- `strict: 'require'`：不支持或 schema 不满足约束时直接失败。
- `constrainedSampling: false`：明确关闭。

OpenAI grammar 工具的 schema 必须是只有一个必填字符串属性的对象：

```typescript
const patchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a patch.',
  parameters: Type.Object(
    { input: Type.String() },
    { additionalProperties: false },
  ),
  constrainedSampling: {
    type: 'grammar',
    variants: { openai_lark: 'start: /.+/s' },
  },
};
```

### 按需导入 Provider

`builtinModels()` 会加载全部 Provider、目录和实现，最方便但包体较大。应用只需要几个供应商时，按 Provider 工厂导入：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

每个工厂只导入自身目录和 lazy API wrapper，适合 Web bundler 的 tree-shaking 和代码分割。

## 4. 认证

### 环境变量与优先级

常用内置 Provider 的环境变量如下：

| Provider | 环境变量 |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY`、`ANTHROPIC_OAUTH_TOKEN`；另支持 `ANTHROPIC_AUTH_TOKEN` Bearer 头 |
| Google Gemini | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY`，或 `GOOGLE_CLOUD_PROJECT`/`GCLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` + ADC |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| MiniMax Global | `MINIMAX_API_KEY` |
| MiniMax China | `MINIMAX_CN_API_KEY` |
| Moonshot | `MOONSHOT_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| OpenCode | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

对 `envApiKeyAuth(name, envVars)` 这种标准认证，解析优先级是：

1. 该 Provider 的 `CredentialStore` 中已有 `api_key` 凭据的 `key`。
2. 如果没有已存凭据，按 `envVars` 数组顺序取第一个有值的环境变量。
3. 如果都没有值，则 Provider 未配置。

例如 `envApiKeyAuth('My proxy', ['MY_PROXY_API_KEY', 'OPENAI_API_KEY'])` 会先读 `MY_PROXY_API_KEY`，而不是随机选择。

内置 Provider 可以有特殊解析规则。Anthropic 会优先使用已存 key；没有已存 key 时先处理 `ANTHROPIC_AUTH_TOKEN`，再尝试 `ANTHROPIC_OAUTH_TOKEN` 和 `ANTHROPIC_API_KEY`。不要假设所有 Provider 的环境变量顺序都相同。

已保存凭据会“拥有”这个 Provider：如果保存的 OAuth 已失效或保存的凭据类型与 Provider 不匹配，不能静默回退到另一个环境变量。这样可以避免 Provider A 的 URL 误配 Provider B 的密钥。

浏览器中不要依赖 `process.env`，应在服务端解析密钥，或者每次请求显式传递 `apiKey`；不要把真实密钥下发到前端。

### CredentialStore 契约

`CredentialStore` 是应用负责实现的持久化边界。pi-ai 自带 `InMemoryCredentialStore`，生产应用应注入自己的安全存储：

```typescript
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

const credentials: CredentialStore = {
  async read(providerId) {
    // 从 Keychain、加密文件或数据库读取。
    return undefined;
  },
  async list() {
    // 只能返回非敏感元数据，不返回 key。
    return [];
  },
  async modify(providerId, fn) {
    // 必须是串行的 read-modify-write；OAuth 刷新依赖这个锁。
    const current = await this.read(providerId);
    const next = await fn(current);
    if (next !== undefined) await saveCredential(providerId, next);
    return next ?? current;
  },
  async delete(providerId) {
    await deleteCredential(providerId);
  },
};

const models = createModels({ credentials });
```

上面的 `saveCredential`/`deleteCredential` 是应用自己的存储函数，不是 pi-ai 的导出。真实实现应注意：

- `read(providerId)` 没有凭据时返回 `undefined`。
- `list()` 只返回 `{ providerId, type }`，不能执行密钥命令或泄露 secret。
- `modify()` 是唯一写入入口，按 Provider 串行化。
- `delete()` 与 `modify()` 也要互斥。
- 方法可以接受可选的 `{ signal?: AbortSignal }`。

API key 凭据的真实形状是：

```typescript
const credential = {
  type: 'api_key',
  key: 'sk-...',
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id',
  },
} as const;
```

### getAuth、checkAuth、getAvailable

```typescript
const auth = await models.getAuth(model);
if (!auth) {
  console.log('没有可用认证');
} else {
  console.log('认证来源:', auth.source); // 例如 OPENAI_API_KEY / stored credential / OAuth
  console.log('已解析 header:', auth.auth.headers);
}

const check = await models.checkAuth('openai');
console.log(check); // undefined，或 { source, type: 'api_key' | 'oauth' }

const availableModels = await models.getAvailable('openai');
console.log(availableModels.map((item) => item.id));
```

这里的 `checkAuth()` 和 `getAvailable()` 是“配置检查”和“按已配置 Provider 过滤目录”，不是连通性探测。要验证 HTTP `/models`，应调用动态 Provider 的 `fetchModels`，见第 8 节。

### OAuth 与 `/login`

命令行可以直接使用包提供的登录入口：

```bash
npx @earendil-works/pi-ai login
npx @earendil-works/pi-ai login anthropic
npx @earendil-works/pi-ai list
```

程序内的登录由应用提供 `AuthInteraction`，然后调用 Provider 自己的登录流程：

```typescript
const credential = await models.login('anthropic', 'oauth', {
  async prompt(prompt) {
    // UI 根据 prompt.type 展示 text/secret/select/manual_code 输入。
    return await askUser(prompt.message);
  },
  notify(event) {
    console.log(event);
  },
});

console.log(credential.type); // 'oauth'
const auth = await models.getAuth('anthropic'); // 后续请求会自动刷新 OAuth
await models.logout('anthropic');
```

`askUser` 是应用自己的交互实现；OAuth Provider 的登录/刷新实现由 pi-ai 持有，`Models` 会通过 `CredentialStore.modify()` 串行刷新 token。

## 5. 工具调用

### 用 TypeBox 定义 Tool

```typescript
import { Type, StringEnum, type Static, type Tool } from '@earendil-works/pi-ai';

const weatherTool = {
  name: 'get_weather',
  description: 'Get current weather for a city.',
  parameters: Type.Object({
    city: Type.String({ minLength: 1 }),
    units: StringEnum(['celsius', 'fahrenheit'] as const, { default: 'celsius' }),
  }),
} satisfies Tool;

type WeatherArgs = Static<typeof weatherTool.parameters>;

const args: WeatherArgs = { city: 'Shanghai', units: 'celsius' };
```

必须优先使用 `StringEnum([...])`，不要使用 `Type.Enum()`。`StringEnum` 生成 Google 兼容的 `string + enum` schema；`Type.Enum` 可能生成 Google 不接受的 `anyOf/const` 结构。

### `complete()` → 执行工具 → 压回结果 → 再 complete

```typescript
const context: Context = {
  messages: [{ role: 'user', content: '上海现在天气如何？', timestamp: Date.now() }],
  tools: [weatherTool],
};

async function fetchWeather(city: string, units: string): Promise<{ city: string; units: string; temperature: number }> {
  // 这里替换成真实天气服务；工具结果只作为示例返回给模型。
  return { city, units, temperature: 23 };
}

const assistant = await models.complete(model, context);
context.messages.push(assistant);

for (const block of assistant.content) {
  if (block.type !== 'toolCall') continue;

  const result = await fetchWeather(block.arguments.city, block.arguments.units);
  context.messages.push({
    role: 'toolResult',
    toolCallId: block.id,
    toolName: block.name,
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: false,
    timestamp: Date.now(),
  });
}

if (assistant.stopReason === 'toolUse') {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
}
```

工具结果必须保留 `toolCallId` 和 `toolName`，这样上游协议才能把结果关联回对应调用。结果内容是文本/图片 content block 数组，不是旧版 OpenAI 的裸 `role: 'tool'` 字符串。

### 流式 tool call 与部分 JSON

```typescript
const stream = models.stream(model, context);

for await (const event of stream) {
  if (event.type === 'toolcall_start') {
    console.log('tool index:', event.contentIndex);
  }

  if (event.type === 'toolcall_delta') {
    const block = event.partial.content[event.contentIndex];
    if (block?.type === 'toolCall') {
      // arguments 是尽力解析的部分对象，字段可能缺失、字符串可能被截断。
      const path = block.arguments.path;
      if (typeof path === 'string') console.log('current path:', path);
    }
  }

  if (event.type === 'toolcall_end') {
    // 这里 JSON 已经组装完成，但还没有通过 schema 校验。
    console.log(event.toolCall.name, event.toolCall.arguments);
  }
}

const assistant = await stream.result();
```

防御规则：

- `toolcall_delta` 中的 `arguments` 永远按不完整对象处理，不要直接执行。
- 用 `contentIndex` 关联块，不要假设 text/thinking/toolcall 事件一定连续。
- Google 不提供逐片段函数调用流，可能只发一个包含完整参数的 `toolcall_delta`。
- 真正执行应等 `toolcall_end` 或 `stream.result()` 后再做校验。

### `validateToolCall()` 与可恢复错误

```typescript
import { validateToolCall } from '@earendil-works/pi-ai';

try {
  const validated = validateToolCall(context.tools ?? [], block);
  const output = await executeTool(block.name, validated);

  context.messages.push({
    role: 'toolResult',
    toolCallId: block.id,
    toolName: block.name,
    content: [{ type: 'text', text: output }],
    isError: false,
    timestamp: Date.now(),
  });
} catch (error) {
  // 让模型知道参数错了，并保留 isError，让它在下一轮修正。
  context.messages.push({
    role: 'toolResult',
    toolCallId: block.id,
    toolName: block.name,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
    timestamp: Date.now(),
  });
}
```

`validateToolCall()` 会查找工具并依据 TypeBox schema 校验/转换参数，失败会抛异常。`isError: true` 是“工具调用失败但对话仍可继续”的信号；不要把这类错误直接当作整个 Agent 任务的 fatal error。

对于 PayasoAgent，pi-ai 的 schema 校验不能替代现有的权限、网络、审批、side-effect 和 workspace 路径校验。安全策略仍应在 Runtime 执行工具前再次裁决。

## 6. 流式与思考

### 事件协议

成功流：`start → updates* → done`；生成中途失败：`start → updates* → error`；请求设置阶段就失败时可以直接只有 `error`。

| 事件 | 作用 | 关键字段 |
| --- | --- | --- |
| `start` | 流开始 | `partial`，初始 AssistantMessage |
| `text_start` | 文本块开始 | `contentIndex` |
| `text_delta` | 文本增量 | `delta`、`contentIndex` |
| `text_end` | 文本块完成 | `content`、`contentIndex` |
| `thinking_start` | 思考块开始 | `contentIndex` |
| `thinking_delta` | 思考增量 | `delta`、`contentIndex` |
| `thinking_end` | 思考块完成 | `content`、`contentIndex` |
| `toolcall_start` | 工具调用开始 | `contentIndex` |
| `toolcall_delta` | 工具参数增量 | `delta`、部分 `arguments` |
| `toolcall_end` | 工具调用完成 | 完整但未校验的 `toolCall` |
| `done` | 正常结束 | `reason`、最终 `message` |
| `error` | 错误/中断结束 | `reason`、部分 `error` AssistantMessage |

`partial` 是共享的“当前响应”对象，不保证是事件发生时的不可变快照。事件可能交错，必须使用 `contentIndex`，不要把旧的 `partial` 当作历史快照保存。

`done.reason` 可以是 `stop`、`length`、`toolUse` 或 `deferred`；最终消息还包含 `usage`、`stopReason`、可选 `responseId` 和 `errorMessage`。

### reasoning 的统一接口

```typescript
const response = await models.completeSimple(model, context, {
  reasoning: 'medium', // minimal | low | medium | high | xhigh | max
});

const stream = models.streamSimple(model, context, { reasoning: 'high' });
for await (const event of stream) {
  if (event.type === 'thinking_delta') process.stdout.write(event.delta);
}
const result = await stream.result();
```

如果模型不支持推理，相关选项会被忽略；生产 UI 应先调用 `getSupportedThinkingLevels(model)` 再展示选择项。

### API 专属选项与类型收窄

`stream()`/`complete()` 是 API 级别的完整接口。通过 `hasApi()` 后，TypeScript 才能安全看到专属选项：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

if (hasApi(model, 'anthropic-messages')) {
  await models.complete(model, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192,
  });
}

if (hasApi(model, 'openai-responses')) {
  await models.complete(model, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed',
  });
}
```

不同 Provider 的专属字段不要在未收窄的 `Model<Api>` 上强行 `as any`。OpenAI-compatible 本地服务的思考参数还可以通过模型的 `compat` 与 `thinkingBudgets` 配置映射到服务端字段。

## 7. 错误处理、中断与调试

### 流式错误不抛异常

流已经创建后，Provider 请求错误会进入 `error` 事件；最终 `s.result()` 返回的 AssistantMessage 会带：

- `stopReason: 'error'` 或 `'aborted'`；
- `errorMessage`；
- 已经收到的部分 `content` 和 `usage`。

```typescript
const stream = models.stream(model, context);
for await (const event of stream) {
  if (event.type === 'error') {
    console.error(event.reason, event.error.errorMessage);
  }
}

const message = await stream.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error(message.errorMessage);
}
```

直接调用底层 API 的 `streamSimple()` 时，缺少请求认证可能同步抛出；通过 `Models` 集合调用时，认证/Provider 错误会进入统一流错误协议。

### AbortSignal 与截断后继续

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 2_000);

const partial = await models.complete(model, context, {
  signal: controller.signal,
});

if (partial.stopReason === 'aborted') {
  context.messages.push(partial);
  context.messages.push({
    role: 'user',
    content: 'Please continue from the partial answer.',
    timestamp: Date.now(),
  });
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
}
```

工具执行也应该共享同一个 `AbortSignal`，这样用户点击停止时不会只停 LLM、却继续执行 shell 或网络工具。

### `onPayload` 查看真实请求体

```typescript
await models.complete(model, context, {
  onPayload(payload, requestModel) {
    console.log('model:', requestModel.id);
    console.dir(payload, { depth: null });
  },
});
```

`onPayload` 支持 `stream`、`complete`、`streamSimple`、`completeSimple`。调试日志必须脱敏，不要打印 `apiKey`、Authorization header、用户隐私和完整大段上下文到生产日志。

## 8. 自定义 Provider：Ollama、vLLM 和本地代理

### 固定模型目录

`createProvider()` + `openAICompletionsApi()` 可以接任何 OpenAI Chat Completions 兼容服务：

```typescript
import {
  createModels,
  createProvider,
  type Model,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const localModel: Model<'openai-completions'> = {
  id: 'llama3.1:8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 32_000,
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // 无密钥本地服务也必须声明 auth 语义。
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [localModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

const model = models.getModel('ollama', 'llama3.1:8b');
if (!model) throw new Error('local model not found');
const answer = await models.complete(model, {
  messages: [{ role: 'user', content: 'Say hello.', timestamp: Date.now() }],
});
console.log(answer.content);
```

有密钥的代理可复用标准解析：

```typescript
import { envApiKeyAuth } from '@earendil-works/pi-ai';

const proxyAuth = envApiKeyAuth('Local proxy API key', ['LOCAL_PROXY_API_KEY']);
```

### `fetchModels` 动态目录与 `modelsStore`

```typescript
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const llamacpp = createProvider<'openai-completions'>({
  id: 'llamacpp',
  name: 'llama.cpp',
  baseUrl: 'http://localhost:8080/v1',
  auth: { apiKey: envApiKeyAuth('llama.cpp key', ['LLAMACPP_API_KEY']) },
  models: [],
  fetchModels: async ({ signal, credential }) => {
    const key = credential?.type === 'api_key' ? credential.key : undefined;
    const response = await fetch('http://localhost:8080/v1/models', {
      signal,
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    });
    if (!response.ok) throw new Error(`GET /models failed: ${response.status}`);

    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).flatMap((item): Model<'openai-completions'>[] => {
      if (!item.id) return [];
      return [{
        id: item.id,
        name: item.id,
        api: 'openai-completions',
        provider: 'llamacpp',
        baseUrl: 'http://localhost:8080/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 8_000,
      }];
    });
  },
  api: openAICompletionsApi(),
});

const models = createModels({
  // 默认是 InMemoryModelsStore；生产环境可传自己的持久化实现。
  modelsStore: persistentModelsStore,
});
models.setProvider(llamacpp);

// 读取缓存并触发网络刷新；错误按 Provider 返回，不会影响其它 Provider。
const result = await models.refresh({ providers: ['llamacpp'] });
console.log(result.errors);
console.log(models.getModels('llamacpp'));
```

`ModelsStore` 的真实契约是：

```typescript
import type { ModelsStore } from '@earendil-works/pi-ai';

const persistentModelsStore: ModelsStore = {
  async read(providerId, options) {
    options?.signal?.throwIfAborted();
    return await readJsonCatalog(providerId);
  },
  async write(providerId, entry, options) {
    options?.signal?.throwIfAborted();
    await writeJsonCatalog(providerId, entry);
  },
  async delete(providerId, options) {
    options?.signal?.throwIfAborted();
    await deleteJsonCatalog(providerId);
  },
};
```

上例中的 `readJsonCatalog`/`writeJsonCatalog`/`deleteJsonCatalog` 是应用自己的持久化函数。`ModelsStoreEntry` 会保存模型数组，以及可选的 `checkedAt`、`lastModified`、`etag`。

### OpenAI 兼容性设置

自建服务不一定完全支持 OpenAI 字段，可以在 Model 上声明：

```typescript
const vllmModel: Model<'openai-completions'> = {
  // 其它必填字段略，实际代码必须完整填写 Model。
  id: 'qwen',
  name: 'Qwen on vLLM',
  api: 'openai-completions',
  provider: 'vllm',
  baseUrl: 'http://localhost:8000/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 8_000,
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
  },
};
```

`samplingParams` 可以透传 `top_p`、`top_k`、`min_p`、`repetition_penalty` 等 pi-ai 没有命名建模的 OpenAI-compatible 参数。不要为了适配一个服务在全局修改其它 Provider 的请求格式。

## 9. 图片能力

图片生成是独立的一次性接口，不使用聊天的 `Models`/`stream`/`complete`：

```typescript
import { builtinImagesModels } from '@earendil-works/pi-ai/providers/all';

const imagesModels = builtinImagesModels();
const imageModel = imagesModels.getModel(
  'openrouter',
  'google/gemini-2.5-flash-image',
);
if (!imageModel) throw new Error('image model not found');

const result = await imagesModels.generateImages(imageModel, {
  input: [{ type: 'text', text: 'Generate a red circle on a white background.' }],
});

if (result.stopReason === 'error') {
  console.error(result.errorMessage);
}
for (const block of result.output) {
  if (block.type === 'image') {
    console.log(block.mimeType, block.data.slice(0, 32));
  }
}
```

目前内置图片生成 Provider 是 OpenRouter。图片模型与文本模型目录分离；图片生成模型也不参与工具调用。模型能力可以通过 `model.input` 和 `model.output` 判断。

## 10. 完整 Demo：定义工具 → 流式调用 → 执行工具 → 续聊

下面代码可以作为 `tool-loop.ts` 运行。它使用真实的 `Models` 流式协议，等待最终的 `toolCall` 后进行 TypeBox 校验，执行工具，把 `toolResult` 写回同一个 `Context`，然后继续请求。

```typescript
import {
  Type,
  type Context,
  type Tool,
  validateToolCall,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels();
const model = models.getModel('openai', 'gpt-4o-mini');
if (!model) throw new Error('Model openai/gpt-4o-mini was not found');

const getTimeTool: Tool = {
  name: 'get_time',
  description: 'Get the current local time for an IANA timezone.',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'For example Asia/Shanghai or UTC' })),
  }),
};

const tools = [getTimeTool];
const context: Context = {
  systemPrompt: [
    'You are a helpful assistant.',
    'When the user asks for the current time, call get_time first.',
    'After receiving the tool result, answer in one short sentence.',
  ].join(' '),
  messages: [
    { role: 'user', content: '现在上海几点？', timestamp: Date.now() },
  ],
  tools,
};

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name !== 'get_time') throw new Error(`Unknown tool: ${name}`);

  const timezone = typeof args.timezone === 'string' && args.timezone
    ? args.timezone
    : 'UTC';
  const text = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(new Date());
  return JSON.stringify({ timezone, currentTime: text });
}

async function main(): Promise<void> {
  const stream = models.stream(model, context);

  for await (const event of stream) {
    switch (event.type) {
      case 'start':
        console.log(`[start] ${event.partial.model}`);
        break;
      case 'text_delta':
        process.stdout.write(event.delta);
        break;
      case 'thinking_delta':
        // 生产 UI 可以单独展示；示例默认不打印思考内容。
        break;
      case 'toolcall_delta': {
        const block = event.partial.content[event.contentIndex];
        if (block?.type === 'toolCall') {
          // 这里只用于 UI 预览，不能在这里执行。
          console.error(`[tool args partial] ${block.name}`);
        }
        break;
      }
      case 'toolcall_end':
        console.error(`[tool ready] ${event.toolCall.name}`);
        break;
      case 'error':
        console.error(`[stream ${event.reason}]`, event.error.errorMessage);
        break;
      case 'done':
        console.error(`[done] ${event.reason}`);
        break;
    }
  }

  // 只有最终消息才能作为 assistant turn 写回上下文。
  const assistant = await stream.result();
  context.messages.push(assistant);

  const calls = assistant.content.filter(
    (block): block is Extract<(typeof assistant.content)[number], { type: 'toolCall' }> =>
      block.type === 'toolCall',
  );

  for (const call of calls) {
    try {
      const args = validateToolCall(tools, call) as Record<string, unknown>;
      const output = await executeTool(call.name, args);
      context.messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: output }],
        isError: false,
        timestamp: Date.now(),
      });
    } catch (error) {
      // 失败回给模型，而不是把对话直接丢掉；模型可以修正参数后重试。
      context.messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{
          type: 'text',
          text: error instanceof Error ? error.message : String(error),
        }],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }

  if (calls.length > 0) {
    const continuation = await models.complete(model, context);
    context.messages.push(continuation);
    for (const block of continuation.content) {
      if (block.type === 'text') console.log('\n' + block.text);
    }
  }
}

await main();
```

执行：

```bash
OPENAI_API_KEY='sk-...' npx tsx tool-loop.ts
```

## 11. PayasoAgent 的接入方案

### 当前项目现状

当前 PayasoAgent 没有依赖 `@earendil-works/pi-ai`。现状是：

- `/Users/luweiliang/Downloads/myProject/payaso_agent/src/llm/llm.ts` 自己通过 `fetch` 调 OpenAI-compatible `/chat/completions`。
- `src/runtime/agent.ts` 维护 Agent Loop、checkpoint、重试、中断和工具续聊。
- `src/tools/tools.ts` 维护工具 schema、workspace 路径、安全策略、网络能力、审批和副作用身份。
- `src/host/provider-url.ts` 与 `src/host/available-models.ts` 已经单独处理 Provider 的 `/models` 目录获取。
- Provider 设置/密钥持久化在 `src/host/persistence` 和 `src/host/secrets`，并且当前设计会避免把原始 API key 放进设置响应、trace 或日志。

因此不建议把 PayasoAgent 的 Runtime 安全层直接替换成 pi-ai 的工具循环。推荐把 pi-ai 作为“模型协议/认证/目录层”，继续保留 PayasoAgent 的 Runtime 安全裁决。

### 推荐的三阶段迁移

#### 阶段 A：先接 Provider、认证和模型目录

1. 在 Host 端安装 `@earendil-works/pi-ai`；不要把带密钥的 `Models` 对象放进 Web 前端。
2. 保留当前设置页和 `SecretStore`，实现一个 `CredentialStore` adapter：
   - `read(providerId)` 从当前加密 secret store 返回 `{ type: 'api_key', key }`；
   - `list()` 只返回 providerId/type；
   - `modify()` 走现有安全存储的原子写入；
   - `delete()` 清理对应 provider 密钥。
3. 用 `createProvider()` 把当前 `ModelProviderView` 转成 pi-ai `Provider`：
   - `id` 对应当前不可变 providerId；
   - `models` 把当前 model ID 转成完整 `Model` 元数据；
   - OpenAI-compatible Provider 使用 `openAICompletionsApi()`；
   - 原生 Responses Provider 才使用 `openAIResponsesApi()`；
   - `baseUrl` 统一为 API 根地址，避免重复拼接 `/chat/completions`。
4. 把当前 `/models` 获取逻辑放进 `fetchModels`，调用 `models.refresh({ providers: [id] })`，并将结果写入 `modelsStore`。这样 UI 可以分别显示：
   - “已配置”：`checkAuth()`；
   - “已检测”：`models.refresh()` 的成功/失败；
   - “可用模型”：`models.getModels(id)` 或 `getAvailable(id)`。

这里尤其要避免把 `checkAuth()` 的结果显示成“已检测”。它只表示密钥能解析，不会自动请求 `/models`。

#### 阶段 B：只替换 LLM 请求适配，不动 Runtime

增加类似 `src/llm/pi-ai-llm.ts` 的 Host-side adapter：

```typescript
import { createModels, createProvider, type Context, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

// 伪代码：providerConfig 来自当前 Run 的完整 provider/model 快照，
// secret 只在 Host 内部取，不进入前端或 trace。
export function createConfiguredModels(providerConfig: {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: Model<'openai-completions'>;
}) {
  const provider = createProvider({
    id: providerConfig.id,
    name: providerConfig.name,
    baseUrl: providerConfig.baseUrl,
    auth: {
      apiKey: {
        name: `${providerConfig.name} API key`,
        resolve: async () => ({
          auth: { apiKey: providerConfig.apiKey },
          source: 'PayasoAgent SecretStore',
        }),
      },
    },
    models: [providerConfig.model],
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);
  return models;
}
```

实际实现不能把 `apiKey` 写入日志或返回给浏览器；上例只说明 Provider 形状。Run 启动时继续使用现有的完整 `{ providerId, baseUrl, apiKey, model }` 原子快照，避免 provider URL 与另一家的 secret 串用。

之后把当前 `chat(...)` 的请求转换为：

```typescript
const model = models.getModel(providerId, modelId);
if (!model) throw new Error('model is not in the provider catalog');

const context: Context = {
  systemPrompt,
  messages: piMessages,
  tools: piTools,
};

const stream = models.stream(model, context, { signal });
for await (const event of stream) {
  if (event.type === 'text_delta') onDelta?.(event.delta);
}
const assistant = await stream.result();
```

这一步建议先保留现有 `src/runtime/agent.ts` 的 checkpoint 和安全策略，只写一个消息/工具格式 adapter：

- 旧 `assistant.tool_calls[].function.arguments` 是 JSON 字符串；pi-ai `ToolCall.arguments` 已经是对象。
- 旧 `role: 'tool'` 要转换为 pi-ai 的 `role: 'toolResult'` content block。
- pi-ai 的 `validateToolCall()` 负责 schema 校验；PayasoAgent 仍要继续做工具不存在、路径、网络、审批、side-effect 和取消检查。
- pi-ai `error`/`aborted` 事件要映射到现有 Run 状态和 checkpoint，而不是当作普通文本。

#### 阶段 C：让 Runtime 使用 pi-ai 的完整流式协议

最后才把 `src/llm/llm.ts` 的自定义 SSE 拼装替换为 pi-ai 的 `text_delta`、`thinking_delta`、`toolcall_end` 和 `done/error` 事件。这样可以消除当前项目自己维护的多 Provider tool-call 拼装差异，但仍由 `src/runtime/agent.ts` 决定：

- 工具是否允许执行；
- 是否需要用户批准；
- 是否可以重试；
- checkpoint 如何落盘；
- 工作区路径和网络能力如何限制。

### 和当前 `/models` UI 的对应关系

建议将设置页状态拆成三个独立字段：

```text
认证状态      checkAuth() / getAuth()       已配置 / 未配置
连通性状态    models.refresh() 或探测请求    已检测 / 检测失败 / 未检测
模型目录      getModels(providerId)         最近成功目录 / 空目录
```

对于当前项目，动态 Provider 的 `fetchModels` 应复用现有 `provider-url.ts` 的安全请求策略，至少保留：超时、非 2xx 错误、JSON 结构校验、模型 ID 去重、API key 不进入日志，以及“刷新失败保留旧目录”。

### 接入结论

最稳妥的落地方式是：

1. 先接 `createProvider`/`fetchModels`/`CredentialStore`，解决“已配置、已检测、模型目录”三种状态混淆。
2. 再用 `openAICompletionsApi()` 替换现有 `fetch /chat/completions`，保持当前 Runtime 的工具安全和 checkpoint。
3. 最后迁移到完整的 pi-ai 流式事件和 TypeBox Tool 定义。

不建议第一步就把当前 `src/runtime/agent.ts` 和 `src/tools/tools.ts` 整体改成 pi-ai 的简单示例，因为这会同时改变权限、审批、重试、checkpoint 和消息持久化协议，风险远高于先替换 Provider/LLM 适配层。
