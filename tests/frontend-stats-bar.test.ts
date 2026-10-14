// 套件: 前端底部统计条 — StatsBar 依赖的 sessionStatsGroups / sessionStatsDetails
// 用法: node --import tsx tests/frontend-stats-bar.test.ts
// 覆盖：零值片段省略、两分组归属（活动：回合/步/吞吐/用时拆分；用量：总量/缓存命中率）、
//   吞吐与缓存命中率的计算与缺省条件、明细（调用数/首 token/活跃）移入悬停、
//   展开面板的会话统计卡与 Token 用量卡、模型用时拆分、语言跟随、空统计 → 两组皆空。
//
// 布局口径（对齐 DSH 状态条）：条上只留"一眼要看的"——回合、步、tok/s、
// 总量、缓存命中率、上下文环；调用数与耗时移入悬停提示。

import assert from 'node:assert/strict';
import {
  modelMs,
  sessionStatRows,
  sessionStatsDetails,
  sessionStatsGroups,
  tokenBuckets,
  tokenStatRows,
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
    cacheUsageCalls: 0,
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
    stats({
      tokens: 12_300,
      inputTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      cacheUsageCalls: 1,
    }),
  );
  assert.equal(usage[0], '12.3K tok');
  assert.equal(usage[1], '缓存命中 90%');
});

check('缓存命中率含缓存写入：读 ÷ (新增 + 读 + 写)', () => {
  const [, usage] = sessionStatsGroups(
    stats({
      tokens: 1,
      inputTokens: 250,
      cacheReadTokens: 750,
      cacheWriteTokens: 1_000,
      cacheUsageCalls: 2,
    }),
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

check('有分桶数但没有任何调用上报 → 不出数（缺数据 ≠ 未命中）', () => {
  // 实测踩过：14 次调用里 6 次不返回 cacheReadTokens，当成 0 会报出一个凭空的
  // 低命中率。判定依据是 cacheUsageCalls（上报过该桶的调用数），不是分母大小。
  const [, usage] = sessionStatsGroups(
    stats({ tokens: 5_000, inputTokens: 4_000, cacheReadTokens: 1_000, cacheUsageCalls: 0 }),
  );
  assert.deepEqual(usage, ['5K tok'], '没有可信数据时只显示总量');
});

check('部分命中不显示成 100%：取整会到 100 时自动加小数位', () => {
  // 9995 / 10000 = 99.95% —— Math.round 会给出 100，必须退到小数位
  const [, usage] = sessionStatsGroups(
    stats({ tokens: 1, inputTokens: 5, cacheReadTokens: 9_995, cacheUsageCalls: 1 }),
  );
  assert.equal(usage[1], '缓存命中 99.95%', '有未命中就不许显示 100%');
});

check('真的零未命中才给 100%', () => {
  const [, usage] = sessionStatsGroups(
    stats({ tokens: 1, inputTokens: 0, cacheReadTokens: 1_000, cacheUsageCalls: 1 }),
  );
  assert.equal(usage[1], '缓存命中 100%');
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
      cacheUsageCalls: 1,
    }),
    'en-US',
  );
  assert.deepEqual(activity, ['2 turns', '3 steps', '100 tok/s']);
  assert.deepEqual(usage, ['1K tok', '90% cached']);
  assert.deepEqual(sessionStatsDetails(stats({ toolCalls: 1 }), 'en-US'), ['1 tools']);
});

// ---- 条上的用时拆分（模型 · 工具）----

check('用时拆分：模型用时 = 活跃 − 工具，宁缺勿错', () => {
  assert.equal(modelMs(stats({ durationMs: 10_000, toolMs: 2_500 })), 7_500);
  // 工具耗时超过活跃时长（数据不自洽）→ 0，不显示负数
  assert.equal(modelMs(stats({ durationMs: 1_000, toolMs: 2_000 })), 0);
  assert.equal(modelMs(stats({ durationMs: 0, toolMs: 0 })), 0);
});

check('活动组带"模型 X · 工具 Y"紧凑片段（零值省略）', () => {
  const [activity] = sessionStatsGroups(
    stats({
      turns: 1,
      steps: 4,
      decodeMs: 2_000,
      outputTokens: 100,
      durationMs: 12_000,
      toolMs: 3_000,
    }),
    'zh-CN',
  );
  assert.ok(
    activity.some((s) => s.includes('模型') && s.includes('工具')),
    activity.join(' | '),
  );
  // 没有模型用时（活跃 = 工具）→ 不出现该片段
  const [noModel] = sessionStatsGroups(stats({ turns: 1, durationMs: 3_000, toolMs: 3_000 }));
  assert.ok(!noModel.some((s) => s.includes('模型')), noModel.join(' | '));
});

// ---- 展开面板：会话统计卡 ----

check('会话统计卡：模型/工具用时、TTFT 平均、TPS、调用数、每轮 token、活跃', () => {
  const rows = sessionStatRows(
    stats({
      turns: 2,
      steps: 9,
      llmCalls: 5,
      toolCalls: 7,
      toolMs: 30_000,
      durationMs: 120_000,
      ttftMs: 3_000,
      ttftCount: 2,
      decodeMs: 4_000,
      decodeCount: 2,
      outputTokens: 200,
      tokens: 5_000,
    }),
    'zh-CN',
  );
  const labels = rows.map((r) => r.label);
  assert.ok(labels.includes('模型用时'), labels.join(' | '));
  assert.ok(labels.includes('工具调用用时'), labels.join(' | '));
  assert.ok(labels.includes('首 token 平均（TTFT）'), labels.join(' | '));
  assert.ok(labels.includes('输出速度（TPS）'), labels.join(' | '));
  assert.ok(labels.includes('平均每轮 token'), labels.join(' | '));
  // 样本数作为 hint 挂在 TTFT 与 TPS 上
  const ttft = rows.find((r) => r.label === '首 token 平均（TTFT）');
  assert.equal(ttft?.hint, '2 个样本');
  const tps = rows.find((r) => r.label === '输出速度（TPS）');
  assert.equal(tps?.hint, '2 个样本');
});

check('会话统计卡：无数据时整行不渲染（不是显示 0）', () => {
  assert.deepEqual(sessionStatRows(stats()), []);
  assert.deepEqual(sessionStatRows(stats({ turns: 1 })), []);
});

// ---- 展开面板：Token 用量卡 ----

check('Token 用量卡：四桶 + 总量 + 命中率', () => {
  const rows = tokenStatRows(
    stats({
      turns: 1,
      tokens: 1_200,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 900,
      cacheWriteTokens: 150,
      cacheUsageCalls: 1,
    }),
    'zh-CN',
  );
  const by = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(by.总用量, '1.2K');
  assert.equal(by.缓存读取, '900');
  assert.equal(by.缓存写入, '150');
  assert.equal(by.未缓存输入, '100');
  assert.equal(by.输出, '50');
  assert.ok(by.缓存命中率, rows.map((r) => `${r.label}=${r.value}`).join(' | '));
});

check('Token 用量卡：缺分桶数据 → 命中率整行不渲染', () => {
  const rows = tokenStatRows(stats({ tokens: 100, outputTokens: 100 }));
  const labels = rows.map((r) => r.label);
  assert.ok(!labels.includes('缓存命中率'), labels.join(' | '));
  // 四个桶仍显示（0 就是 0，缺分桶 ≠ 无用量）
  const by = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(by.缓存读取, '0');
  assert.equal(by.输出, '100');
});

check('tokenBuckets 与分组口径一致（命中率同源）', () => {
  const s = stats({
    tokens: 1_000,
    cacheReadTokens: 700,
    inputTokens: 100,
    cacheWriteTokens: 200,
    cacheUsageCalls: 2,
  });
  const b = tokenBuckets(s);
  assert.equal(b.total, 1_000);
  assert.equal(b.cacheRead, 700);
  assert.equal(b.hitPercent, '70');
});

check('面板文案双语齐备', () => {
  const s = stats({ turns: 1, durationMs: 1_000, toolMs: 200, tokens: 10, outputTokens: 10 });
  for (const lang of ['zh-CN', 'en-US'] as const) {
    assert.ok(sessionStatRows(s, lang).length > 0);
    assert.ok(tokenStatRows(s, lang).length > 0);
  }
});

console.log(`\nfrontend-stats-bar 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
