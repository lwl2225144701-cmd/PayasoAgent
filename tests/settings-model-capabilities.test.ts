// 模块: v1.6 闭环 — 按模型能力配置 → 预算解析（metadata 回环 + 凭证携带能力 + Run 预算联动）测试
// 用法: npx tsx tests/settings-model-capabilities.test.ts（确定性，无真实网络；SecretStore = Memory）
// 来源: 自原 tests/settings.test.ts 按测试域拆出，用例原样搬移（未改任何测试逻辑与断言）。
//      原文件中本块与主 IIFE 并发执行；拆分后独立成套件，仅依赖共享 harness 的 store/manager。

import { deriveMaxOutputTokens } from '../src/harness/model-context.js';
import {
  base,
  check,
  cleanupCheckpoint,
  delJSON,
  getJSON,
  getRunStatus,
  manager,
  patchJSON,
  postJSON,
  reportAndExit,
  store,
} from './helpers/settings-harness.js';

// ---- v1.6 闭环：按模型能力配置 → 预算解析（metadata 回环 + 凭证携带 + Run 联动）----

(async () => {
  // 1. CRUD 回环：创建带能力覆盖的 provider → 视图回显 → PATCH 整表替换 → 引用目录外模型拒绝
  const created = await postJSON(
    `${base}/settings/models`,
    {
      name: 'CapProvider',
      baseUrl: 'https://api.cap.com',
      apiKey: 'sk-cap-0001',
      models: ['cap-chat', 'cap-mini'],
      modelCapabilities: {
        'cap-chat': { contextWindow: 131_072, maxOutputTokens: 8_192, thinkingLevel: 'high' },
      },
    },
    201,
  );
  check(
    'cap: 创建回显能力覆盖',
    created.modelCapabilities?.['cap-chat']?.contextWindow === 131_072,
  );
  check('cap: 创建回显思考档次', created.modelCapabilities?.['cap-chat']?.thinkingLevel === 'high');

  const listed = await getJSON(`${base}/settings/models`);
  check(
    'cap: GET 列表回显',
    listed.models.some(
      (m: any) =>
        m.id === created.id && m.modelCapabilities?.['cap-chat']?.contextWindow === 131_072,
    ),
  );
  check(
    'cap: GET 列表回显思考档次',
    listed.models.some(
      (m: any) =>
        m.id === created.id && m.modelCapabilities?.['cap-chat']?.thinkingLevel === 'high',
    ),
  );

  const badCap = await patchJSON(
    `${base}/settings/models/${created.id}`,
    {
      modelCapabilities: { 'ghost-model': { contextWindow: 1000 } },
    },
    400,
  );
  check('cap: 引用目录外模型 400', badCap.message.includes('outside catalog'));

  const badLevel = await patchJSON(
    `${base}/settings/models/${created.id}`,
    {
      modelCapabilities: { 'cap-chat': { thinkingLevel: 'ultra' } },
    },
    400,
  );
  check('cap: 非法思考档次 400', badLevel.message.includes('thinkingLevel'));

  // 2. 凭证读取按 model 携带能力（Run 解析链路使用）
  const secretViaStore = store.getModelProviderSecret(created.id, 'cap-chat');
  check('cap: 凭证携带 contextWindow', secretViaStore?.contextWindow === 131_072);
  check('cap: 凭证携带 maxOutputTokens', secretViaStore?.maxOutputTokens === 8_192);
  check('cap: 凭证携带思考档次', secretViaStore?.thinkingLevel === 'high');
  check(
    'cap: 未配置的模型不带能力字段',
    store.getModelProviderSecret(created.id, 'cap-mini')?.contextWindow === undefined,
  );
  check(
    'cap: 未配置的模型不带思考档次',
    store.getModelProviderSecret(created.id, 'cap-mini')?.thinkingLevel === undefined,
  );

  // 3. 目录收缩：PATCH models 移除带覆盖的模型 → 覆盖被清理
  await patchJSON(`${base}/settings/models/${created.id}`, { models: ['cap-mini'] });
  const pruned = manager.getModelProvider(created.id);
  check('cap: 目录收缩清理能力覆盖', pruned?.modelCapabilities === undefined);

  // 4. Run 预算联动：默认模型配置 32K 窗口 → context_usage.inputBudgetTokens 反映之
  await patchJSON(`${base}/settings/models/${created.id}`, {
    models: ['cap-chat', 'cap-mini'],
    modelCapabilities: {
      'cap-chat': { contextWindow: 131_072 },
      'cap-mini': { contextWindow: 32_768 },
    },
  });
  await postJSON(`${base}/settings/default`, { providerId: created.id, model: 'cap-chat' }, 200);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('api.cap.com')) {
        return new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'cap ok' } }] }),
          { status: 200 },
        );
      }
      return originalFetch(input, init);
    };
    const created9 = await postJSON(`${base}/runs`, { task: '能力预算联动' }, 202);
    const deadline = Date.now() + 10_000;
    let status9 = 'running';
    while (Date.now() < deadline) {
      status9 = (await getRunStatus(created9.runId)).status;
      if (status9 !== 'running' && status9 !== 'stopping') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    check('cap: Run 在配置窗口下完成', status9 === 'completed', `status=${status9}`);
    // 预算 = 窗口(131072) - 输出预留(未配置 → v1.8 按窗口推导) - 安全余量(2622)
    const expectedBudget =
      131_072 - deriveMaxOutputTokens(131_072) - Math.max(2_048, Math.ceil(131_072 * 0.02));
    const usageEvents = (
      await (await fetch(`${base}/runs/${created9.runId}/events?live=0`)).text()
    ).includes(`"inputBudgetTokens":${expectedBudget}`);
    check(
      `cap: context_usage 预算 = 窗口-输出预留-安全余量（${expectedBudget}）`,
      usageEvents,
      'budget mismatch',
    );
    cleanupCheckpoint(created9.runId);
  } finally {
    globalThis.fetch = originalFetch;
  }
  await delJSON(`${base}/settings/models/${created.id}`);

  reportAndExit();
})();
