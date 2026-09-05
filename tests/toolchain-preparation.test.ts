// 受控工具链准备协议测试。
// 覆盖：固定白名单、用户拒绝路径、SSE 申请/完成事件、HTTP 鉴权回传，
// 以及未知工具不能进入安装计划。批准路径不在确定性套件中触发真实 brew。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import type { HostEvent } from '../src/host/run-events.js';
import { RunManager, type SseSink } from '../src/host/run-manager.js';
import { createHostServer } from '../src/host/server.js';
import { setNetworkMode } from '../src/network-mode.js';
import { hasSufficientDiskSpace } from '../src/sandbox/macos-toolchain-preparer.js';
import type { RuntimeToolchainCapabilities } from '../src/sandbox/toolchain-manager.js';
import {
  denyAllToolchainPreparationPort,
  getToolchainPreparationPlan,
  type ToolchainPreparationResult,
} from '../src/sandbox/toolchain-preparation.js';

// 测试机器可能真的装了 git/node —— 固定注入"git 缺失"快照，让请求走完整准备流
const gitMissingProvider = (): RuntimeToolchainCapabilities => ({
  platform: 'macos',
  discovery: 'startup',
  tools: {
    git: { status: 'missing', reason: 'not_found' },
    node: { status: 'available' },
    npm: { status: 'available' },
  },
});

const manager = new RunManager(new SqliteRunStore(':memory:'), undefined, gitMissingProvider);
const runId = manager.createInSession('toolchain preparation', undefined, {
  startAgent: false,
}).runId;
const received: HostEvent[] = [];
const sink: SseSink = {
  write: (chunk) => {
    const match = chunk.match(/data: (.+)\n\n/s);
    if (!match) return;
    try {
      received.push(JSON.parse(match[1]) as HostEvent);
    } catch {
      /* ignore malformed test data */
    }
  },
  end: () => {},
  closed: () => false,
};
manager.subscribe(runId, sink, 0, true);

try {
  assert.deepEqual(getToolchainPreparationPlan('git'), {
    toolName: 'git',
    packageName: 'git',
    source: 'homebrew',
    displayName: 'Git',
  });
  assert.equal(getToolchainPreparationPlan('npm')?.packageName, 'node');
  assert.equal(getToolchainPreparationPlan('curl'), undefined);

  setNetworkMode('off');
  try {
    const networkBlocked = await manager.toolchainPreparationPort().request({
      runId,
      toolName: 'git',
      packageName: 'git',
      source: 'homebrew',
      timestamp: new Date().toISOString(),
    });
    assert.equal(networkBlocked.status, 'unavailable');
    assert.equal(networkBlocked.prepared, false);
  } finally {
    setNetworkMode('on');
  }

  const denied = await denyAllToolchainPreparationPort.request({
    runId,
    toolName: 'git',
    packageName: 'git',
    source: 'homebrew',
    timestamp: new Date().toISOString(),
  });
  assert.deepEqual(denied, {
    approved: false,
    prepared: false,
    status: 'denied',
    message: 'Dependency preparation was not authorized.',
  });

  const port = manager.toolchainPreparationPort();
  const pending = port.request({
    runId,
    toolName: 'git',
    packageName: 'git',
    source: 'homebrew',
    timestamp: new Date().toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const requested = received.find((event) => event.type === 'toolchain_preparation_requested');
  assert.ok(requested && requested.requestId.length > 0);
  assert.equal(requested?.toolName, 'git');
  assert.equal(requested?.packageName, 'git');
  assert.equal(manager.resolveToolchainPreparation(runId, requested!.requestId, false), true);
  assert.deepEqual(await pending, {
    approved: false,
    prepared: false,
    status: 'denied',
    message: 'Dependency preparation was not authorized.',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const resolved = received.find((event) => event.type === 'toolchain_preparation_resolved');
  assert.ok(resolved);
  assert.equal(resolved?.approved, false);
  assert.equal(resolved?.prepared, false);
  assert.equal(manager.resolveToolchainPreparation(runId, requested!.requestId, true), false);

  const server = createHostServer(manager, 'toolchain-token');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const portNumber = (server.address() as { port: number }).port;
  try {
    const unsupported = await port.request({
      runId,
      toolName: 'curl' as 'git',
      packageName: 'curl',
      source: 'homebrew',
      timestamp: new Date().toISOString(),
    });
    assert.equal(unsupported.status, 'unavailable');
    assert.equal(unsupported.prepared, false);

    const next = port.request({
      runId,
      toolName: 'git',
      packageName: 'git',
      source: 'homebrew',
      timestamp: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const nextRequest = received
      .filter((event) => event.type === 'toolchain_preparation_requested')
      .pop();
    assert.ok(nextRequest);
    const response = await fetch(
      `http://127.0.0.1:${portNumber}/runs/${runId}/toolchain-preparation`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer toolchain-token',
          Origin: `http://127.0.0.1:${portNumber}`,
        },
        body: JSON.stringify({ requestId: nextRequest!.requestId, approved: false }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { resolved: boolean }).resolved, true);
    assert.equal((await next).status, 'denied');

    const cancelPending = port.request({
      runId,
      toolName: 'git',
      packageName: 'git',
      source: 'homebrew',
      timestamp: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelRequest = received
      .filter((event) => event.type === 'toolchain_preparation_requested')
      .pop();
    assert.ok(cancelRequest);
    const cancelResponse = await fetch(
      `http://127.0.0.1:${portNumber}/runs/${runId}/toolchain-preparation`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer toolchain-token',
          Origin: `http://127.0.0.1:${portNumber}`,
        },
        body: JSON.stringify({ requestId: cancelRequest!.requestId, cancel: true }),
      },
    );
    assert.equal(cancelResponse.status, 200);
    assert.equal(((await cancelResponse.json()) as { cancelled: boolean }).cancelled, true);
    assert.equal((await cancelPending).status, 'aborted');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  const phaseManager = new RunManager(
    new SqliteRunStore(':memory:'),
    async (_plan, signal, onPhase): Promise<ToolchainPreparationResult> => {
      onPhase?.('installing');
      return new Promise<ToolchainPreparationResult>((resolve) => {
        signal?.addEventListener(
          'abort',
          () => {
            resolve({
              approved: true,
              prepared: false,
              status: 'aborted',
              message: 'Dependency preparation was cancelled.',
            });
          },
          { once: true },
        );
      });
    },
    gitMissingProvider,
  );
  const phaseRunId = phaseManager.createInSession('toolchain preparation phases', undefined, {
    startAgent: false,
  }).runId;
  const phaseEvents: HostEvent[] = [];
  const phaseSink: SseSink = {
    write: (chunk) => {
      const match = chunk.match(/data: (.+)\n\n/s);
      if (!match) return;
      try {
        phaseEvents.push(JSON.parse(match[1]) as HostEvent);
      } catch {
        /* ignore malformed test data */
      }
    },
    end: () => {},
    closed: () => false,
  };
  phaseManager.subscribe(phaseRunId, phaseSink, 0, true);
  try {
    const phasePending = phaseManager.toolchainPreparationPort().request({
      runId: phaseRunId,
      toolName: 'git',
      packageName: 'git',
      source: 'homebrew',
      timestamp: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const phaseRequest = phaseEvents.find(
      (event) => event.type === 'toolchain_preparation_requested',
    );
    assert.ok(phaseRequest);
    assert.equal(
      phaseManager.resolveToolchainPreparation(phaseRunId, phaseRequest!.requestId, true),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(phaseEvents.some((event) => event.type === 'toolchain_preparation_started'));
    assert.ok(
      phaseEvents.some(
        (event) => event.type === 'toolchain_preparation_progress' && event.phase === 'installing',
      ),
    );
    assert.equal(
      phaseManager.cancelToolchainPreparation(phaseRunId, phaseRequest!.requestId),
      true,
    );
    assert.equal((await phasePending).status, 'aborted');
    assert.ok(
      phaseEvents.some(
        (event) => event.type === 'toolchain_preparation_resolved' && event.status === 'aborted',
      ),
    );
  } finally {
    phaseManager.unsubscribe(phaseRunId, phaseSink);
    await phaseManager.close();
  }
} finally {
  manager.unsubscribe(runId, sink);
  await manager.close();
}

// ---- v1.6 闭环③：同 packageName 并发请求合并，只触发一次安装 ----
{
  let installs = 0;
  const mergeManager = new RunManager(
    new SqliteRunStore(':memory:'),
    async (): Promise<ToolchainPreparationResult> => {
      installs++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { approved: true, prepared: true, status: 'prepared' };
    },
    gitMissingProvider,
  );
  const runA = mergeManager.createInSession('merge-a', undefined, { startAgent: false }).runId;
  const runB = mergeManager.createInSession('merge-b', undefined, { startAgent: false }).runId;
  const portA = mergeManager.toolchainPreparationPort();
  const mk = (runId: string) => ({
    runId,
    toolName: 'git' as const,
    packageName: 'git',
    source: 'homebrew' as const,
    timestamp: new Date().toISOString(),
  });

  const [resultA, resultB] = await Promise.all([
    (async () => {
      const pendingA = portA.request(mk(runA));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const eventsA: HostEvent[] = [];
      mergeManager.subscribe(
        runA,
        {
          write: (c) => {
            const m = c.match(/data: (.+)\n\n/s);
            if (m) eventsA.push(JSON.parse(m[1]) as HostEvent);
          },
          end: () => {},
          closed: () => false,
        },
        0,
        true,
      );
      const requestedA = eventsA.find((e) => e.type === 'toolchain_preparation_requested');
      assert.ok(requestedA);
      // 用户批准 A —— 合并等待者 B 共享同一次安装结果，无需再次批准
      assert.equal(
        mergeManager.resolveToolchainPreparation(runA, requestedA.requestId, true),
        true,
      );
      return pendingA;
    })(),
    portA.request(mk(runB)), // 与 A 并发：必须合并到同一次安装
  ]);
  assert.ok(installs === 1, 'merge: 并发同包请求只触发一次安装');
  assert.ok(resultA.prepared && resultB.prepared, 'merge: 两个请求都 prepared 且共享结果');
  assert.ok(
    (() => {
      const eventsA: HostEvent[] = [];
      const eventsB: HostEvent[] = [];
      mergeManager.subscribe(
        runA,
        {
          write: (c) => {
            const m = c.match(/data: (.+)\n\n/s);
            if (m) eventsA.push(JSON.parse(m[1]));
          },
          end: () => {},
          closed: () => false,
        },
        0,
        false,
      );
      mergeManager.subscribe(
        runB,
        {
          write: (c) => {
            const m = c.match(/data: (.+)\n\n/s);
            if (m) eventsB.push(JSON.parse(m[1]));
          },
          end: () => {},
          closed: () => false,
        },
        0,
        false,
      );
      return (
        eventsA.some((e) => e.type === 'toolchain_preparation_resolved') &&
        eventsB.some((e) => e.type === 'toolchain_preparation_resolved')
      );
    })(),
    'merge: 两个 Run 都收到 resolved 事件',
  );
  await mergeManager.close();
}

// ---- v1.6 闭环③：拒绝共享 —— 首个被拒绝时，合并等待者同样拿到 denied ----
{
  let installs = 0;
  const denyManager = new RunManager(
    new SqliteRunStore(':memory:'),
    async (): Promise<ToolchainPreparationResult> => {
      installs++;
      return { approved: true, prepared: true, status: 'prepared' };
    },
    gitMissingProvider,
  );
  const runA = denyManager.createInSession('deny-a', undefined, { startAgent: false }).runId;
  const runB = denyManager.createInSession('deny-b', undefined, { startAgent: false }).runId;
  const port = denyManager.toolchainPreparationPort();
  const mk = (runId: string) => ({
    runId,
    toolName: 'git' as const,
    packageName: 'git',
    source: 'homebrew' as const,
    timestamp: new Date().toISOString(),
  });
  const pendingA = port.request(mk(runA));
  const pendingB = port.request(mk(runB));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const eventsA: HostEvent[] = [];
  denyManager.subscribe(
    runA,
    {
      write: (c) => {
        const m = c.match(/data: (.+)\n\n/s);
        if (m) eventsA.push(JSON.parse(m[1]) as HostEvent);
      },
      end: () => {},
      closed: () => false,
    },
    0,
    true,
  );
  const requestedA = eventsA.find((e) => e.type === 'toolchain_preparation_requested');
  assert.ok(requestedA);
  assert.equal(denyManager.resolveToolchainPreparation(runA, requestedA.requestId, false), true);
  const [resultA, resultB] = await Promise.all([pendingA, pendingB]);
  assert.ok(
    resultA.status === 'denied' && resultB.status === 'denied',
    'deny merge: 首个拒绝 → 合并等待者共享 denied',
  );
  assert.ok(installs === 0, 'deny merge: 拒绝路径不触发安装');
  await denyManager.close();
}

// ---- v1.6 闭环④a：快照显示工具已可用 → 短路 prepared，不触发安装 ----
{
  let installs = 0;
  const availableManager = new RunManager(
    new SqliteRunStore(':memory:'),
    async (): Promise<ToolchainPreparationResult> => {
      installs++;
      return { approved: true, prepared: true, status: 'prepared' };
    },
    () => ({
      platform: 'macos',
      discovery: 'startup',
      tools: {
        git: { status: 'available' },
        node: { status: 'available' },
        npm: { status: 'available' },
      },
    }),
  );
  const runId = availableManager.createInSession('avail', undefined, { startAgent: false }).runId;
  const result = await availableManager.toolchainPreparationPort().request({
    runId,
    toolName: 'git',
    packageName: 'git',
    source: 'homebrew',
    timestamp: new Date().toISOString(),
  });
  assert.ok(result.prepared === true && installs === 0, '④a: 已可用 → 短路 prepared 且不触发安装');
  assert.ok(result.capabilities?.tools.git.status === 'available', '④a: 短路结果携带实时能力快照');
  await availableManager.close();
}

// ---- v1.6 闭环④：磁盘空间检查 ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-disk-'));
  assert.ok(hasSufficientDiskSpace(dir, 1024 * 1024), 'disk: 真实目录 + 1MB 门槛 → 满足');
  assert.ok(!hasSufficientDiskSpace(dir, 2 ** 60), 'disk: 超过剩余空间的门槛 → 不满足');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('Toolchain preparation tests: PASS');
