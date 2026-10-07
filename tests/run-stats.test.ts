// 确定性测试：Run/Session 统计投影 —— 步数去重、调用计数、耗时、用量聚合。

import assert from 'node:assert/strict';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import type { HostEvent } from '../src/host/run-events.js';
import { RunManager } from '../src/host/run-manager.js';
import { aggregateSessionStats, deriveRunStats, type RunStats } from '../src/host/run-stats.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { createHostServer } from '../src/host/server.js';

const base = { timestamp: '2026-09-06T00:00:00.000Z' };
const events: HostEvent[] = [
  { ...base, type: 'run_started', runId: 'r1' },
  {
    ...base,
    type: 'llm_call',
    step: 1,
    messageCount: 3,
    iteration: 1,
    response: '',
    hasToolCalls: true,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  },
  { ...base, type: 'tool_call', step: 1, tool: 'shell', args: {} },
  { ...base, type: 'tool_result', step: 1, tool: 'shell', result: 'ok', durationMs: 250 },
  {
    ...base,
    type: 'llm_call',
    step: 2,
    messageCount: 5,
    iteration: 2,
    response: '',
    hasToolCalls: true,
    usage: { inputTokens: 300, outputTokens: 120, totalTokens: 620, cacheReadTokens: 200 },
  },
  { ...base, type: 'tool_call', step: 2, tool: 'read', args: {} },
  { ...base, type: 'tool_result', step: 2, tool: 'read', result: 'x', durationMs: 80 },
  {
    ...base,
    type: 'llm_call',
    step: 3,
    messageCount: 7,
    iteration: 3,
    response: 'done',
    hasToolCalls: false,
    usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 999, totalTokens: 15 },
  },
  {
    ...base,
    type: 'assistant_delta',
    runId: 'r1',
    messageId: 'm',
    delta: 'a',
    timestamp: '2026-09-06T00:00:01.500Z',
  },
  {
    ...base,
    type: 'assistant_delta',
    runId: 'r1',
    messageId: 'm',
    delta: 'b',
    timestamp: '2026-09-06T00:00:02.500Z',
  },
  { ...base, type: 'run_completed', runId: 'r1', timestamp: '2026-09-06T00:00:05.000Z' },
];

{
  const stats = deriveRunStats(events);
  assert.equal(stats.llmCalls, 3);
  assert.equal(stats.toolCalls, 2);
  assert.equal(stats.steps, 3, '3 个去重 step');
  assert.equal(stats.toolMs, 330, '工具耗时求和 250+80');
  // 第 3 次 llm_call 的 usage 无效（reasoning > output）→ 不计数；前两次 150+620。
  assert.equal(stats.tokens, 150 + 620);
  assert.equal(stats.ttftMs, 1500, '首增量 1.5s − run_started 0');
  assert.equal(stats.decodeMs, 1000);
  assert.equal(stats.durationMs, 5000, 'run_started → run_completed');
}

{
  // 缺生命周期事件时用 createdAt/updatedAt 兜底；旧记录（仅 totalTokens）兼容。
  const legacy: HostEvent[] = [
    {
      ...base,
      type: 'llm_call',
      step: 1,
      messageCount: 1,
      iteration: 1,
      response: '',
      hasToolCalls: false,
      usage: { totalTokens: 77 } as never,
    },
  ];
  const stats = deriveRunStats(legacy, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:02.000Z');
  assert.equal(stats.tokens, 77);
  assert.equal(stats.durationMs, 2000);
  assert.equal(stats.ttftMs, undefined);
  assert.equal(stats.decodeMs, undefined);
}

{
  // 缺失的缓存分桶 ≠ 未命中：没上报的调用不许进命中率口径。
  // 实测踩过：14 次调用里有 6 次不返回 cacheReadTokens，按 0 计会得到 27%，
  // 而只算"真上报过的那 8 次"是 45%。
  const events: HostEvent[] = [
    {
      ...base,
      type: 'llm_call',
      step: 1,
      messageCount: 1,
      iteration: 1,
      response: '',
      hasToolCalls: false,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 115, cacheReadTokens: 100 },
    },
    {
      ...base,
      type: 'llm_call',
      step: 2,
      messageCount: 2,
      iteration: 2,
      response: '',
      hasToolCalls: false,
      usage: { inputTokens: 1000, outputTokens: 5, totalTokens: 1005 },
    },
  ];
  const stats = deriveRunStats(events);
  assert.equal(stats.cacheUsageCalls, 1, '只有一条上报了分桶');
  assert.equal(stats.cacheReadTokens, 100, '只累计上报过的调用');
  assert.equal(stats.inputTokens, 10, '未上报那条的输入不得进命中率分母');
  assert.equal(stats.tokens, 1120, '总量仍覆盖全部调用（115 + 1005）');
}

{
  // 聚合：turns = Run 数；可选字段按计数汇总供平均。
  const a: RunStats = {
    steps: 2,
    llmCalls: 1,
    toolCalls: 1,
    toolMs: 100,
    ttftMs: 800,
    decodeMs: 400,
    tokens: 300,
    inputTokens: 40,
    outputTokens: 60,
    cacheReadTokens: 180,
    cacheWriteTokens: 20,
    cacheUsageCalls: 1,
    durationMs: 2000,
  };
  const b: RunStats = {
    steps: 1,
    llmCalls: 1,
    toolCalls: 0,
    toolMs: 0,
    tokens: 100,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 70,
    cacheWriteTokens: 0,
    cacheUsageCalls: 1,
    durationMs: 1000,
  };
  const s = aggregateSessionStats([a, b], 2);
  assert.equal(s.turns, 2);
  assert.equal(s.steps, 3);
  assert.equal(s.llmCalls, 2);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.tokens, 400);
  assert.equal(s.durationMs, 3000);
  assert.equal(s.ttftMs, 800);
  assert.equal(s.ttftCount, 1, '只有 a 有首 token');
  assert.equal(s.decodeCount, 1);
  assert.equal(s.inputTokens, 50, '新增输入求和');
  assert.equal(s.outputTokens, 80, '输出求和（吞吐率分子）');
  assert.equal(s.cacheReadTokens, 250, '缓存命中求和');
  assert.equal(s.cacheWriteTokens, 20, '缓存写入求和');
  assert.equal(s.cacheUsageCalls, 2, '上报了分桶的调用数求和');
}

// ---- HTTP 端点冒烟：GET /sessions/:id/stats 走通 store → 折叠 → JSON ----
{
  const runtimeStore = new SqliteRunStore(':memory:', new MemorySecretStore());
  const server = createHostServer(
    new RunManager(runtimeStore),
    'test-token-00000000000000000000000000000000',
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const sessionId = 'sess-stats-001';
    const runId = 'run-stats-001';
    runtimeStore.createSession({
      sessionId,
      title: 'stats',
      workspaceRoot: '/tmp/x',
      workspaceName: '',
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    });
    runtimeStore.createRun({
      runId,
      sessionId,
      turnIndex: 1,
      task: 't',
      status: 'completed',
      workspaceRoot: '/tmp/x',
      workspaceName: '',
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:05.000Z',
      permissionMode: 'workspace-write',
    });
    for (const event of events) runtimeStore.appendEvent(runId, event);

    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/stats`);
    assert.equal(response.status, 200);
    const stats = (await response.json()) as Record<string, number>;
    assert.equal(stats.turns, 1);
    assert.equal(stats.llmCalls, 3);
    assert.equal(stats.toolCalls, 2);
    assert.equal(stats.steps, 3);
    assert.equal(stats.tokens, 150 + 620, '无效 usage 不计入');
    assert.equal(stats.ttftMs, 1500);
    assert.equal(stats.ttftCount, 1);
    assert.equal(stats.durationMs, 5000);

    const missing = await fetch(`http://127.0.0.1:${port}/sessions/does-not-exist/stats`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    runtimeStore.close();
  }
}

console.log('\nrun-stats tests: all PASS');
