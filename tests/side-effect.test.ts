// 套件: Side-Effect Safety — 验证 non_idempotent 操作的去重/防重放行为 + v1.3.2 生命周期（executing/succeeded/uncertain）
// 覆盖：guard 记录/回放/快照恢复（resume 种子）；getReplay/markExecuted 只作用于 non_idempotent；
//       循环级"同 key 只执行一次，重复请求回放首次结果"；不同 key 正常执行；executing/uncertain 不重放。

import assert from 'node:assert/strict';
import '../src/tools/builtin-tools.js';
import {
  createSideEffectGuard,
  getReplay,
  markExecuted,
  operationIdentity,
  resolveOperation,
  type SideEffectGuard,
} from '../src/runtime/side-effect.js';
import { execute, getTool, register, type ToolContext } from '../src/tools/tools.js';

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

const ctx: ToolContext = { runId: 'side-effect-test', workspaceRoot: process.cwd() };

// 非幂等测试工具：每次 execute 真实执行副作用（计数器 +1），并返回执行次数
let appendCount = 0;
register({
  name: 'appendEntry',
  description: '测试用：非幂等写操作（追加计数），同 bucket+content 视为同一操作',
  effect: 'non_idempotent',
  parameters: { type: 'object', properties: {} },
  getOperationKey: (args) => `entry:${args.bucket}:${args.content}`,
  execute: async (args) => {
    appendCount++;
    return `已写入 ${args.bucket}/${args.content}（第 ${appendCount} 次）`;
  },
});

const appendTool = () => getTool('appendEntry')!;

// ---- 1. guard 基础行为 ----
test('guard：record 后 isExecuted/replay 命中，未执行返回 undefined', () => {
  const g: SideEffectGuard = createSideEffectGuard();
  const key = operationIdentity(appendTool(), { bucket: 'a', content: 'x' });
  assert.equal(g.isExecuted(key), false);
  assert.equal(g.replay(key), undefined);

  g.succeed(key, 'R1');
  assert.equal(g.isExecuted(key), true);
  assert.equal(g.replay(key), 'R1');
});

test('guard：不同 canonical key 相互独立', () => {
  const g = createSideEffectGuard();
  g.succeed(operationIdentity(appendTool(), { bucket: 'a', content: 'x' }), 'R1');
  assert.equal(g.isExecuted(operationIdentity(appendTool(), { bucket: 'b', content: 'y' })), false);
  assert.equal(g.replay(operationIdentity(appendTool(), { bucket: 'b', content: 'y' })), undefined);
});

// ---- 2. resume 恢复：snapshot → 新 guard 种子 ----
test('guard：snapshot/seed 往返（模拟 resume 防重放）', () => {
  const keyA = operationIdentity(appendTool(), { bucket: 'a', content: 'x' });
  const keyB = operationIdentity(appendTool(), { bucket: 'b', content: 'y' });

  const g1 = createSideEffectGuard();
  g1.succeed(keyA, 'R1');
  const snapshot = g1.snapshot();
  assert.equal(snapshot.length, 1);
  assert.deepEqual(snapshot, [{ key: keyA, state: 'succeeded', result: 'R1' }]);

  // 恢复：用 checkpoint 持久化的快照重建 guard
  const g2 = createSideEffectGuard(snapshot);
  assert.equal(g2.isExecuted(keyA), true);
  assert.equal(g2.replay(keyA), 'R1');
  assert.equal(g2.isExecuted(keyB), false);
});

// ---- 3. getReplay / markExecuted 只作用于 non_idempotent ----
test('getReplay：read/idempotent 即使 key 命中也绝不回放（不做去重）', () => {
  const g = createSideEffectGuard();
  const readT = getTool('getWeather')!;
  g.succeed(operationIdentity(readT, { city: '北京' }), 'cached');
  assert.equal(getReplay(g, readT, { city: '北京' }), undefined);
});

test('markExecuted：read/idempotent 不记录（无副作用可安全重跑）', () => {
  const g = createSideEffectGuard();
  const readT = getTool('getWeather')!;
  markExecuted(g, readT, { city: '北京' }, '25°C');
  assert.equal(g.isExecuted(operationIdentity(readT, { city: '北京' })), false);
});

test('getReplay：non_idempotent 已执行 → 回放缓存结果', () => {
  const g = createSideEffectGuard();
  const t = appendTool();
  g.succeed(operationIdentity(t, { bucket: 'a', content: 'x' }), 'R1');
  assert.equal(getReplay(g, t, { bucket: 'a', content: 'x' }), 'R1');
});

// ---- 3.5 v1.3.2 生命周期：executing / uncertain 不重放 ----
test('生命周期：begin → executing；succeed → succeeded；markUncertain → uncertain', () => {
  const g = createSideEffectGuard();
  const t = appendTool();
  const key = operationIdentity(t, { bucket: 'a', content: 'x' });

  assert.equal(g.getState(key), undefined);
  assert.equal(resolveOperation(g, t, { bucket: 'a', content: 'x' }).kind, 'start');

  g.begin(key); // 开始执行 → executing
  assert.equal(g.getState(key), 'executing');
  assert.equal(g.replay(key), undefined); // executing 不伪造成功
  assert.equal(resolveOperation(g, t, { bucket: 'a', content: 'x' }).kind, 'uncertain');

  g.succeed(key, 'R1'); // 成功 → succeeded
  assert.equal(g.getState(key), 'succeeded');
  assert.equal(g.replay(key), 'R1');
  assert.deepEqual(resolveOperation(g, t, { bucket: 'a', content: 'x' }), {
    kind: 'replay',
    result: 'R1',
  });
});

test('生命周期：markUncertain 后同 key 不重放（不伪造成功）', () => {
  const g = createSideEffectGuard();
  const t = appendTool();
  const key = operationIdentity(t, { bucket: 'a', content: 'x' });

  g.begin(key);
  g.markUncertain(key); // execute throw → uncertain
  assert.equal(g.getState(key), 'uncertain');
  assert.equal(g.replay(key), undefined);
  assert.equal(resolveOperation(g, t, { bucket: 'a', content: 'x' }).kind, 'uncertain');
});

test('生命周期：snapshot 携带 state，seed 恢复后状态保持（resume 遇 uncertain 不重放）', () => {
  const t = appendTool();
  const keyA = operationIdentity(t, { bucket: 'a', content: 'x' });
  const keyB = operationIdentity(t, { bucket: 'b', content: 'y' });

  const g1 = createSideEffectGuard();
  g1.begin(keyA);
  g1.markUncertain(keyA);
  g1.succeed(keyB, 'RB');
  const snap = g1.snapshot();

  const g2 = createSideEffectGuard(snap);
  assert.equal(g2.getState(keyA), 'uncertain');
  assert.equal(resolveOperation(g2, t, { bucket: 'a', content: 'x' }).kind, 'uncertain');
  assert.equal(g2.getState(keyB), 'succeeded');
  assert.deepEqual(resolveOperation(g2, t, { bucket: 'b', content: 'y' }), {
    kind: 'replay',
    result: 'RB',
  });
});

test('resolveOperation：read/idempotent 一律 start（不参与生命周期）', () => {
  const g = createSideEffectGuard();
  const readT = getTool('getWeather')!;
  assert.equal(resolveOperation(g, readT, { city: '北京' }).kind, 'start');
  g.begin(operationIdentity(readT, { city: '北京' }));
  // read 工具即使被误记录，resolveOperation 仍视为 start（不会因生命周期被阻断）
  assert.equal(resolveOperation(g, readT, { city: '北京' }).kind, 'start');
});

// ---- 4. 循环级：同 key 只执行一次，重复请求回放（副作用不重复发生）----
test('循环级：同 canonical key 只执行一次副作用，重复请求回放首次结果', async () => {
  appendCount = 0;
  const t = appendTool();
  const g = createSideEffectGuard();

  // 第一次调用：无回放 → 真实执行 + 记录
  const firstReplay = getReplay(g, t, { bucket: 'a', content: 'x' });
  assert.equal(firstReplay, undefined);
  const r1 = await execute('appendEntry', { bucket: 'a', content: 'x' }, ctx);
  markExecuted(g, t, { bucket: 'a', content: 'x' }, r1);
  assert.equal(appendCount, 1);

  // 重复请求（同一 canonical key）：回放首次结果，副作用不重复发生
  const r2 = getReplay(g, t, { bucket: 'a', content: 'x' });
  assert.equal(r2, r1);
  assert.equal(appendCount, 1); // 未再次执行 → 防双写成立

  // 不同参数（不同 canonical key）：正常执行
  const r3 = getReplay(g, t, { bucket: 'b', content: 'y' });
  assert.equal(r3, undefined);
  const r4 = await execute('appendEntry', { bucket: 'b', content: 'y' }, ctx);
  markExecuted(g, t, { bucket: 'b', content: 'y' }, r4);
  assert.equal(appendCount, 2);

  // 再次重复 b 请求 → 回放，计数不变
  const r5 = getReplay(g, t, { bucket: 'b', content: 'y' });
  assert.equal(r5, r4);
  assert.equal(appendCount, 2);
});

// ---- 5. execute + guard 端到端联动（回放值 = 首次真实执行结果）----
test('联动：回放值 = 首次 execute 的真实结果', async () => {
  appendCount = 0;
  const t = appendTool();
  const g = createSideEffectGuard();

  const first = await execute('appendEntry', { bucket: 'a', content: 'x' }, ctx);
  markExecuted(g, t, { bucket: 'a', content: 'x' }, first);

  assert.equal(getReplay(g, t, { bucket: 'a', content: 'x' }), first);
  assert.ok(first.includes('第 1 次'), `首次结果应含第 1 次，实际: ${first}`);
});

// ---- 汇总 ----
async function main() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  PASS  ${t.name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${(e as Error).message}`);
    }
  }
  console.log(`\nside-effect 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
  else
    console.log(
      '验收：Side-Effect Safety 成立（non_idempotent 同 key 只执行一次副作用，重复请求回放；read/idempotent 不去重）✓',
    );
}

main();
