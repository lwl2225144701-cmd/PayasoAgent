// 套件: 压缩阈值策略（P2-D）
// 用法: npx tsx tests/compaction-policy.test.ts
// 验收：成本上限独立于窗口 / 带宽硬不变式 retain<trigger 且 >= 触发线一半 /
//       小窗口回退比例项 / env 可调可关 / 回归"1M 窗口下 30 万上下文永不触发"。
import assert from 'node:assert/strict';
import {
  type CompactionPolicy,
  DEFAULT_COMPACTION_POLICY,
  resolveCompactionPolicy,
  resolveCompactionThresholds,
} from '../src/harness/compaction-policy.js';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

const P = DEFAULT_COMPACTION_POLICY;
const D = (max: number, policy: CompactionPolicy = P) => resolveCompactionThresholds(policy, max);

// ---- 核心：成本上限独立于窗口 ----

check('大窗口：独立成本上限生效（1M 窗口触发线从 77.7 万拉回 16 万）', () => {
  const max = 970_752; // step-5-preview 的实际输入预算
  const t = D(max);
  assert.equal(t.trigger, 160_000, '应由绝对成本上限决定，而不是 maxInputTokens×0.8');
  assert.ok(160_000 < Math.floor(max * 0.8), '必须显著低于纯比例值');
});

check('回归：修的就是"1M 窗口下 30 万上下文永不触发"', () => {
  const max = 970_752;
  const observedContext = 300_000; // 实测一次长会话只涨到这里
  const legacyTrigger = Math.floor(max * 0.8); // 旧行为：纯比例
  assert.ok(observedContext < legacyTrigger, '旧触发线在 30 万之上 → 永不触发（这就是 bug）');
  assert.ok(observedContext > D(max).trigger, '新触发线必须在 30 万之下 → 会触发');
});

check('小窗口：比例项接手，绝对上限不介入', () => {
  const t = D(100_000); // 128K 窗口量级
  assert.equal(t.trigger, 80_000, 'min(100000×0.8, 160000) = 80000');
  assert.equal(t.retain, 16_000, 'min(100000×0.16, 80000/2) = 16000');
});

check('中等窗口：保留量由比例项决定', () => {
  const t = D(200_000);
  assert.equal(t.trigger, 160_000);
  assert.equal(t.retain, 32_000, 'min(32000, 80000) = 32000');
});

// ---- 硬不变式：带宽 ----

check('硬不变式：任意窗口下 retain < trigger 且带宽 >= 触发线一半', () => {
  for (const max of [4_500, 10_000, 100_000, 200_000, 970_752, 2_000_000, 8_000_000]) {
    const t = D(max);
    assert.ok(
      t.retain < t.trigger,
      `max=${max} 时 retain(${t.retain}) 必须 < trigger(${t.trigger})`,
    );
    assert.ok(
      t.trigger - t.retain >= Math.floor(t.trigger / 2),
      `max=${max} 时带宽 ${t.trigger - t.retain} 必须 >= ${Math.floor(t.trigger / 2)}`,
    );
    assert.ok(t.trigger >= 1 && t.retain >= 0);
  }
});

check('带宽按实测增长定：1M 窗口下撑得起 4~13 轮才压一次', () => {
  const t = D(970_752);
  const band = t.trigger - t.retain;
  assert.equal(band, 80_000);
  assert.ok(band / 20_000 >= 4, `重轮(+20K)至少撑 4 轮，实际 ${band / 20_000}`);
  assert.ok(band / 6_000 >= 13, `普通轮(+6K)至少撑 13 轮，实际 ${Math.floor(band / 6_000)}`);
});

check('绝对保留量覆盖时仍受触发线约束', () => {
  const t = resolveCompactionThresholds(
    { triggerRatio: 0.8, triggerTokens: 10_000, retainRatio: 0.16, retainTokens: 999_999 },
    970_752,
  );
  assert.equal(t.trigger, 10_000);
  assert.equal(t.retain, 9_999, 'retain 必须被压到 trigger-1');
});

// ---- env ----

check('env：可关闭成本上限（退回纯比例，供对照与回退）', () => {
  const policy = resolveCompactionPolicy({ PAYASO_COMPACT_TRIGGER_TOKENS: '0' });
  assert.equal(policy.triggerTokens, undefined, '0 = 关闭上限');
  const t = resolveCompactionThresholds(policy, 970_752);
  assert.equal(t.trigger, Math.floor(970_752 * 0.8), '退回纯比例');
});

check('env：可调上限 / 比例 / 绝对保留量', () => {
  assert.equal(resolveCompactionPolicy({}).triggerTokens, 160_000);
  assert.equal(
    resolveCompactionPolicy({ PAYASO_COMPACT_TRIGGER_TOKENS: '90000' }).triggerTokens,
    90_000,
  );
  assert.equal(resolveCompactionPolicy({ PAYASO_COMPACT_TRIGGER_RATIO: '0.5' }).triggerRatio, 0.5);
  assert.equal(
    resolveCompactionPolicy({ PAYASO_COMPACT_RETAIN_TOKENS: '5000' }).retainTokens,
    5_000,
  );
  assert.equal(resolveCompactionPolicy({ PAYASO_COMPACT_RETAIN_RATIO: '0.2' }).retainRatio, 0.2);
});

check('env：非法值一律回退默认', () => {
  for (const raw of ['abc', '-1', '0.0', '']) {
    const p = resolveCompactionPolicy({ PAYASO_COMPACT_TRIGGER_TOKENS: raw });
    assert.equal(p.triggerTokens, 160_000, `${JSON.stringify(raw)} 应回退默认`);
  }
  assert.equal(resolveCompactionPolicy({ PAYASO_COMPACT_TRIGGER_RATIO: 'abc' }).triggerRatio, 0.8);
  assert.equal(resolveCompactionPolicy({ PAYASO_COMPACT_RETAIN_RATIO: '-3' }).retainRatio, 0.16);
});

check('默认策略常数与文档一致（0.8 / 160K / 0.16）', () => {
  assert.equal(DEFAULT_COMPACTION_POLICY.triggerRatio, 0.8);
  assert.equal(DEFAULT_COMPACTION_POLICY.triggerTokens, 160_000);
  assert.equal(DEFAULT_COMPACTION_POLICY.retainRatio, 0.16);
});

console.log(`\n压缩阈值策略汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：成本上限独立于窗口 / 带宽不变式 / 小窗口回退比例 / env 可调可关');
