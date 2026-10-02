// 套件: 前端底部统计条 — StatsBar 依赖的 sessionStatsGroups / sessionStatsDetails
// 用法: node --import tsx tests/frontend-stats-bar.test.ts
// 覆盖：零值片段省略、两分组归属（活动：回合/步/吞吐；用量：总量/缓存命中率）、
//   吞吐与缓存命中率的计算与缺省条件、明细（调用数/首 token/活跃）移入悬停、
//   语言跟随（zh-CN / en-US）、空统计 → 两组皆空（整条不渲染）。
//
// 布局口径（对齐 DSH 状态条）：条上只留"一眼要看的"——回合、步、tok/s、
// 总量、缓存命中率、上下文环；调用数与耗时移入悬停提示。

import assert from 'node:assert/strict';
import {
  sessionStatsDetails,
  sessionStatsGroups,
} from '../web/src/components/StatsBar/session-stats-view.js';
import type { SessionStats } from '../web/src/types.js';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    turns: 0,
    steps: 0,
    llmCalls: 0,
    toolCalls: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftCount: 0,
    decodeMs: 0,
    decodeCount: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
    ...overrides,
  };
}

check('空统计 → 两组皆空（组件整条不渲染）', () => {
  const [activity, usage] = sessionStatsGroups(stats());
  assert.deepEqual(activity, []);
  assert.deepEqual(usage, []);
  assert.deepEqual(sessionStatsDetails(stats()), []);
});

check('活动组：回合 · 步 · 吞吐（调用数不再占条）', () => {
  const [activity] = sessionStatsGroups(
    stats({ turns: 3, steps: 12, llmCalls: 5, toolCalls: 7, outputTokens: 600, decodeMs: 4_000 }),
  );
  assert.deepEqual(activity, ['3 回合', '12 步', '150 tok/s']);
  assert.ok(
    !activity.some((s) => s.includes('LLM') || s.includes('工具')),
    '调用数/工具数应移入悬停明细，不占条',
  );
});

check('用量组：总量 · 缓存命中率', () => {
  const [, usage] = sessionStatsGroups(
    stats({ tokens: 12_300, inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 }),
  );
  assert.equal(usage[0], '12.3K tok');
  assert.equal(usage[1], '缓存命中 90%');
});

check('缓存命中率含缓存写入：读 ÷ (新增 + 读 + 写)', () => {
  const [, usage] = sessionStatsGroups(
    stats({ tokens: 1, inputTokens: 250, cacheReadTokens: 750, cacheWriteTokens: 1_000 }),
  );
  // 750 / 2000 = 37.5% → 38%
  assert.equal(usage[1], '缓存命中 38%');
});

check('吞吐缺省条件：没有解码耗时 / 没有输出 token 时不显示', () => {
  assert.deepEqual(sessionStatsGroups(stats({ outputTokens: 500 }))[0], [], '无 decodeMs');
  assert.deepEqual(sessionStatsGroups(stats({ decodeMs: 1_000 }))[0], [], '无 outputTokens');
});

check('旧记录（拆不出分桶）不显示缓存命中，而不是显示 0%', () => {
  const [, usage] = sessionStatsGroups(stats({ tokens: 999 }));
  assert.deepEqual(usage, ['999 tok'], '宁缺勿错：分母为 0 时不渲染 0%');
});

check('明细：调用数 / 首 token 取平均 / 活跃时长', () => {
  const details = sessionStatsDetails(
    stats({ llmCalls: 5, toolCalls: 7, ttftMs: 4_000, ttftCount: 4, durationMs: 30_000 }),
  );
  assert.deepEqual(details.slice(0, 2), ['5 LLM', '7 工具']);
  const firstToken = details.find((d) => d.startsWith('首token ')) ?? '';
  assert.ok(!firstToken.includes('4秒'), `首 token 取平均（4000÷4=1s），实际 ${firstToken}`);
  assert.ok(
    details.some((d) => d.startsWith('活跃 ')),
    details.join(' | '),
  );
});

check('en-US 走英文读数', () => {
  const [activity, usage] = sessionStatsGroups(
    stats({
      turns: 2,
      steps: 3,
      tokens: 1_000,
      outputTokens: 200,
      decodeMs: 2_000,
      inputTokens: 10,
      cacheReadTokens: 90,
    }),
    'en-US',
  );
  assert.deepEqual(activity, ['2 turns', '3 steps', '100 tok/s']);
  assert.deepEqual(usage, ['1K tok', '90% cached']);
  assert.deepEqual(sessionStatsDetails(stats({ toolCalls: 1 }), 'en-US'), ['1 tools']);
});

console.log(`\nfrontend-stats-bar 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
