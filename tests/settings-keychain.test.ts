// 模块: SecretStore/Keychain 契约测试 — Secret 隔离（Case 1/2/3/4/5/12）、
//       删除 Provider 同步清理 Secret（Case 11）、Run 的 ModelConfig 由 metadata + SecretStore 合成（Case 9）
// 用法: npx tsx tests/settings-keychain.test.ts（确定性，无真实网络；SecretStore = Memory）
// 来源: 自原 tests/settings.test.ts 按测试域拆出，用例原样搬移（未改任何测试逻辑与断言）。

import fs from 'node:fs';
import { providerSecretKey } from '../src/host/secrets/secret-store.js';
import {
  authHeaders,
  base,
  check,
  cleanupCheckpoint,
  delJSON,
  getJSON,
  getRunStatus,
  patchJSON,
  postJSON,
  reportAndExit,
  secretStore,
} from './helpers/settings-harness.js';

// ---- 测试开始 ----

(async () => {
  // 25. Secret 隔离：metadata 与凭证分离（Case 1/2/3/4/5/12）
  {
    const SECRET = 'PAYASO_TEST_SECRET_DO_NOT_LEAK_123';
    const leak = await postJSON(
      `${base}/settings/models`,
      {
        name: 'LeakProbe',
        baseUrl: 'https://api.leakprobe.com',
        apiKey: SECRET,
        models: ['leak-chat'],
      },
      201,
    );
    const secretKey = providerSecretKey(leak.id);

    // Case 1: Secret 在 SecretStore，不在 SQLite（含 WAL）的任何字节里
    check('Case1: secret lives in SecretStore', secretStore.get(secretKey) === SECRET);
    const dbPath = process.env.PAYASO_DB_PATH!;
    const dbBytes = fs.readFileSync(dbPath);
    const walBytes = fs.existsSync(`${dbPath}-wal`)
      ? fs.readFileSync(`${dbPath}-wal`)
      : Buffer.alloc(0);
    check(
      'Case1: raw SQLite (main+WAL) contains no secret',
      !dbBytes.includes(SECRET) && !walBytes.includes(SECRET),
    );

    // Case 2: GET settings 不返回 key（即便 SecretStore 里有）
    const listJson = JSON.stringify(await (await fetch(`${base}/settings/models`)).json());
    check('Case2: settings list JSON contains no secret', !listJson.includes(SECRET));

    // Case 3: 只改 metadata → Secret 保持原值
    await patchJSON(`${base}/settings/models/${leak.id}`, { name: 'LeakProbe Renamed' });
    check('Case3: metadata-only edit keeps secret', secretStore.get(secretKey) === SECRET);

    // Case 4: 替换 → SecretStore 为新值；旧值不出现在任何 settings JSON
    await patchJSON(`${base}/settings/models/${leak.id}`, { apiKey: `${SECRET}-v2` });
    check('Case4: secret replaced in SecretStore', secretStore.get(secretKey) === `${SECRET}-v2`);
    const afterReplaceList = await getJSON(`${base}/settings/models`);
    const afterReplace = JSON.stringify(afterReplaceList.models.find((m: any) => m.id === leak.id));
    check(
      'Case4: old/new keys absent from settings JSON',
      Boolean(afterReplace) &&
        !afterReplace.includes(SECRET) &&
        !afterReplace.includes(`${SECRET}-v2`),
    );

    // Case 5: 显式清除 → Secret 删除 + hasApiKey=false
    await patchJSON(`${base}/settings/models/${leak.id}`, { apiKey: null });
    check('Case5: secret deleted from SecretStore', secretStore.get(secretKey) === null);
    const clearedView = (await getJSON(`${base}/settings/models`)).models.find(
      (m: any) => m.id === leak.id,
    );
    check('Case5: hasApiKey=false after clear', clearedView?.hasApiKey === false);

    // Case 12: 走完一整轮 Run 后，secret 不出现在 SSE 事件/Run JSON/settings/SQLite 序列化里
    const sweep = await postJSON(
      `${base}/settings/models`,
      {
        name: 'SweepProvider',
        baseUrl: 'https://api.sweep-provider.com/v1',
        apiKey: SECRET,
        models: ['sweep-chat'],
      },
      201,
    );
    await postJSON(`${base}/settings/default`, { providerId: sweep.id, model: 'sweep-chat' }, 200);
    const originalFetch = globalThis.fetch;
    let runId12 = '';
    try {
      globalThis.fetch = (async (input, init) => {
        if (String(input).includes('api.sweep-provider.com')) {
          const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
          check('Case12: run request used the SecretStore credential', auth === `Bearer ${SECRET}`);
          return new Response(
            JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'swept' } }] }),
            { status: 200 },
          );
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      const created12 = await postJSON(`${base}/runs`, { task: 'secret sweep' }, 202);
      runId12 = created12.runId;
      const deadline = Date.now() + 10000;
      let status12 = 'running';
      while (Date.now() < deadline) {
        status12 = (await getRunStatus(runId12)).status;
        if (status12 !== 'running' && status12 !== 'stopping') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      check(
        'Case12: run completed through SecretStore credential',
        status12 === 'completed',
        `status=${status12}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    const runJson = JSON.stringify(
      await (await fetch(`${base}/runs/${runId12}`, { headers: await authHeaders() })).json(),
    );
    const eventsText = await (
      await fetch(`${base}/runs/${runId12}/events?live=0`, { headers: await authHeaders() })
    ).text();
    const settingsAll = JSON.stringify(
      await (await fetch(`${base}/settings/models`, { headers: await authHeaders() })).json(),
    );
    const dbAfter = fs.readFileSync(dbPath);
    check(
      'Case12: no secret in run JSON / SSE events / settings / SQLite',
      !runJson.includes(SECRET) &&
        !eventsText.includes(SECRET) &&
        !settingsAll.includes(SECRET) &&
        !dbAfter.includes(SECRET),
    );
    cleanupCheckpoint(runId12);
  }

  // 26. Case 11: 删除 Provider → SecretStore 同步清理
  {
    const del = await postJSON(
      `${base}/settings/models`,
      {
        name: 'DelProbe',
        baseUrl: 'https://api.delprobe.com',
        apiKey: 'sk-del-probe',
        models: ['d1'],
      },
      201,
    );
    check(
      'Case11 pre: secret exists',
      secretStore.get(providerSecretKey(del.id)) === 'sk-del-probe',
    );
    await delJSON(`${base}/settings/models/${del.id}`);
    check(
      'Case11: provider deletion cleans secret',
      secretStore.get(providerSecretKey(del.id)) === null,
    );
  }

  // 28. Case 9: Run 的 ModelConfig 由 metadata + SecretStore 合成
  {
    const originalFetch = globalThis.fetch;
    let authHeader = '';
    try {
      globalThis.fetch = (async (input, init) => {
        if (String(input).includes('api.resolution-provider.com')) {
          authHeader = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
          return new Response(
            JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'resolved' } }] }),
            { status: 200 },
          );
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      const prov = await postJSON(
        `${base}/settings/models`,
        {
          name: 'ResolutionProvider',
          baseUrl: 'https://api.resolution-provider.com/v1',
          apiKey: 'sk-resolution-42',
          models: ['res-chat'],
        },
        201,
      );
      await postJSON(`${base}/settings/default`, { providerId: prov.id, model: 'res-chat' }, 200);
      const created9 = await postJSON(`${base}/runs`, { task: '解析凭证' }, 202);
      const deadline = Date.now() + 10000;
      let status9 = 'running';
      while (Date.now() < deadline) {
        status9 = (await getRunStatus(created9.runId)).status;
        if (status9 !== 'running' && status9 !== 'stopping') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      check(
        'Case9: run completed with merged ModelConfig',
        status9 === 'completed',
        `status=${status9}`,
      );
      check(
        'Case9: Authorization used SecretStore value',
        authHeader === 'Bearer sk-resolution-42',
        `got ${authHeader}`,
      );
      cleanupCheckpoint(created9.runId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  reportAndExit();
})();
