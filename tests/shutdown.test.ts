// 模块: RunManager 异步关闭幂等性测试

import http from 'node:http';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import { RunManager } from '../src/host/run-manager.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { createHostServer } from '../src/host/server.js';

const TEST_TOKEN = 'test-token-00000000000000000000000000000000';

async function startHost(): Promise<{
  port: number;
  manager: RunManager;
  server: ReturnType<typeof createHostServer>;
}> {
  const secretStore = new MemorySecretStore();
  const store = new SqliteRunStore(':memory:', secretStore);
  const manager = new RunManager(store);
  const server = createHostServer(manager, TEST_TOKEN);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, manager, server };
}

function httpRequest(
  port: number,
  options: {
    method?: string;
    path?: string;
    authorization?: string;
    body?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: {
          'Content-Type': 'application/json',
          ...(options.authorization ? { Authorization: options.authorization } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function runTests() {
  const host = await startHost();
  let passed = 0;
  let failed = 0;
  function check(name: string, cond: boolean, detail = ''): void {
    if (cond) {
      passed++;
      console.log(`  [PASS] ${name}`);
    } else {
      failed++;
      console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
    }
  }

  try {
    // 1. close() 幂等
    {
      const p1 = host.manager.close();
      const p2 = host.manager.close();
      await p1;
      await p2;
      // close() 后 manager 不再接受新 Run（createInSession 会抛异常）
      let rejected = false;
      try {
        host.manager.createInSession('test', undefined, { startAgent: false });
      } catch {
        rejected = true;
      }
      check('close() idempotent', rejected);
    }

    // 2. close() 后不接受新 Run
    {
      const res = await httpRequest(host.port, {
        method: 'POST',
        path: '/runs',
        authorization: `Bearer ${TEST_TOKEN}`,
        body: JSON.stringify({ task: 'test' }),
      });
      check(
        'reject new run after close',
        res.status === 400 || res.status === 503,
        `got ${res.status}`,
      );
    }

    // 3. 生命周期状态机（close 后 createInSession 必须拒绝）
    {
      let rejected = false;
      try {
        host.manager.createInSession('test2', undefined, { startAgent: false });
      } catch {
        rejected = true;
      }
      check('closed state rejects new runs', rejected);
    }
  } finally {
    await host.manager.close();
    await new Promise<void>((resolve, reject) =>
      host.server.close(() => resolve()).on('error', reject),
    );
  }

  console.log(`\nShutdown 测试汇总: ${passed} PASS / ${failed} FAIL`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Shutdown test error:', err);
  process.exit(1);
});
