import assert from 'node:assert/strict';
import { fetchRunEvents } from '../web/src/api.js';

// 契约：Run 事件快照请求**只合并在途请求**，落定后立即从合并表移除。
// 前者避免 React StrictMode（开发构建的 effect 双执行）把同一份可达数百 KB 的快照
// 请求两遍；后者保证不会返回陈旧数据——终态 Run 的事件虽然不可变，但一旦 Run 被
// resume 就不再走快照路径，缓存结果会埋下隐患。

let fetchCalls = 0;
const resolvers: Array<() => void> = [];

function stubFetch(): void {
  globalThis.fetch = ((_url: string) => {
    fetchCalls++;
    return new Promise((resolve) => {
      resolvers.push(() =>
        resolve({
          ok: true,
          status: 200,
          json: async () => ({
            events: [{ type: 'run_started', runId: 'r1', timestamp: '2026-09-11T00:00:00.000Z' }],
          }),
        }),
      );
    });
  }) as unknown as typeof fetch;
}

/** 放行所有在途请求，并等待其落定。 */
async function settle(): Promise<void> {
  const batch = resolvers.splice(0, resolvers.length);
  for (const resolve of batch) resolve();
  await new Promise((r) => setTimeout(r, 0));
}

const cases: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: '同一 Run 的在途快照请求被合并为一次 fetch',
    run: async () => {
      stubFetch();
      fetchCalls = 0;
      const first = fetchRunEvents('r1');
      const second = fetchRunEvents('r1');
      assert.equal(fetchCalls, 1, '在途期间发起了重复请求');
      assert.equal(first, second, '在途请求应返回同一个 Promise（调用方各 await 一次即可）');
      await settle();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.events.length, 1);
      assert.equal(b.events.length, 1);
    },
  },
  {
    name: '落定后不再合并（不存在陈旧结果缓存）',
    run: async () => {
      stubFetch();
      fetchCalls = 0;
      const first = fetchRunEvents('r1');
      await settle();
      await first;
      assert.equal(fetchCalls, 1);

      const second = fetchRunEvents('r1');
      assert.equal(fetchCalls, 2, '落定后的新请求必须重新发起');
      await settle();
      await second;
    },
  },
  {
    name: '不同 Run 之间互不合并',
    run: async () => {
      stubFetch();
      fetchCalls = 0;
      const a = fetchRunEvents('r1');
      const b = fetchRunEvents('r2');
      assert.equal(fetchCalls, 2, '不同 Run 被错误合并');
      await settle();
      await Promise.all([a, b]);
    },
  },
  {
    name: '请求失败后合并表被清空（允许重试）',
    run: async () => {
      globalThis.fetch = (() => {
        fetchCalls++;
        return Promise.resolve({ ok: false, status: 500, text: async () => 'boom' });
      }) as unknown as typeof fetch;
      fetchCalls = 0;
      await assert.rejects(() => fetchRunEvents('r1'));
      assert.equal(fetchCalls, 1);
      await assert.rejects(() => fetchRunEvents('r1'), '失败后应能重新发起');
      assert.equal(fetchCalls, 2, '失败的请求残留在合并表里，导致无法重试');
    },
  },
];

for (const item of cases) {
  await item.run();
  console.log(`  [PASS] ${item.name}`);
}

console.log(`\nFrontend run-events tests: ${cases.length} PASS / 0 FAIL`);
