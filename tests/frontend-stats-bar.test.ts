// 套件: 前端底部统计条 — StatsBar 依赖的 sessionStatsGroups（纯函数，无 DOM）
// 用法: node --import tsx tests/frontend-stats-bar.test.ts
// 覆盖：零值片段自动省略、两分组归属（执行规模 / 用量耗时）、首 token 取平均、
//   语言跟随（zh-CN / en-US）、空统计 → 两组皆空（整条不渲染）
// 说明：v2.3 起统计条从顶栏挪到 composer 下方，读数口径与顶栏时代完全一致，
//   本套件锁住"挪位置不改口径"。

import assert from 'node:assert/strict';
import { sessionStatsGroups } from '../web/src/components/StatsBar/session-stats-view.js';
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
    durationMs: 0,
    ...overrides,
  };
}

check('空统计 → 两组皆空（组件整条不渲染）', () => {
  const [activity, usage] = sessionStatsGroups(stats());
  assert.deepEqual(activity, []);
  assert.deepEqual(usage, []);
});

check('执行规模与用量耗时各归其组（零值片段省略）', () => {
  const [activity, usage] = sessionStatsGroups(
    stats({
      turns: 3,
      steps: 12,
      llmCalls: 5,
      toolCalls: 7,
      // 刻意留空 toolMs / decodeMs：不进入任何分组
      tokens: 12_300,
      ttftMs: 3_000,
      ttftCount: 2,
      durationMs: 65_000,
    }),
  );
  assert.deepEqual(activity, ['3 回合', '12 步', '5 LLM', '7 工具']);
  assert.equal(usage.length, 3, usage.join(' | '));
  assert.match(usage[0], /^12\.3K tok$/);
  assert.match(usage[1], /^首token /, '首 token 取平均：3000ms ÷ 2');
  assert.match(usage[2], /^活跃 /);
});

check('只有 tokens → 用量组仍渲染，执行规模组为空', () => {
  const [activity, usage] = sessionStatsGroups(stats({ tokens: 999 }));
  assert.deepEqual(activity, []);
  assert.deepEqual(usage, ['999 tok']);
});

check('首 token 用平均值，不是总和', () => {
  const [, usage] = sessionStatsGroups(stats({ ttftMs: 4_000, ttftCount: 4 }));
  const en = sessionStatsGroups(stats({ ttftMs: 4_000, ttftCount: 4 }), 'en-US')[1];
  assert.match(usage[0], /首token /);
  assert.match(en[0], /^First token /);
  // 4000 / 4 = 1s：中英文读数都必须是 1s 量级，而不是 4s
  assert.ok(!usage[0].includes('4'), usage[0]);
  assert.ok(!en[0].includes('4'), en[0]);
});

check('en-US 走英文读数', () => {
  const [activity, usage] = sessionStatsGroups(
    stats({ turns: 2, steps: 3, toolCalls: 1, tokens: 1_000, durationMs: 30_000 }),
    'en-US',
  );
  assert.deepEqual(activity, ['2 turns', '3 steps', '1 tools']);
  assert.equal(usage[0], '1K tok');
  assert.match(usage[1], /^Active /);
});

console.log(`\nfrontend-stats-bar 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
