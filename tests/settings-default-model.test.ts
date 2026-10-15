// 模块: 默认模型查询/设置（校验矩阵、成对保存、目录校验、存活回归、删除清空）+
//       环境配置一次性导入 + providerId 代拉目录测试
// 用法: npx tsx tests/settings-default-model.test.ts（确定性，无真实网络；SecretStore = Memory）
// 来源: 自原 tests/settings.test.ts 按测试域拆出，用例原样搬移（未改任何测试逻辑与断言）。
// 注: 末尾"providerId 代拉目录"用例依赖前文默认模型域创建的 TouchProvider（带 sk-touch 密钥），
//     故与默认模型用例同属本文件，避免搬移/复制其 setup。

import { DatabaseSync } from 'node:sqlite';
import { SettingsStore } from '../src/host/persistence/settings-store.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import {
  base,
  check,
  delJSON,
  getJSON,
  patchJSON,
  postJSON,
  reportAndExit,
} from './helpers/settings-harness.js';

// ---- 测试开始 ----

(async () => {
  // 17. 设置默认模型：校验矩阵（未知 404 / 空 400 / 未配置密钥 400）
  const unknownDefault = await postJSON(
    `${base}/settings/default`,
    { providerId: 'not-exist', model: 'm' },
    404,
  );
  check('default unknown provider 404', unknownDefault.error === 'not_found');

  const emptyDefault = await postJSON(`${base}/settings/default`, { providerId: '   ' }, 400);
  check('default empty providerId 400', emptyDefault.message === 'providerId is required');

  // 未配置密钥的 provider 设默认 → 400
  const noKeyProv = await postJSON(
    `${base}/settings/models`,
    {
      name: 'NoKeyProvider',
      baseUrl: 'https://api.nokey.com',
      models: ['nk-chat'],
    },
    201,
  );
  const unconfiguredDefault = await postJSON(
    `${base}/settings/default`,
    { providerId: noKeyProv.id, model: 'nk-chat' },
    400,
  );
  check(
    'default unconfigured provider 400',
    unconfiguredDefault.message === 'Provider has no API key configured',
  );

  // 18. 默认模型成对保存（providerId + modelId）+ model 目录校验
  const defaultProvider = await postJSON(
    `${base}/settings/models`,
    {
      name: 'DefaultProvider',
      baseUrl: 'https://api.default-test.com',
      apiKey: 'sk-default-8888',
      models: ['dm-chat', 'dm-reasoner'],
    },
    201,
  );

  const badModelDefault = await postJSON(
    `${base}/settings/default`,
    { providerId: defaultProvider.id, model: 'not-in-catalog' },
    400,
  );
  check(
    'default unknown model 400',
    badModelDefault.message === 'Model "not-in-catalog" is not in provider catalog',
  );

  const okDefault = await postJSON(
    `${base}/settings/default`,
    { providerId: defaultProvider.id, model: 'dm-reasoner' },
    200,
  );
  check(
    'default set returns pair',
    okDefault.defaultProviderId === defaultProvider.id &&
      okDefault.defaultModelId === 'dm-reasoner',
  );

  const currentDefault = await getJSON(`${base}/settings`);
  check(
    'GET settings returns pair',
    currentDefault.defaultProviderId === defaultProvider.id &&
      currentDefault.defaultModelId === 'dm-reasoner',
  );

  // 19. P1 回归：对其它 provider 的 CRUD 不得丢失默认对
  await postJSON(
    `${base}/settings/models`,
    {
      name: 'TouchProvider',
      baseUrl: 'https://api.touch.com',
      apiKey: 'sk-touch',
      models: ['touch-1'],
    },
    201,
  );
  const afterAdd = await getJSON(`${base}/settings`);
  check(
    'default survives addModel',
    afterAdd.defaultProviderId === defaultProvider.id && afterAdd.defaultModelId === 'dm-reasoner',
  );

  await patchJSON(`${base}/settings/models/${defaultProvider.id}`, {
    name: 'DefaultProvider Renamed',
  });
  const afterUpdate = await getJSON(`${base}/settings`);
  check(
    'default survives updateModel',
    afterUpdate.defaultProviderId === defaultProvider.id &&
      afterUpdate.defaultModelId === 'dm-reasoner',
  );

  // 20. 删除默认 provider → 默认对清空（解析时回退第一个可用 provider）
  await delJSON(`${base}/settings/models/${defaultProvider.id}`);
  const afterDelete = await getJSON(`${base}/settings`);
  check(
    'default cleared after deleting default provider',
    afterDelete.defaultProviderId === '' && afterDelete.defaultModelId === '',
  );

  // 21. 环境配置一次性导入（.env → 设置）：新建自定义 Provider 并设为默认
  {
    const store = new SettingsStore(new DatabaseSync(':memory:'), new MemorySecretStore());
    const imported = store.importEnvFallback({
      baseUrl: 'https://api.minimaxi.com/v1',
      apiKey: 'sk-env-test-1234',
      model: 'MiniMax-M3',
    });
    check('env import returns pair', imported !== null && imported.modelId === 'MiniMax-M3');
    const view = imported ? store.listViews().find((p) => p.id === imported.providerId) : undefined;
    check(
      'env import created configured provider',
      !!view && view.hasApiKey && view.models.includes('MiniMax-M3'),
    );
    check(
      'env import set default pair',
      store.getDefaultProviderId() === imported?.providerId &&
        store.getDefaultModelId() === 'MiniMax-M3',
    );

    // 幂等：导入过一次后不再重复（即使传入不同配置）
    const again = store.importEnvFallback({
      baseUrl: 'https://api.other.com/v1',
      apiKey: 'sk-another',
      model: 'other-model',
    });
    check('env import is once-only', again === null && store.listViews().length === 1);
  }

  // 22. 环境配置导入：无内置模板，匹配不到时新建自定义 provider（不新建则填已有）
  {
    const store = new SettingsStore(new DatabaseSync(':memory:'), new MemorySecretStore());
    const imported = store.importEnvFallback({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai-env-5678',
      model: 'gpt-4o',
    });
    check('env import created custom', imported !== null && imported.modelId === 'gpt-4o');
    const openai = imported
      ? store.listViews().find((p) => p.id === imported.providerId)
      : undefined;
    check(
      'env import filled custom key',
      !!openai && openai.hasApiKey && openai.apiKeyMasked === '********',
    );
    check(
      'env import kept catalog',
      !!openai && openai.models.includes('gpt-4o') && openai.models.length >= 1,
    );
  }

  // 24. HTTP：providerId 代拉目录（存储密钥只在服务端使用，不回传明文）
  {
    const originalFetch = globalThis.fetch;
    try {
      // 放行测试客户端到本地 Host 的请求，仅拦截发往上游的 /models 调用
      globalThis.fetch = (async (input, init) => {
        if (String(input).includes('api.touch.com')) {
          const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
          check('available-models used stored key', auth === 'Bearer sk-touch');
          return new Response(
            JSON.stringify({ data: [{ id: 'touch-pro' }, { id: 'touch-max' }] }),
            { status: 200 },
          );
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      const listNow = await getJSON(`${base}/settings/models`);
      const touch = listNow.models.find((m: any) => m.name === 'TouchProvider');
      check('touch provider exists', !!touch);

      const viaProvider = await postJSON(
        `${base}/settings/available-models`,
        { providerId: touch.id },
        200,
      );
      check(
        'available-models via providerId',
        JSON.stringify(viaProvider.models) === JSON.stringify(['touch-max', 'touch-pro']),
      );
      check(
        'available-models returns catalog',
        Array.isArray(viaProvider.catalog) &&
          viaProvider.catalog.some(
            (model: any) => model.id === 'touch-pro' && model.category === 'chat',
          ),
      );
      const touchAfterProbe = (await getJSON(`${base}/settings/models`)).models.find(
        (m: any) => m.id === touch.id,
      );
      check('available-models marks provider available', touchAfterProbe?.status === 'available');

      // 未配置密钥的 provider → 400
      const noKeyProv = await postJSON(
        `${base}/settings/models`,
        {
          name: 'NoKeyProv',
          baseUrl: 'https://api.nokey2.com',
          models: ['nk2-chat'],
        },
        201,
      );
      const noKey = await postJSON(
        `${base}/settings/available-models`,
        { providerId: noKeyProv.id },
        400,
      );
      check(
        'available-models without key 400',
        noKey.message === 'provider has no API key configured',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  reportAndExit();
})();
