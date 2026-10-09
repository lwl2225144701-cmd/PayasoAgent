// 模块: 内置 Provider 的模型目录刷新 —— 对应「配置 MiMo Token Plan 时识别不到 v2.6 系列」。
//
// 覆盖六条链路（全部确定性、无真实 LLM 与真实网络）：
//   ① 本地模型补丁：内置目录与运行时元数据里必须有 MiMo v2.6（构建期静态目录的缺口）
//   ② 远端合并：GET {baseUrl}/models 与内置目录取并集，内置元数据权威、远端只补缺
//   ③ 模型准入名单：远端探测到的模型可保存；从未探测过的未知 id 仍被拒绝（fail-closed）
//   ④ 运行时合成：目录之外的已探测模型仍能拿到协议 / compat 元数据（多轮工具调用依赖它）
//   ⑤ 启动后台探测 + 目录缓存（第一层根治）：不阻塞、失败标 stale、
//     GET /settings/pi-ai/providers 直接给出合并目录，用户无需点刷新
//   ⑥ 能力归一化 + 放宽刷新资格（第二层）：远端声明的视觉、非对话模型分类与过滤、
//     Bearer/OpenAI 约定的 Provider 扩容（openai / xai），读缓存与实时路径同构
//
// 用法: node --import tsx tests/builtin-catalog-refresh.test.ts

import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  fetchAvailableModelCatalog,
  fetchBuiltinProviderCatalog,
  mergeCachedRemoteCatalog,
} from '../src/host/available-models.js';
import { refreshBuiltinModelCatalogs } from '../src/host/builtin-catalog-probe.js';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import {
  getPiAiProviderModel,
  isRemoteRefreshableProvider,
  listPiAiProviderCatalog,
  type PiAiModelInfo,
  resolvePiAiRuntimeModel,
} from '../src/host/pi-ai-providers.js';
import type { ProviderModelInfo } from '../src/host/provider-url.js';
import { RunManager } from '../src/host/run-manager.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { createHostServer } from '../src/host/server.js';

const TOKEN = 'test-token-00000000000000000000000000000000';
const TOKEN_PLAN_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';

// ── ① 本地补丁 ────────────────────────────────────────────────────────────
{
  const catalog = listPiAiProviderCatalog();
  // 每个内置 Provider 期望补齐的模型；v2.6 是构建期静态目录缺失的那一批。
  const expected: Array<[string, string, string]> = [
    ['xiaomi-token-plan-cn', 'mimo-v2.6-pro', TOKEN_PLAN_BASE_URL],
    ['xiaomi-token-plan-cn', 'mimo-v2.6-flash', TOKEN_PLAN_BASE_URL],
    ['xiaomi-token-plan-ams', 'mimo-v2.6-pro', 'https://token-plan-ams.xiaomimimo.com/v1'],
    ['xiaomi-token-plan-sgp', 'mimo-v2.6-flash', 'https://token-plan-sgp.xiaomimimo.com/v1'],
    ['xiaomi', 'mimo-v2.6-pro', 'https://api.xiaomimimo.com/v1'],
    ['xiaomi', 'mimo-v2.6-pro-ultraspeed', 'https://api.xiaomimimo.com/v1'],
  ];

  for (const [providerId, modelId, baseUrl] of expected) {
    const provider = catalog.find((item) => item.id === providerId);
    assert.ok(provider, `${providerId} 应在内置目录里`);
    const model = provider.models.find((item) => item.id === modelId);
    assert.ok(model, `${providerId} 的目录必须包含 ${modelId}`);
    assert.equal(model.contextWindow, 1_048_576, `${modelId} 上下文窗口应为 1M`);
    assert.equal(model.maxOutputTokens, 131_072, `${modelId} 最大输出应为 128K`);
    assert.deepEqual(model.input, ['text', 'image'], `${modelId} 应声明图片输入`);
    assert.equal(model.reasoning, true, `${modelId} 应声明推理能力`);
    assert.equal(model.api, 'openai-completions');
    assert.ok(model.thinkingLevels.includes('off'), '思考档次列表必须包含 off');

    // 运行时元数据：compat 从同族模板继承。requiresReasoningContentOnAssistantMessages
    // + thinkingFormat=deepseek 是 MiMo 多轮工具调用不退化的必要条件。
    const resolved = getPiAiProviderModel(providerId, modelId);
    assert.ok(resolved, `${providerId}/${modelId} 必须能在运行时解析`);
    assert.equal(resolved.model.baseUrl, baseUrl);
    const compat = resolved.model.compat as
      | { thinkingFormat?: string; requiresReasoningContentOnAssistantMessages?: boolean }
      | undefined;
    assert.equal(compat?.thinkingFormat, 'deepseek');
    assert.equal(compat?.requiresReasoningContentOnAssistantMessages, true);
  }

  // 补丁只做加法：v2.5 必须仍在目录里（旧配置不能因此失效）。
  const cn = catalog.find((item) => item.id === 'xiaomi-token-plan-cn');
  assert.ok(
    cn?.models.some((model) => model.id === 'mimo-v2.5'),
    'v2.5 不应从目录里消失',
  );
}

// ── 远端刷新资格：只对「Provider 级 https 地址 + 全部 openai-completions」开放 ──
{
  assert.equal(isRemoteRefreshableProvider('xiaomi-token-plan-cn'), true);
  assert.equal(isRemoteRefreshableProvider('deepseek'), true);
  // anthropic-messages 用别的鉴权头，OpenAI 兼容 /models 探测必然 401
  assert.equal(isRemoteRefreshableProvider('minimax-cn'), false);
  // 无 Provider 级地址（地址写在模型上），没有可探的端点
  assert.equal(isRemoteRefreshableProvider('opencode-go'), false);
  assert.equal(isRemoteRefreshableProvider('amazon-bedrock'), false);
  assert.equal(isRemoteRefreshableProvider('missing-provider'), false);

  // refreshable 会随目录一起下发给设置页，决定按钮文案与是否发起远端探测
  const catalog = listPiAiProviderCatalog();
  assert.equal(catalog.find((item) => item.id === 'xiaomi-token-plan-cn')?.refreshable, true);
  assert.equal(catalog.find((item) => item.id === 'opencode-go')?.refreshable, false);
}

// ── ② 远端合并（mock /models）──────────────────────────────────────────────
{
  const originalFetch = globalThis.fetch;
  const remotePayload = {
    data: [{ id: 'mimo-v2.7-pro' }, { id: 'mimo-v2.5' }, { id: 'mimo-v2.6-flash' }],
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(remotePayload), { status: 200 })) as typeof fetch;
  try {
    const { catalog, remoteModelIds } = await fetchBuiltinProviderCatalog(
      'xiaomi-token-plan-cn',
      TOKEN_PLAN_BASE_URL,
      'sk-mock',
    );

    // remoteModelIds 是准入名单的证据来源，按 /models 的顺序（已排序）
    assert.deepEqual(remoteModelIds, ['mimo-v2.5', 'mimo-v2.6-flash', 'mimo-v2.7-pro']);

    // 内置条目胜出：远端也返回了 mimo-v2.6-flash，但元数据必须来自补丁而非远端
    const flash = catalog.find((model) => model.id === 'mimo-v2.6-flash');
    assert.ok(flash);
    assert.equal(flash.contextWindow, 1_048_576);
    assert.equal(flash.maxOutputTokens, 131_072);
    assert.equal(flash.vision, true);
    assert.ok(Array.isArray(flash.thinkingLevels) && flash.thinkingLevels.length > 0);

    // 远端独有的模型进入目录，且不重复
    assert.ok(catalog.some((model) => model.id === 'mimo-v2.7-pro'));
    assert.equal(new Set(catalog.map((model) => model.id)).size, catalog.length);

    // 远端独有的 MiMo v2.7 目前不在 model-context 注册表里 → 不编造窗口
    assert.equal(catalog.find((model) => model.id === 'mimo-v2.7-pro')?.contextWindow, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── 运行时合成：目录外的已探测模型 ─────────────────────────────────────────
{
  // 未经探测的空白目录里没有它，静态查询必须返回 undefined
  assert.equal(getPiAiProviderModel('xiaomi-token-plan-cn', 'mimo-v2.7-pro'), undefined);

  const resolved = resolvePiAiRuntimeModel('xiaomi-token-plan-cn', 'mimo-v2.7-pro');
  assert.ok(resolved, '已探测的目录外模型必须能合成出运行时 Model');
  assert.equal(resolved.model.api, 'openai-completions');
  assert.equal(resolved.model.baseUrl, TOKEN_PLAN_BASE_URL);
  assert.equal(resolved.model.provider, 'xiaomi-token-plan-cn');
  // 视觉刻意不继承模板：远端 /models 无法声明图片输入，交由设置页显式开启
  assert.deepEqual(resolved.model.input, ['text']);
  const compat = resolved.model.compat as { thinkingFormat?: string } | undefined;
  assert.equal(compat?.thinkingFormat, 'deepseek');

  // 非远端可刷新的 Provider 不做合成：否则会掩盖配置错误
  assert.equal(resolvePiAiRuntimeModel('opencode-go', 'not-a-real-model'), undefined);
  assert.equal(resolvePiAiRuntimeModel('missing-provider', 'x'), undefined);
}

// ── ③ + ④：HTTP 全链路（准入名单 + 重启后仍有效）────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-builtin-catalog-'));
  const dbPath = path.join(dir, 'payaso.db');
  const secrets = new MemorySecretStore();
  const originalFetch = globalThis.fetch;

  const remoteModels = ['mimo-v2.5', 'mimo-v2.6-pro', 'mimo-v2.7-pro'];
  /** 上游 /models 的状态码。500 用于验证「探测失败不污染准入名单」。 */
  let remoteStatus = 200;

  let store: SqliteRunStore | undefined;
  let server: Server | undefined;
  let reopened: SqliteRunStore | undefined;
  const closeServer = async (): Promise<void> => {
    if (!server) return;
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  };

  try {
    store = new SqliteRunStore(dbPath, secrets);
    const host = createHostServer(new RunManager(store), TOKEN);
    server = host;
    await new Promise<void>((resolve) => host.listen(0, resolve));
    const port = (host.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    // 只拦截发往供应商的请求；到本机 Host 的客户端请求照旧直通
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.startsWith(base)) return originalFetch(input, init);
      return new Response(JSON.stringify({ data: remoteModels.map((id) => ({ id })) }), {
        status: remoteStatus,
      });
    }) as typeof fetch;

    const request = async (
      method: 'POST' | 'PATCH',
      pathname: string,
      body: unknown,
    ): Promise<{ status: number; json: Record<string, unknown> }> => {
      const response = await fetch(`${base}${pathname}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          Origin: `http://localhost:${port}`,
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        json: (await response.json()) as Record<string, unknown>,
      };
    };
    const post = (pathname: string, body: unknown) => request('POST', pathname, body);
    const patch = (pathname: string, body: unknown) => request('PATCH', pathname, body);

    // 3a. 补丁模型无需任何探测即可保存（这是用户看到 v2.6 立即生效的路径）
    const patched = await post('/settings/models', {
      name: 'MiMo Token Plan',
      piProviderId: 'xiaomi-token-plan-cn',
      apiKey: 'sk-mock-token-plan',
      models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    });
    assert.equal(patched.status, 201, JSON.stringify(patched.json));
    assert.equal(patched.json.baseUrl, TOKEN_PLAN_BASE_URL);
    const providerId = patched.json.id as string;

    // 3b. 从未探测过的目录外 id 必须被拒（fail-closed，防止拼错模型名被静默保存）
    const beforeProbe = await patch(`/settings/models/${providerId}`, {
      models: ['mimo-v2.7-pro'],
    });
    assert.equal(beforeProbe.status, 400, JSON.stringify(beforeProbe.json));
    assert.match(String(beforeProbe.json.message), /内置提供方不支持模型/);

    // 3c. 远端探测失败 → 不写准入名单
    remoteStatus = 500;
    const failedProbe = await post('/settings/available-models/preview', {
      baseUrl: TOKEN_PLAN_BASE_URL,
      apiKey: 'sk-mock-token-plan',
      piProviderId: 'xiaomi-token-plan-cn',
    });
    assert.equal(failedProbe.status, 400);
    const afterFailedProbe = await patch(`/settings/models/${providerId}`, {
      models: ['mimo-v2.7-pro'],
    });
    assert.equal(afterFailedProbe.status, 400, '探测失败不得放宽准入');

    // 3d. 远端探测成功 → 合并目录 + 记录准入名单（新增 Provider 的预检路径）
    remoteStatus = 200;
    const preview = await post('/settings/available-models/preview', {
      baseUrl: TOKEN_PLAN_BASE_URL,
      apiKey: 'sk-mock-token-plan',
      piProviderId: 'xiaomi-token-plan-cn',
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    const catalogIds = (preview.json.catalog as Array<{ id: string }>).map((model) => model.id);
    // 顺序契约：内置目录在前（含 v2.6 补丁），远端独有的模型追加在后
    assert.deepEqual(
      catalogIds,
      ['mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.7-pro'],
      '预检目录 = 内置目录 ∪ 远端目录',
    );
    const flashEntry = (preview.json.catalog as Array<Record<string, unknown>>).find(
      (model) => model.id === 'mimo-v2.6-flash',
    );
    assert.equal(flashEntry?.vision, true, '合并目录必须带上内置注册表的视觉能力');
    assert.equal(flashEntry?.contextWindow, 1_048_576, '远端同名条目不得覆盖内置元数据');

    // 探测之后，同一批模型可以保存（准入名单生效）
    const afterProbe = await patch(`/settings/models/${providerId}`, {
      models: ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.7-pro'],
    });
    assert.equal(afterProbe.status, 200, JSON.stringify(afterProbe.json));

    // 3e. 已保存 Provider 的编辑路径：providerId 版本同样合并 + 记录
    const viaProvider = await post('/settings/available-models', { providerId });
    assert.equal(viaProvider.status, 200, JSON.stringify(viaProvider.json));
    assert.ok(
      (viaProvider.json.catalog as Array<{ id: string }>).some(
        (model) => model.id === 'mimo-v2.7-pro',
      ),
    );

    await closeServer();
    store.close();
    store = undefined;

    // ④ 准入名单随 settings blob 持久化：重启后仍能保存同一批模型
    const re = new SqliteRunStore(dbPath, secrets);
    reopened = re;
    const existing = re.getModelProvider(providerId);
    assert.ok(existing, '重启后 Provider 记录应仍在');
    assert.deepEqual(existing.models, ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.7-pro']);

    // 先把目录外模型从列表移除，再重新加回：这次只能依赖"已持久化的准入名单"
    // —— 当前 settings 里已经没有这个模型了，名单若没落盘，下面这步会 400。
    const shrunk = re.updateModelProvider(providerId, { models: ['mimo-v2.6-pro'] });
    assert.deepEqual(shrunk?.models, ['mimo-v2.6-pro']);
    const restored = re.updateModelProvider(providerId, {
      models: ['mimo-v2.6-pro', 'mimo-v2.7-pro'],
    });
    assert.ok(restored?.models.includes('mimo-v2.7-pro'), '准入名单必须跨重启存活');

    // 未探测过的 id 在重启后依然被拒：名单是白名单而不是"任意模型都放行"
    assert.throws(
      () => re.updateModelProvider(providerId, { models: ['mimo-v2.6-pro', 'mimo-v2.9-typo'] }),
      /内置提供方不支持模型/,
    );
    re.close();
    reopened = undefined;
  } finally {
    globalThis.fetch = originalFetch;
    // 断言中途失败也必须关掉监听与数据库连接，否则 Windows 上进程退出会伴随
    // libuv 断言噪声，掩盖真正的失败原因。
    await closeServer();
    store?.close();
    reopened?.close();
    try {
      // Windows 上刚关闭的 SQLite 库/目录可能被瞬时占用（WAL 映射释放、索引器扫描），
      // 清理失败不应把已通过的断言变成红：带重试，最终失败只提示、不抛出。
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(
        `[cleanup] 临时目录未清理干净（可手动删除）: ${dir} ${(error as Error).message}`,
      );
    }
  }
}

// ── ⑤ 第一层：启动后台探测 + 目录缓存 ───────────────────────────────────────
{
  const builtin = listPiAiProviderCatalog();

  // 5a. 无缓存 → 纯静态目录（冷启动首探未完成时的状态）
  {
    const merged = mergeCachedRemoteCatalog(builtin, {});
    assert.deepEqual(merged, builtin, '无缓存时不应改变任何字段');
  }

  // 5b. 纯函数合并：远端独有条目追加、内置条目元数据不被覆盖、stale/fetchedAt 透出
  {
    const cache: Record<
      string,
      { models: ProviderModelInfo[]; fetchedAt: string; stale: boolean }
    > = {
      'xiaomi-token-plan-cn': {
        models: [
          { id: 'mimo-v2.5-pro', category: 'chat' },
          { id: 'mimo-v2.7-pro', category: 'chat', contextWindow: 512_000 },
        ],
        fetchedAt: '2026-10-09T00:00:00.000Z',
        stale: false,
      },
      deepseek: {
        models: [{ id: 'deepseek-typo-not-real', category: 'chat' }],
        fetchedAt: '2026-10-09T00:00:00.000Z',
        stale: true,
      },
    };
    const merged = mergeCachedRemoteCatalog(builtin, cache);

    const cn = merged.find((provider) => provider.id === 'xiaomi-token-plan-cn');
    assert.ok(cn);
    assert.equal(cn.catalogFetchedAt, '2026-10-09T00:00:00.000Z');
    assert.ok(!cn.catalogStale, '成功探测不应标 stale');
    // 静态条目优先：能力必须与静态目录完全一致，而不是被远端那条空壳降级。
    // 断言直接比对静态目录本身（不硬编码期望值），避免把「v2.5-pro 是 text-only」
    // 这类事实误判成 bug。
    const staticCn = builtin.find((provider) => provider.id === 'xiaomi-token-plan-cn');
    for (const staticModel of staticCn?.models ?? []) {
      const mergedModel: PiAiModelInfo | undefined = cn.models.find(
        (model) => model.id === staticModel.id,
      );
      assert.ok(mergedModel, `静态条目 ${staticModel.id} 不应在合并后消失`);
      assert.equal(
        mergedModel.contextWindow,
        staticModel.contextWindow,
        `${staticModel.id} 的上下文窗口不得被远端条目改写`,
      );
      assert.deepEqual(
        mergedModel.input,
        staticModel.input,
        `${staticModel.id} 的输入模态（含视觉）必须来自静态目录`,
      );
      assert.deepEqual(
        mergedModel.thinkingLevels,
        staticModel.thinkingLevels,
        `${staticModel.id} 的思考档次必须来自静态目录`,
      );
    }
    // 远端独有条目进入目录
    const v27 = cn.models.find((model) => model.id === 'mimo-v2.7-pro');
    assert.ok(v27, '远端独有模型必须出现在合并目录');
    assert.equal(v27.contextWindow, 512_000, '远端独有条目带上远端声明的能力');

    const ds = merged.find((provider) => provider.id === 'deepseek');
    assert.ok(ds, 'deepseek 应在合并目录中');
    assert.ok(ds.catalogStale, '探测失败必须标 stale 供 UI 提示');

    // 其余 Provider 不应被误改
    const untouched = merged.find((provider) => provider.id === 'opencode-go');
    assert.deepEqual(
      untouched,
      builtin.find((provider) => provider.id === 'opencode-go'),
    );
    assert.equal(merged.length, builtin.length, '不得凭空增删 Provider');
  }

  // 5c. 启动后台探测：成功 → 写缓存 + 准入名单；GET 直接给出合并目录
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-probe-'));
    const dbPath = path.join(dir, 'payaso.db');
    const secrets = new MemorySecretStore();
    const originalFetch = globalThis.fetch;
    let remoteIds = ['mimo-v2.5', 'mimo-v2.6-pro', 'mimo-v2.7-pro'];
    let remoteStatus = 200;
    let store: SqliteRunStore | undefined;
    let server: Server | undefined;
    const closeServer = async (): Promise<void> => {
      if (!server) return;
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    };

    try {
      store = new SqliteRunStore(dbPath, secrets);
      // 只配置一家内置 Provider（有密钥才有探测目标）
      const created = store.addModelProvider({
        name: 'MiMo Token Plan',
        piProviderId: 'xiaomi-token-plan-cn',
        apiKey: 'sk-probe',
        models: ['mimo-v2.6-pro'],
      });
      assert.ok(created);

      const host = createHostServer(new RunManager(store), TOKEN);
      server = host;
      await new Promise<void>((resolve) => host.listen(0, resolve));
      const port = (host.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;
      const manager = new RunManager(store);

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(base)) return originalFetch(input);
        if (remoteStatus !== 200) return new Response('boom', { status: remoteStatus });
        return new Response(JSON.stringify({ data: remoteIds.map((id) => ({ id })) }), {
          status: 200,
        });
      }) as typeof fetch;

      // 5c-1: 成功探测 → GET /settings/pi-ai/providers 立即包含远端独有模型
      const okResults = await refreshBuiltinModelCatalogs(manager);
      assert.equal(okResults.length, 1, '只探测已配置密钥的 Provider');
      assert.equal(okResults[0]?.piProviderId, 'xiaomi-token-plan-cn');
      assert.equal(okResults[0]?.ok, true);
      // modelCount = 合并目录大小（静态 4 + 远端独有 1），不是远端返回条数
      assert.equal(okResults[0]?.modelCount, 5);

      type ProvidersPayload = {
        providers: Array<{
          id: string;
          models: Array<{ id: string }>;
          catalogStale?: boolean;
          catalogFetchedAt?: string;
        }>;
      };
      const getProviders = async (): Promise<ProvidersPayload> => {
        const res = await fetch(`${base}/settings/pi-ai/providers`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        return res.json() as Promise<ProvidersPayload>;
      };
      const first = (await getProviders()).providers;
      const cnAfter = first.find((p) => p.id === 'xiaomi-token-plan-cn');
      assert.ok(
        cnAfter?.models.some((m) => m.id === 'mimo-v2.7-pro'),
        '启动探测后，GET /settings/pi-ai/providers 必须无需点刷新就给出远端新模型',
      );
      assert.ok(!cnAfter?.catalogStale, '成功探测不应标 stale');
      assert.ok(cnAfter?.catalogFetchedAt, '应带上次成功时间');

      // 5c-2: 远端失败 → stale=true，且模型列表沿用上次成功结果（不被清空）
      remoteStatus = 500;
      const failResults = await refreshBuiltinModelCatalogs(manager);
      assert.equal(failResults[0]?.ok, false);
      const afterFail = (await getProviders()).providers;
      const cnStale = afterFail.find((p) => p.id === 'xiaomi-token-plan-cn');
      assert.equal(cnStale?.catalogStale, true, '探测失败必须标 stale');
      assert.ok(
        cnStale?.models.some((m) => m.id === 'mimo-v2.7-pro'),
        '探测失败时目录必须沿用上次成功结果，不得被清空',
      );

      // 5c-3: 远端恢复成功 → stale 清除
      remoteStatus = 200;
      remoteIds = ['mimo-v2.7-pro'];
      await refreshBuiltinModelCatalogs(manager);
      const recovered = (await getProviders()).providers;
      const cnRecovered = recovered.find((p) => p.id === 'xiaomi-token-plan-cn');
      // stale 是可选字段：非 stale 时字段缺省（undefined），断言用真值即可
      assert.ok(!cnRecovered?.catalogStale, '恢复成功后 stale 必须清除');

      await closeServer();
      store.close();
      store = undefined;
    } finally {
      globalThis.fetch = originalFetch;
      await closeServer();
      store?.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        console.warn(
          `[cleanup] 临时目录未清理干净（可手动删除）: ${dir} ${(error as Error).message}`,
        );
      }
    }
  }

  // 5d. 永不 reject：探测抛错（网络异常）也只返回失败结果
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-probe-throw-'));
    const dbPath = path.join(dir, 'payaso.db');
    const secrets = new MemorySecretStore();
    const originalFetch = globalThis.fetch;
    let store: SqliteRunStore | undefined;
    try {
      const localStore = new SqliteRunStore(dbPath, secrets);
      store = localStore;
      localStore.addModelProvider({
        name: 'MiMo Token Plan',
        piProviderId: 'xiaomi-token-plan-cn',
        apiKey: 'sk-probe',
        models: ['mimo-v2.6-pro'],
      });
      const manager = new RunManager(localStore);
      globalThis.fetch = (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;

      const results = await refreshBuiltinModelCatalogs(manager);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.ok, false, '网络异常必须降级为失败结果而非 reject');
      // 底层 fetch 错误会被 provider-url 统一脱敏（不泄漏 DNS/TLS 细节）
      assert.match(String(results[0]?.error), /unreachable|returned \d+|timeout/);

      // 从未成功过 → 缓存保持不存在（不凭空造空目录），准入名单也不放宽
      assert.deepEqual(localStore.getBuiltinRemoteCatalogs(), {}, '首探失败不得写缓存');
      assert.throws(
        () =>
          localStore.updateModelProvider(localStore.listModelProviders()[0].id, {
            models: ['mimo-v2.6-pro', 'mimo-v2.7-pro'],
          }),
        /内置提供方不支持模型/,
        '首探失败后准入名单不得放宽',
      );
    } finally {
      globalThis.fetch = originalFetch;
      store?.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        console.warn(
          `[cleanup] 临时目录未清理干净（可手动删除）: ${dir} ${(error as Error).message}`,
        );
      }
    }
  }
}

// ── ⑥ 第二层：能力归一化（vision / 分类）+ 放宽刷新资格 ─────────────────────

// 6a. 刷新资格：只放开「Bearer + OpenAI 约定 {baseUrl}/models」这一族。
//     扩容来自 openai（openai-responses）与 xai；其余按协议事实仍然排除。
{
  assert.equal(isRemoteRefreshableProvider('openai'), true, 'openai 走 Bearer + 标准 /models');
  assert.equal(isRemoteRefreshableProvider('xai'), true, 'xAI 是 OpenAI 兼容端点');
  // anthropic-messages：x-api-key 鉴权 + 路径约定因供应商而异，不能猜
  assert.equal(isRemoteRefreshableProvider('minimax-cn'), false);
  assert.equal(isRemoteRefreshableProvider('anthropic'), false);
  assert.equal(isRemoteRefreshableProvider('kimi-coding'), false);
  // 混合 API：单一 baseUrl 下多种 wire，推不出唯一鉴权与路径
  assert.equal(isRemoteRefreshableProvider('openrouter'), false);
  assert.equal(isRemoteRefreshableProvider('github-copilot'), false);
  assert.equal(isRemoteRefreshableProvider('fireworks'), false);
  // 非标准 API / 无 Provider 级地址
  assert.equal(isRemoteRefreshableProvider('google'), false);
  assert.equal(isRemoteRefreshableProvider('mistral'), false);
  assert.equal(isRemoteRefreshableProvider('opencode-go'), false);
  assert.equal(isRemoteRefreshableProvider('missing-provider'), false);

  // 目录下发的 refreshable 必须与判定一致（设置页按钮文案依赖它）
  const openaiCatalog = listPiAiProviderCatalog().find((p) => p.id === 'openai');
  assert.equal(openaiCatalog?.refreshable, true);
  assert.ok(openaiCatalog && openaiCatalog.models.length > 0);
}

// 6b. 能力归一化：远端声明的视觉、非对话分类、以及「只展示对话模型」
{
  const originalFetch = globalThis.fetch;
  const remotePayload = {
    data: [
      // OpenRouter 风格：架构里声明模态
      {
        id: 'mimo-v2.7-pro',
        architecture: { input_modalities: ['text', 'image'] },
        context_length: 512_000,
      },
      // 明确的文本专用
      { id: 'mimo-v2.7-lite', input_modalities: ['text'] },
      // 供应商完全不表态 → 不编造
      { id: 'mimo-v2.7-mystery' },
      // 非对话模型：必须被挡在对话目录之外，但准入名单仍记下 id
      { id: 'mimo-v2.5-asr' },
      { id: 'mimo-v2.5-tts' },
      { id: 'text-embedding-3-small' },
    ],
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(remotePayload), { status: 200 })) as typeof fetch;
  try {
    // 6b-1. 分类与视觉来自 /models 的原始解析（provider-url 层）
    const raw = await fetchAvailableModelCatalog(TOKEN_PLAN_BASE_URL, 'sk-mock');
    const byId = new Map(raw.map((m) => [m.id, m]));
    assert.equal(byId.get('mimo-v2.5-asr')?.category, 'audio', 'ASR 不能被当成对话模型');
    assert.equal(byId.get('mimo-v2.5-tts')?.category, 'audio');
    assert.equal(byId.get('text-embedding-3-small')?.category, 'embedding');
    assert.equal(byId.get('mimo-v2.7-pro')?.category, 'chat');
    assert.equal(byId.get('mimo-v2.7-pro')?.vision, true, '显式声明图片输入 → vision=true');
    assert.equal(byId.get('mimo-v2.7-pro')?.contextWindow, 512_000);
    assert.equal(byId.get('mimo-v2.7-lite')?.vision, false, '显式纯文本 → vision=false');
    assert.equal(
      byId.get('mimo-v2.7-mystery')?.vision,
      undefined,
      '供应商不表态时绝不猜（交设置页手工勾选）',
    );

    // 6b-2. 合并后的对话目录：非对话模型不出现
    const { catalog, remoteModelIds } = await fetchBuiltinProviderCatalog(
      'xiaomi-token-plan-cn',
      TOKEN_PLAN_BASE_URL,
      'sk-mock',
    );
    const shown = catalog.map((m) => m.id);
    assert.ok(shown.includes('mimo-v2.7-pro'), '远端独有的对话模型必须进目录');
    assert.ok(shown.includes('mimo-v2.6-pro'), '静态条目必须保留');
    assert.ok(!shown.includes('mimo-v2.5-asr'), 'ASR 不得进对话目录');
    assert.ok(!shown.includes('mimo-v2.5-tts'), 'TTS 不得进对话目录');
    assert.ok(!shown.includes('text-embedding-3-small'), 'embedding 不得进对话目录');

    // 准入名单仍记远端全部 id（只放宽校验，不决定展示）
    assert.ok(
      remoteModelIds.includes('mimo-v2.5-tts'),
      '准入名单保留非对话 id：分类是启发式，不阻断用户手动补入',
    );

    // 6b-3. 视觉能力穿过合并到达目录（静态条目仍以静态为准）
    const pro = catalog.find((m) => m.id === 'mimo-v2.7-pro');
    assert.equal(pro?.vision, true, '远端独有的对话模型应带上视觉能力');
    const staticFlash = catalog.find((m) => m.id === 'mimo-v2.6-flash');
    assert.equal(staticFlash?.vision, true, '静态条目的视觉能力不得被远端改写');
    const staticV25Pro = catalog.find((m) => m.id === 'mimo-v2.5-pro');
    assert.equal(staticV25Pro?.vision, false, '静态 text-only 模型不得被远端改写成有视觉');

    // 6b-4. 读缓存路径与实时路径同构（共用同一合并实现）
    const mergedCached = mergeCachedRemoteCatalog(listPiAiProviderCatalog(), {
      'xiaomi-token-plan-cn': {
        models: catalog,
        fetchedAt: '2026-10-09T00:00:00.000Z',
        stale: false,
      },
    });
    const cachedCn = mergedCached.find((p) => p.id === 'xiaomi-token-plan-cn');
    assert.ok(cachedCn);
    assert.deepEqual(
      cachedCn.models.map((m) => m.id),
      shown,
      '缓存路径与实时路径必须给出同构目录',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(
  'builtin-catalog-refresh: 内置补丁 / 远端合并 / 准入名单 / 运行时合成 / 启动缓存 / 能力归一化 全部通过',
);
