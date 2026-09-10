import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SettingsStore } from '../src/host/persistence/settings-store.js';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import {
  getPiAiProviderBaseUrl,
  getPiAiProviderModel,
  listPiAiProviderCatalog,
} from '../src/host/pi-ai-providers.js';
import { RunManager } from '../src/host/run-manager.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { createHostServer } from '../src/host/server.js';
import { chat } from '../src/llm/llm.js';

const catalog = listPiAiProviderCatalog();
assert.ok(catalog.length > 0, 'pi-ai catalog should expose at least one API-key provider');
assert.equal(new Set(catalog.map((provider) => provider.id)).size, catalog.length);

const minimax = catalog.find((provider) => provider.id === 'minimax-cn');
assert.ok(minimax, 'MiniMax CN should be available in the pi-ai catalog');
assert.equal(minimax.baseUrl, 'https://api.minimaxi.com/anthropic');
assert.ok(minimax.models.length > 0);
assert.ok(minimax.models.every((model) => model.contextWindow > 0));
assert.ok(minimax.models.every((model) => model.maxOutputTokens > 0));

const resolved = getPiAiProviderModel('minimax-cn', minimax.models[0].id);
assert.ok(resolved, 'a catalog model should resolve to its pi-ai provider runtime');
assert.equal(resolved.model.api, minimax.models[0].api);
assert.equal(resolved.model.contextWindow, minimax.models[0].contextWindow);
assert.equal(resolved.model.maxTokens, minimax.models[0].maxOutputTokens);
assert.equal(resolved.model.provider, 'minimax-cn');
assert.equal(getPiAiProviderModel('missing-provider', 'missing-model'), undefined);

// 思考档次：catalog 模型应暴露其真正支持的档次列表（off 恒在列）。
// DeepSeek 注册表声明 minimal/medium/xhigh 不可用，只应有 off/low/high/max。
{
  const deepseek = catalog.find((provider) => provider.id === 'deepseek');
  assert.ok(deepseek, 'DeepSeek should be available in the pi-ai catalog');
  const reasoningModel = deepseek.models.find((model) => model.reasoning);
  assert.ok(reasoningModel, 'DeepSeek should expose a reasoning model');
  assert.ok(
    Array.isArray(reasoningModel.thinkingLevels) && reasoningModel.thinkingLevels.length > 0,
    'a reasoning model should expose supported thinking levels',
  );
  assert.ok(
    reasoningModel.thinkingLevels.includes('off'),
    'supported thinking levels must always include off',
  );
  assert.ok(
    !reasoningModel.thinkingLevels.includes('xhigh') ||
      deepseek.models.every(
        (m) => !m.thinkingLevels?.includes('xhigh') || m.reasoning,
      ),
    'xhigh should only appear when explicitly declared by the registry',
  );
  const nonReasoning = deepseek.models.find((model) => !model.reasoning);
  if (nonReasoning) {
    assert.deepEqual(
      nonReasoning.thinkingLevels,
      ['off'],
      'non-reasoning models only support off',
    );
  }
}

// provider 级无 baseUrl 的 provider（如 opencode-go）也必须放出来：
// 地址写在每个 model 上，由 Host 在保存/调用时按模型解析。目录只暴露能用标准 HTTP API
// + 现成 https 端点跑通的模型，故 bedrock/azure/vertex/cloudflare 自然落选。
const opencodeGo = catalog.find((provider) => provider.id === 'opencode-go');
assert.ok(opencodeGo, 'opencode-go (per-model baseUrl) should be released into the catalog');
assert.equal(opencodeGo.baseUrl, '', 'opencode-go has no provider-level baseUrl');
assert.ok(opencodeGo.models.length > 0);
assert.ok(
  opencodeGo.models.every((model) =>
    ['anthropic-messages', 'openai-completions', 'openai-responses'].includes(model.api),
  ),
  'released models must use standard HTTP APIs with model-resolvable endpoints',
);
const ogResolved = getPiAiProviderModel('opencode-go', opencodeGo.models[0].id);
assert.ok(ogResolved, 'an opencode-go catalog model should resolve at runtime');
assert.equal(ogResolved.model.provider, 'opencode-go');
assert.equal(
  getPiAiProviderBaseUrl('opencode-go', opencodeGo.models[0].id),
  ogResolved.model.baseUrl,
  'a model-level baseUrl should be resolved for runtime calls',
);
const opencodeGoOpenAi = opencodeGo.models.find((model) => model.api === 'openai-completions');
assert.ok(opencodeGoOpenAi, 'opencode-go should expose an OpenAI-compatible model');
const ogOpenAiResolved = getPiAiProviderModel('opencode-go', opencodeGoOpenAi.id);
assert.ok(ogOpenAiResolved, 'the OpenAI-compatible model should resolve at runtime');

// 回归保护：内置 Provider 保存请求可以省略 baseUrl，但保存后的凭证仍返回可调用地址。
{
  const db = new DatabaseSync(':memory:');
  const settings = new SettingsStore(db, new MemorySecretStore());
  const saved = settings.addModel({
    name: 'OpenCode Go',
    piProviderId: 'opencode-go',
    apiKey: 'sk-opencode-test',
    models: [opencodeGo.models[0].id, opencodeGoOpenAi.id],
  });
  assert.equal(saved.baseUrl, ogResolved.model.baseUrl);
  const credentials = settings.getProviderCredentials(saved.id, opencodeGo.models[0].id);
  assert.equal(credentials?.baseUrl, ogResolved.model.baseUrl);
  assert.equal(credentials?.apiKey, 'sk-opencode-test');
  const openAiCredentials = settings.getProviderCredentials(saved.id, opencodeGoOpenAi.id);
  assert.equal(openAiCredentials?.baseUrl, ogOpenAiResolved.model.baseUrl);
  const updated = settings.updateModel(saved.id, { baseUrl: '' });
  assert.equal(updated?.baseUrl, saved.baseUrl, 'built-in updates ignore an empty baseUrl');
  assert.throws(
    () => settings.updateModel(saved.id, { models: ['not-a-built-in-model'] }),
    /内置提供方不支持模型/,
  );
  db.close();
}

// 回归保护：保存后的模型级地址会一路传到 pi-ai 的实际请求 URL。
{
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  try {
    const result = await chat([{ role: 'user', content: 'hello' }], undefined, undefined, {
      baseUrl: ogOpenAiResolved.model.baseUrl,
      apiKey: 'sk-opencode-test',
      model: opencodeGoOpenAi.id,
      providerId: 'opencode-go-test',
      piProviderId: 'opencode-go',
    });
    assert.equal(result.content, 'ok');
    assert.equal(requestUrl, `${ogOpenAiResolved.model.baseUrl}/chat/completions`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// 回归保护：HTTP 保存请求也允许内置 Provider 省略 baseUrl。
{
  const runtimeStore = new SqliteRunStore(':memory:', new MemorySecretStore());
  const server = createHostServer(
    new RunManager(runtimeStore),
    'test-token-00000000000000000000000000000000',
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/settings/models`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token-00000000000000000000000000000000',
        Origin: `http://localhost:${port}`,
      },
      body: JSON.stringify({
        name: 'OpenCode Go via HTTP',
        piProviderId: 'opencode-go',
        apiKey: 'sk-opencode-http-test',
        models: [opencodeGo.models[0].id],
      }),
    });
    assert.equal(response.status, 201);
    const saved = (await response.json()) as { baseUrl?: string };
    assert.equal(saved.baseUrl, ogResolved.model.baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    runtimeStore.close();
  }
}
assert.ok(
  !catalog.some((provider) => provider.id === 'amazon-bedrock'),
  'bedrock (AWS SigV4) must stay excluded',
);
// 回归保护：有 provider 级 baseUrl 的 provider（如 google，用原生 google API）
// 不能因为「非标准 API」被误删——它们靠 provider baseUrl + 原生 wire 跑通。
assert.ok(
  catalog.some((provider) => provider.id === 'google'),
  'google (provider-level baseUrl + native API) must not regress out of the catalog',
);

console.log(
  `pi-ai provider tests: ${catalog.length} providers, MiniMax ${minimax.models.length} models, opencode-go ${opencodeGo.models.length} models`,
);
