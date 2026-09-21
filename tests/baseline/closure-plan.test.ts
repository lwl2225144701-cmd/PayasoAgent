// 收尾续跑计划单测：确定性，无 LLM。
// 规则：同指纹才能续；已等待内容复核的不重跑；其余一律重跑。
import assert from 'node:assert/strict';
import { type BatchFile, planBatches } from './closure-plan.js';

const HASH = 'a'.repeat(64);
const CONFIG = 'c'.repeat(64);
const ALL = ['original-1', 'original-2', 'original-3', 'variants'];

interface Case {
  name: string;
  fn: () => void;
}
const tests: Case[] = [];
let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

test('没有 batch.json 记录 → 全新开始', () => {
  assert.deepEqual(planBatches(undefined, HASH, CONFIG, ALL), { kind: 'fresh' });
  assert.deepEqual(planBatches({}, HASH, CONFIG, ALL), { kind: 'fresh' });
});

test('指纹不一致 → 拒绝续跑（不能换版本混用）', () => {
  const file: BatchFile = {
    sourceHash: 'b'.repeat(64),
    configFingerprint: CONFIG,
    batches: [{ name: 'original-1', status: 'provider_blocked' }],
  };
  assert.throws(() => planBatches(file, HASH, CONFIG, ALL), /源码指纹/);
});

test('模型配置指纹不一致或旧记录缺失指纹 → 拒绝续跑', () => {
  const changed: BatchFile = {
    sourceHash: HASH,
    configFingerprint: 'd'.repeat(64),
    batches: [{ name: 'original-1', status: 'provider_blocked' }],
  };
  assert.throws(() => planBatches(changed, HASH, CONFIG, ALL), /模型端点或凭证/);
  assert.throws(
    () =>
      planBatches(
        { sourceHash: HASH, batches: [{ name: 'original-1', status: 'provider_blocked' }] },
        HASH,
        CONFIG,
        ALL,
      ),
    /模型端点或凭证/,
  );
});

test('awaiting_content_review 保留跳过，provider_blocked/runner_failed/残留 running 重跑', () => {
  const file: BatchFile = {
    sourceHash: HASH,
    configFingerprint: CONFIG,
    batches: [
      { name: 'original-1', status: 'awaiting_content_review', output: '/x/1' },
      { name: 'original-2', status: 'provider_blocked' },
      { name: 'original-3', status: 'running' },
      { name: 'variants', status: 'runner_failed' },
    ],
  };
  const plan = planBatches(file, HASH, CONFIG, ALL);
  assert.equal(plan.kind, 'resume');
  if (plan.kind !== 'resume') return;
  assert.deepEqual(
    plan.keep.map((r) => r.name),
    ['original-1'],
  );
  assert.deepEqual(plan.keep[0].output, '/x/1');
  assert.deepEqual(plan.rerun, ['original-2', 'original-3', 'variants']);
});

test('同批次多次重跑按最后一条记录去重', () => {
  const file: BatchFile = {
    sourceHash: HASH,
    configFingerprint: CONFIG,
    batches: [
      { name: 'original-1', status: 'provider_blocked' },
      { name: 'original-1', status: 'awaiting_content_review', output: '/x/2' },
    ],
  };
  const plan = planBatches(file, HASH, CONFIG, ALL);
  if (plan.kind !== 'resume') throw new Error('expected resume');
  assert.deepEqual(
    plan.keep.map((r) => r.name),
    ['original-1'],
  );
  assert.equal(plan.keep[0].output, '/x/2');
  assert.equal(plan.rerun.length, 3);
});

test('样例集外的批次名被忽略，不在 keep 中夹带', () => {
  const file: BatchFile = {
    sourceHash: HASH,
    configFingerprint: CONFIG,
    batches: [
      { name: 'unknown-batch', status: 'awaiting_content_review' },
      { name: 'variants', status: 'awaiting_content_review' },
    ],
  };
  const plan = planBatches(file, HASH, CONFIG, ALL);
  if (plan.kind !== 'resume') throw new Error('expected resume');
  assert.deepEqual(
    plan.keep.map((r) => r.name),
    ['variants'],
  );
  assert.deepEqual(plan.rerun, ['original-1', 'original-2', 'original-3']);
});

test('四批全部等待复核 → 无事可做', () => {
  const file: BatchFile = {
    sourceHash: HASH,
    configFingerprint: CONFIG,
    batches: ALL.map((name) => ({ name, status: 'awaiting_content_review' })),
  };
  const plan = planBatches(file, HASH, CONFIG, ALL);
  if (plan.kind !== 'resume') throw new Error('expected resume');
  assert.equal(plan.keep.length, 4);
  assert.equal(plan.rerun.length, 0);
});

async function main(): Promise<void> {
  for (const t of tests) {
    try {
      t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failed++;
      const msg = (err as Error).message;
      failures.push(`${t.name} — ${msg}`);
      console.log(`  [FAIL] ${t.name} — ${msg}`);
    }
  }
  console.log(`\n汇总: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('验收：续跑计划仅同指纹续跑、已完成批次不重跑 ✓');
}

main();
