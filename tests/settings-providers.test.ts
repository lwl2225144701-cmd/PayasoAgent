// 模块: Provider 设置 CRUD / 校验 / 删除 + 可用模型目录（直连解析、SSRF/Origin 防线、preview 预检）测试
// 用法: npx tsx tests/settings-providers.test.ts（确定性，无真实网络；SecretStore = Memory）
// 来源: 自原 tests/settings.test.ts 按测试域拆出，用例原样搬移（未改任何测试逻辑与断言）。

import assert from 'node:assert/strict';
import {
  authHeaders,
  base,
  check,
  delJSON,
  getJSON,
  patchJSON,
  postJSON,
  postJSONWithOrigin,
  reportAndExit,
  TEST_TOKEN,
} from './helpers/settings-harness.js';

// ---- 测试开始 ----

(async () => {
  // 1. 默认列表：新库无内置模板，列表为空
  const list = await getJSON(`${base}/settings/models`);
  check('GET default empty (no builtins)', Array.isArray(list.models) && list.models.length === 0);

  // 1b. 创建带凭证的 provider（替代原内置模板入口，builtin 已移除）
  const tplAdded = await postJSON(
    `${base}/settings/models`,
    {
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-template-1234',
      models: ['deepseek-chat'],
    },
    201,
  );
  check('template add keeps custom kind', tplAdded.kind === 'custom');
  check(
    'template add has key',
    tplAdded.hasApiKey === true && tplAdded.apiKeyMasked === '********',
  );
  const afterTpl = await getJSON(`${base}/settings/models`);
  check(
    'template add visible in list',
    afterTpl.models.some((m: any) => m.id === tplAdded.id && m.hasApiKey === true),
  );

  // 2. 创建 provider
  const created = await postJSON(
    `${base}/settings/models`,
    {
      name: 'TestProvider',
      baseUrl: 'https://api.test.com',
      apiKey: 'sk-abcdef1234567890',
      models: ['test-chat', 'test-reasoner'],
    },
    201,
  );
  check('POST created has id', typeof created.id === 'string' && created.id.length > 0);
  check('POST created name', created.name === 'TestProvider');
  check('POST created apiKeyMasked', created.apiKeyMasked === '********');
  check('POST created hasApiKey', created.hasApiKey === true);
  check('POST created models', created.models.length === 2);
  check('POST created kind', created.kind === 'custom');
  check('POST created status', created.status === 'configured');

  // 3. 重复 name 拒绝
  const dupName = await postJSON(
    `${base}/settings/models`,
    {
      name: 'TestProvider',
      baseUrl: 'https://api.other.com',
      apiKey: 'sk-other',
      models: ['other'],
    },
    400,
  );
  check(
    'POST dup name 400',
    dupName.message ===
      'Provider with same name or baseUrl already exists: TestProvider (https://api.test.com)',
  );

  // 4. 重复 baseUrl 拒绝
  const dupUrl = await postJSON(
    `${base}/settings/models`,
    {
      name: 'Other',
      baseUrl: 'https://api.test.com',
      apiKey: 'sk-other',
      models: ['other'],
    },
    400,
  );
  check(
    'POST dup baseUrl 400',
    dupUrl.message ===
      'Provider with same name or baseUrl already exists: TestProvider (https://api.test.com)',
  );

  // 5. 非法 URL 拒绝
  const badUrl = await postJSON(
    `${base}/settings/models`,
    {
      name: 'Bad',
      baseUrl: 'ftp://example.com',
      apiKey: 'sk-bad',
      models: ['bad'],
    },
    400,
  );
  check('POST bad url 400', badUrl.message === 'baseUrl protocol not allowed');

  // 6. models 去重
  const deduped = await postJSON(
    `${base}/settings/models`,
    {
      name: 'Dedup',
      baseUrl: 'https://api.dedup.com',
      apiKey: 'sk-dedup',
      models: ['m1', 'm1', 'm2', ' m2 '],
    },
    201,
  );
  check('POST models deduped', deduped.models.length === 2);

  // 7. models 超 50 拒绝
  const manyModels = Array.from({ length: 51 }, (_, i) => `m${i}`);
  const tooMany = await postJSON(
    `${base}/settings/models`,
    {
      name: 'TooMany',
      baseUrl: 'https://api.toomany.com',
      apiKey: 'sk-toomany',
      models: manyModels,
    },
    400,
  );
  check('POST too many models 400', tooMany.message === 'models cannot exceed 50');

  // 8. 更新保留 apiKey（不传 apiKey）
  const updated = await patchJSON(`${base}/settings/models/${created.id}`, {
    name: 'TestProvider Updated',
  });
  check('PATCH name updated', updated.name === 'TestProvider Updated');
  check(
    'PATCH apiKey unchanged',
    updated.apiKeyMasked === '********' && updated.hasApiKey === true,
  );

  // 9. 更新清除 apiKey（传 null）
  const cleared = await patchJSON(`${base}/settings/models/${created.id}`, {
    apiKey: null,
  });
  check('PATCH apiKey cleared', cleared.apiKeyMasked === '****' && cleared.hasApiKey === false);

  // 10. 更新替换 apiKey
  const replaced = await patchJSON(`${base}/settings/models/${created.id}`, {
    apiKey: 'new-key-9999',
  });
  check(
    'PATCH apiKey replaced',
    replaced.apiKeyMasked === '********' && replaced.hasApiKey === true,
  );

  // 11. 空字符串 apiKey 拒绝
  const emptyKey = await patchJSON(
    `${base}/settings/models/${created.id}`,
    {
      apiKey: '   ',
    },
    400,
  );
  check('PATCH empty apiKey 400', emptyKey.message === 'apiKey must be non-empty or null');

  // 12. 非法 ID 拒绝
  const badId = await getJSON(`${base}/settings/models/not-a-uuid`, 400);
  check('GET bad id 400', badId.message === 'invalid_model_id');

  const badIdPatch = await patchJSON(`${base}/settings/models/not-a-uuid`, { name: 'x' }, 400);
  check('PATCH bad id 400', badIdPatch.message === 'invalid_model_id');

  const badIdDel = await delJSON(`${base}/settings/models/not-a-uuid`, 400);
  check('DELETE bad id 400', badIdDel.message === 'invalid_model_id');

  // 13. 删除不存在的 provider 返回 404（内置模板已移除，无"不可删内置"语义）
  const delMissingStatus = await (
    await fetch(`${base}/settings/models/${crypto.randomUUID()}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    })
  ).status;
  check('DELETE missing provider 404', delMissingStatus === 404);

  // 14. 删除成功返回 { deleted: true }
  const deleted = await delJSON(`${base}/settings/models/${created.id}`);
  check('DELETE returns deleted:true', deleted.deleted === true);

  // 15. 删除后不存在
  const afterDel = await getJSON(`${base}/settings/models/${created.id}`, 404);
  check('GET after delete 404', afterDel.error === 'not_found');

  // 16. 列表最终：DeepSeek + Dedup 两个自定义（无内置模板）
  const finalList = await getJSON(`${base}/settings/models`);
  check('final list count', finalList.models.length === 2);
  check(
    'final list builtin count',
    finalList.models.filter((m: any) => m.kind === 'builtin').length === 0,
  );

  // 23. 获取可用模型：OpenAI 兼容 GET /models 的解析（去重、trim、排序、错误分支）
  {
    const { fetchAvailableModels } = await import('../src/host/available-models.js');
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'm2' }, { id: 'm1' }, { id: ' m1 ' }, { object: 'model' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )) as typeof fetch;
      const models = await fetchAvailableModels('https://api.test.com/v1/', 'sk-test');
      check(
        'available models deduped and sorted',
        JSON.stringify(models) === JSON.stringify(['m1', 'm2']),
      );

      globalThis.fetch = (async () =>
        new Response('unauthorized', { status: 401 })) as typeof fetch;
      await assert.rejects(
        () => fetchAvailableModels('https://api.test.com/v1', 'bad'),
        /returned 401/,
      );

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ data: 'nope' }), { status: 200 })) as typeof fetch;
      await assert.rejects(
        () => fetchAvailableModels('https://api.test.com/v1', 'k'),
        /missing data array/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 29. SSRF/Origin 防线：available-models 拒绝客户端 baseUrl、要求 providerId、Origin 校验
  {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input, init) => {
        if (String(input).includes('api.evil.com')) {
          return new Response(JSON.stringify({ data: [{ id: 'evil' }] }), { status: 200 });
        }
        if (String(input).includes('ssrf-test.example.com')) {
          const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
          check('SSRF: available-models used stored key', auth === 'Bearer sk-ssrf-test');
          return new Response(JSON.stringify({ data: [{ id: 'ssrf-chat' }] }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      // 先创建一个带密钥的 provider 用于测试
      const testProv = await postJSON(
        `${base}/settings/models`,
        {
          name: 'SSRFTestProvider',
          baseUrl: 'https://ssrf-test.example.com/v1',
          apiKey: 'sk-ssrf-test',
          models: ['ssrf-chat'],
        },
        201,
      );

      // 无 providerId → 400
      const noProvider = await postJSON(
        `${base}/settings/available-models`,
        { baseUrl: 'https://api.openai.com/v1' },
        400,
      );
      check('SSRF: missing providerId 400', noProvider.message === 'providerId is required');

      // 传了 baseUrl 但无 providerId（客户端试图指定 endpoint）→ 400
      const withBaseUrl = await postJSON(
        `${base}/settings/available-models`,
        { baseUrl: 'https://api.evil.com/v1', apiKey: 'sk' },
        400,
      );
      check(
        'SSRF: client-supplied baseUrl rejected',
        withBaseUrl.message === 'providerId is required',
      );

      // 未知 providerId → 400
      const unknownProv = await postJSON(
        `${base}/settings/available-models`,
        { providerId: 'unknown-id' },
        400,
      );
      check(
        'SSRF: unknown providerId 400',
        unknownProv.message === 'provider not found or not configured',
      );

      // 有 providerId 但无 apiKey → 400（使用未配置密钥的 provider）
      const noKeyProv2 = await postJSON(
        `${base}/settings/models`,
        {
          name: 'NoKeyProv2',
          baseUrl: 'https://api.nokey3.com',
          models: ['nk3-chat'],
        },
        201,
      );
      const noKey = await postJSON(
        `${base}/settings/available-models`,
        { providerId: noKeyProv2.id },
        400,
      );
      check(
        'SSRF: provider without key 400',
        noKey.message === 'provider has no API key configured',
      );

      // 正确 providerId → 200（使用存储的 baseUrl + apiKey）
      const ok = await postJSON(
        `${base}/settings/available-models`,
        { providerId: testProv.id },
        200,
      );
      check('SSRF: valid providerId 200', Array.isArray(ok.models));

      // Origin 校验：无 Origin 头（服务端调用）→ 200；非法 Origin → 400
      const noOriginRes = await fetch(`${base}/settings/available-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ providerId: testProv.id }),
      });
      check('SSRF: no Origin allowed', noOriginRes.status === 200);

      const badOriginRes = await postJSONWithOrigin(
        `${base}/settings/available-models`,
        { providerId: testProv.id },
        'https://evil.com',
      );
      check('SSRF: bad Origin rejected', badOriginRes.status === 400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 29b. preview 临时预检接口：/settings/available-models/preview
  // 用于新增 Provider 时用表单 baseUrl+apiKey 拉取目录；凭证不落盘、不写日志。
  {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.includes('preview-target.example.com')) {
          const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
          check('preview: used form apiKey', auth === 'Bearer sk-preview-form');
          return new Response(
            JSON.stringify({ data: [{ id: 'preview-chat' }, { id: 'preview-flash' }] }),
            { status: 200 },
          );
        }
        if (url.includes('127.0.0.1:60666')) {
          return new Response(JSON.stringify({ data: [{ id: 'loopback-chat' }] }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      // 缺 baseUrl / apiKey → 400
      const noBaseUrl = await postJSON(
        `${base}/settings/available-models/preview`,
        { apiKey: 'sk-x' },
        400,
      );
      check(
        'preview: missing baseUrl 400',
        noBaseUrl.message === 'baseUrl and apiKey are required',
      );
      const noKey = await postJSON(
        `${base}/settings/available-models/preview`,
        { baseUrl: 'https://a.com/v1' },
        400,
      );
      check('preview: missing apiKey 400', noKey.message === 'baseUrl and apiKey are required');

      // 非 https / 非 loopback http → 400（协议白名单）
      const ftpUrl = await postJSON(
        `${base}/settings/available-models/preview`,
        { baseUrl: 'ftp://a.com/v1', apiKey: 'sk-x' },
        400,
      );
      check('preview: ftp rejected 400', ftpUrl.message === 'baseUrl protocol not allowed');
      const evilHttp = await postJSON(
        `${base}/settings/available-models/preview`,
        { baseUrl: 'http://api.evil.com/v1', apiKey: 'sk-x' },
        400,
      );
      check(
        'preview: non-loopback http rejected 400',
        evilHttp.message === 'baseUrl protocol not allowed',
      );

      // 正确 https → 200，mock 校验 Authorization 使用表单 apiKey（不落盘、不回显）
      const okHttps = await postJSON(
        `${base}/settings/available-models/preview`,
        {
          baseUrl: 'https://preview-target.example.com/v1',
          apiKey: 'sk-preview-form',
        },
        200,
      );
      check(
        'preview: https ok 200',
        Array.isArray(okHttps.models) && okHttps.models.includes('preview-chat'),
      );

      // loopback http（开发模式）→ 200
      const okLoopback = await postJSON(
        `${base}/settings/available-models/preview`,
        {
          baseUrl: 'http://127.0.0.1:60666/v1',
          apiKey: 'sk-loopback',
        },
        200,
      );
      check(
        'preview: loopback http ok 200',
        Array.isArray(okLoopback.models) && okLoopback.models.includes('loopback-chat'),
      );

      // Origin 校验同样生效
      const badOrigin = await postJSONWithOrigin(
        `${base}/settings/available-models/preview`,
        { baseUrl: 'https://preview-target.example.com/v1', apiKey: 'sk-x' },
        'https://evil.com',
      );
      check('preview: bad Origin rejected 400', badOrigin.status === 400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  reportAndExit();
})();
