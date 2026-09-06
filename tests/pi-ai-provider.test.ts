import assert from 'node:assert/strict';
import { getPiAiProviderModel, listPiAiProviderCatalog } from '../src/host/pi-ai-providers.js';

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

// provider 级无 baseUrl 的 provider（如 opencode-go）也必须放出来：
// 地址写在每个 model 上，由用户在新增流程手动填入。目录只暴露能用标准 HTTP API
// + 现成 https 端点跑通的模型，故 bedrock/azure/vertex/cloudflare 自然落选。
const opencodeGo = catalog.find((provider) => provider.id === 'opencode-go');
assert.ok(opencodeGo, 'opencode-go (per-model baseUrl) should be released into the catalog');
assert.equal(opencodeGo.baseUrl, '', 'opencode-go has no provider-level baseUrl; user fills it');
assert.ok(opencodeGo.models.length > 0);
assert.ok(
  opencodeGo.models.every((model) =>
    ['anthropic-messages', 'openai-completions', 'openai-responses'].includes(model.api),
  ),
  'released models must use standard HTTP APIs that work with a single user-filled baseUrl',
);
const ogResolved = getPiAiProviderModel('opencode-go', opencodeGo.models[0].id);
assert.ok(ogResolved, 'an opencode-go catalog model should resolve at runtime');
assert.equal(ogResolved.model.provider, 'opencode-go');
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
