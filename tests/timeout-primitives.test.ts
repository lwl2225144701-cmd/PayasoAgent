// 套件: Shared Timeout Primitives — 分层超时的统一原语（docs/plans/long-task-timeout-plan.md 步骤 1）
// 用法: npx tsx tests/timeout-primitives.test.ts
// 覆盖: clampTimeoutMs 收敛 / deadline 组合上游取消与本地超时 / idleWatchdog 续期 / timeoutOf 来源识别

import assert from 'node:assert/strict';
import {
  clampTimeoutMs,
  createDeadline,
  createIdleWatchdog,
  positiveIntMs,
  TimeoutAbortError,
  timeoutOf,
} from '../src/util/timeout.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const POLICY = { defaultMs: 10_000, minMs: 1_000, maxMs: 60_000 };

await test('clampTimeoutMs：非法/缺失请求回退默认，合法请求收敛到 [min, max]', () => {
  assert.equal(clampTimeoutMs(undefined, POLICY), 10_000);
  assert.equal(clampTimeoutMs('abc', POLICY), 10_000);
  assert.equal(clampTimeoutMs(0, POLICY), 10_000);
  assert.equal(clampTimeoutMs(-5, POLICY), 10_000);
  assert.equal(clampTimeoutMs(500, POLICY), 1_000, '低于下限抬到 min');
  assert.equal(clampTimeoutMs(99_000, POLICY), 60_000, '超出上限收敛到 max');
  assert.equal(clampTimeoutMs(23_456.7, POLICY), 23_456);
});

await test('positiveIntMs：正整数解析，非法值返回 null（fail-closed）', () => {
  assert.equal(positiveIntMs('120000'), 120_000);
  assert.equal(positiveIntMs(250), 250);
  assert.equal(positiveIntMs(undefined), null);
  assert.equal(positiveIntMs(''), null);
  assert.equal(positiveIntMs('abc'), null);
  assert.equal(positiveIntMs('0'), null);
  assert.equal(positiveIntMs('-1'), null);
});

await test('deadline：到期以 TimeoutAbortError 中止，来源可识别', async () => {
  const deadline = createDeadline(undefined, 20, () => new TimeoutAbortError('tool', '预算到期'));
  assert.equal(deadline.signal.aborted, false);
  await sleep(40);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(timeoutOf(deadline.signal.reason), 'tool');
  assert.ok(deadline.signal.reason instanceof TimeoutAbortError);
  deadline.dispose();
});

await test('deadline：上游取消传播为标准 AbortError（区别于层超时）', async () => {
  const parent = new AbortController();
  const deadline = createDeadline(parent.signal, 60_000, () => new TimeoutAbortError('tool', 'x'));
  parent.abort();
  assert.equal(deadline.signal.aborted, true);
  assert.equal(timeoutOf(deadline.signal.reason), 'user');
  assert.equal((deadline.signal.reason as Error).name, 'AbortError');
  deadline.dispose();
});

await test('deadline：上游先于构造即已取消 → 立即中止', () => {
  const parent = new AbortController();
  parent.abort();
  const deadline = createDeadline(parent.signal, 60_000, () => new TimeoutAbortError('tool', 'x'));
  assert.equal(deadline.signal.aborted, true);
  assert.equal(timeoutOf(deadline.signal.reason), 'user');
  deadline.dispose();
});

await test('deadline：dispose 后不再触发超时（幂等），不泄漏上游监听', async () => {
  const parent = new AbortController();
  const deadline = createDeadline(parent.signal, 10, () => new TimeoutAbortError('tool', 'x'));
  deadline.dispose();
  deadline.dispose();
  await sleep(30);
  assert.equal(deadline.signal.aborted, false, 'dispose 后 deadline 失效');
  parent.abort();
  assert.equal(deadline.signal.aborted, false, 'dispose 已解绑上游监听');
});

await test('idleWatchdog：持续 poke 续期不触发，停 poke 后触发一次', async () => {
  let fired = 0;
  const watchdog = createIdleWatchdog(30, () => {
    fired++;
  });
  for (let i = 0; i < 8; i++) {
    await sleep(15);
    watchdog.poke();
  }
  assert.equal(fired, 0, '持续输出不触发空闲超时');
  await sleep(50);
  assert.equal(fired, 1);
  watchdog.poke();
  await sleep(50);
  assert.equal(fired, 1, '只触发一次，后续 poke 不再续期');
  watchdog.dispose();
});

await test('idleWatchdog：dispose 后永不触发', async () => {
  let fired = 0;
  const watchdog = createIdleWatchdog(10, () => {
    fired++;
  });
  watchdog.dispose();
  await sleep(30);
  assert.equal(fired, 0);
});

await test('timeoutOf：识别 llm-connect / llm-idle / tool / user / none', () => {
  assert.equal(timeoutOf(new TimeoutAbortError('llm-connect', 'm')), 'llm-connect');
  assert.equal(timeoutOf(new TimeoutAbortError('llm-idle', 'm')), 'llm-idle');
  assert.equal(timeoutOf(new TimeoutAbortError('tool', 'm')), 'tool');
  const abortController = new AbortController();
  abortController.abort(new DOMException('Aborted', 'AbortError'));
  assert.equal(timeoutOf(abortController.signal.reason), 'user');
  assert.equal(timeoutOf(new DOMException('Aborted', 'AbortError')), 'user');
  assert.equal(timeoutOf(new Error('ENOENT')), 'none');
  assert.equal(timeoutOf('string'), 'none');
  assert.equal(timeoutOf(undefined), 'none');
});

console.log(`\ntimeout-primitives 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
