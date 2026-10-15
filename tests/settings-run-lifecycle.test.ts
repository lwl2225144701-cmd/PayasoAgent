// 模块: Run 生命周期 — Resume 必须使用当前完整 provider 配置（禁止历史 baseUrl）+
//       Host 关闭（停止接受新 Run、取消活跃 Run、原子终态）测试
// 用法: npx tsx tests/settings-run-lifecycle.test.ts（确定性，无真实网络；SecretStore = Memory）
// 来源: 自原 tests/settings.test.ts 按测试域拆出，用例原样搬移（未改任何测试逻辑与断言）。
//       注: 关闭用例调用 manager.close()，必须排在文件末尾（其后无其它依赖 RunManager 的用例）。

import {
  base,
  check,
  cleanupCheckpoint,
  getRunStatus,
  manager,
  patchJSON,
  postJSON,
  reportAndExit,
} from './helpers/settings-harness.js';

// ---- 测试开始 ----

(async () => {
  // 31. Resume 安全：必须使用当前完整 provider 配置，禁止历史 baseUrl
  {
    const originalFetch = globalThis.fetch;
    let lastBaseUrl = '';
    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.includes('api.resume-test.com') || url.includes('api.new-base.com')) {
          lastBaseUrl = url;
          return new Response(
            JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'resumed' } }] }),
            { status: 200 },
          );
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      // 创建 provider 并设为默认
      const prov = await postJSON(
        `${base}/settings/models`,
        {
          name: 'ResumeTestProvider',
          baseUrl: 'https://api.resume-test.com/v1',
          apiKey: 'sk-resume-test',
          models: ['resume-chat'],
        },
        201,
      );
      await postJSON(
        `${base}/settings/default`,
        { providerId: prov.id, model: 'resume-chat' },
        200,
      );

      // 创建 Run
      const run = await postJSON(`${base}/runs`, { task: 'resume test' }, 202);
      const deadline = Date.now() + 10000;
      let status = 'running';
      while (Date.now() < deadline) {
        status = (await getRunStatus(run.runId)).status;
        if (status !== 'running' && status !== 'stopping') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      check('Resume: initial run completed', status === 'completed', `status=${status}`);

      // 修改 provider baseUrl
      await patchJSON(
        `${base}/settings/models/${prov.id}`,
        { baseUrl: 'https://api.new-base.com/v1' },
        200,
      );

      // Resume Run → 应使用新 baseUrl，而非历史 baseUrl
      const resumed = await postJSON(`${base}/runs/${run.runId}/resume`, {}, 202);
      check('Resume: accepted', !!resumed.runId);

      const deadline2 = Date.now() + 10000;
      let status2 = 'running';
      while (Date.now() < deadline2) {
        status2 = (await getRunStatus(run.runId)).status;
        if (status2 !== 'running' && status2 !== 'stopping') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      check(
        'Resume: run completed after baseUrl change',
        status2 === 'completed',
        `status=${status2}`,
      );
      check(
        'Resume: used current baseUrl',
        lastBaseUrl.includes('api.new-base.com'),
        `got ${lastBaseUrl}`,
      );
      cleanupCheckpoint(run.runId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 32. Host 关闭：停止接受新 Run，取消活跃 Run，原子终态
  {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input, init) => {
        if (String(input).includes('api.slow-echo.com')) {
          await new Promise((r) => setTimeout(r, 5000));
          return new Response(
            JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'late' } }] }),
            { status: 200 },
          );
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      const prov = await postJSON(
        `${base}/settings/models`,
        {
          name: 'SlowProvider',
          baseUrl: 'https://api.slow-echo.com/v1',
          apiKey: 'sk-slow',
          models: ['slow-chat'],
        },
        201,
      );

      // 显式绑定默认模型：否则 resolveModelConfig 会选中历史测试留下的
      // 第一个可用 provider（如 resume-test），导致 LLM 请求发往错误 baseUrl，
      // mock 的 api.slow-echo.com 分支不命中 → 真实网络 fetch failed → Run failed。
      await postJSON(`${base}/settings/default`, { providerId: prov.id, model: 'slow-chat' }, 200);

      const run = await postJSON(`${base}/runs`, { task: 'slow task' }, 202);
      const deadline = Date.now() + 3000;
      let status = 'running';
      while (Date.now() < deadline) {
        status = (await getRunStatus(run.runId)).status;
        if (status !== 'running' && status !== 'stopping') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      check('Shutdown: run started', status === 'running' || status === 'stopping');

      // 直接关闭 RunManager（不关 server），验证活跃 Run 被取消
      await manager.close();
      await new Promise((r) => setTimeout(r, 500));

      const raw = manager.getRaw(run.runId);
      const finalStatus = raw ? raw.status : 'missing';
      check(
        'Shutdown: run stopped/cancelled',
        finalStatus === 'stopped' || finalStatus === 'interrupted',
        `got ${finalStatus}`,
      );
      cleanupCheckpoint(run.runId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  reportAndExit();
})();
