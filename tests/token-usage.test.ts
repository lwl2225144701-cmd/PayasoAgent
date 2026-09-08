// 确定性测试：token 计量纯函数 —— 归一化（Adapter）、压力口径、图片 tile 定价。
// 覆盖 host 侧 src/llm/token-usage.ts 与 src/harness/model-context.ts 的估算器。

import assert from 'node:assert/strict';
import { estimateImageTokens, ROLE_OVERHEAD } from '../src/harness/model-context.js';
import {
  isValidTokenUsage,
  normalizeTokenUsage,
  promptSideTokens,
} from '../src/llm/token-usage.js';

// ---- normalizeTokenUsage（pi-ai 归一化后的 Usage → 内部 DISJOINT 约定）----
{
  const usage = normalizeTokenUsage({ input: 120, output: 30, totalTokens: 150 });
  assert.equal(usage?.inputTokens, 120);
  assert.equal(usage?.outputTokens, 30);
  assert.equal(usage?.totalTokens, 150);
  assert.equal(usage?.cacheReadTokens, undefined, 'cache 为 0 时不携带空桶');
}

{
  // cache 命中/写入与 reasoning 单独计桶；total 与分桶自洽。
  const usage = normalizeTokenUsage({
    input: 300,
    output: 120,
    cacheRead: 200,
    cacheWrite: 10,
    reasoning: 50,
    totalTokens: 630,
  });
  assert.equal(usage?.inputTokens, 300);
  assert.equal(usage?.cacheReadTokens, 200);
  assert.equal(usage?.cacheWriteTokens, 10);
  assert.equal(usage?.reasoningTokens, 50);
  assert.equal(promptSideTokens(usage!), 300 + 200 + 10, 'prompt 侧 = 未缓存输入 + cache 流量');
}

// 宁缺勿错：任一桶异常 → 整体拒绝。
assert.equal(normalizeTokenUsage(undefined), undefined);
assert.equal(normalizeTokenUsage(null), undefined);
assert.equal(normalizeTokenUsage('nope'), undefined);
assert.equal(normalizeTokenUsage({ input: -1, output: 10 }), undefined, '负数输入拒绝');
assert.equal(
  normalizeTokenUsage({ input: 10, output: 5, reasoning: 999 }),
  undefined,
  'reasoning > output 拒绝',
);
assert.equal(
  normalizeTokenUsage({ input: 10, output: 5, totalTokens: 4 }),
  undefined,
  'total 小于分桶之和拒绝',
);

// 无 totalTokens 时由分桶推导。
{
  const usage = normalizeTokenUsage({ input: 10, output: 5, cacheRead: 2 });
  assert.equal(usage?.totalTokens, 17, 'total = input + output + cacheRead + cacheWrite');
  assert.ok(isValidTokenUsage(usage), '归一化产物必然通过 isValidTokenUsage');
}
assert.ok(isValidTokenUsage(undefined) === false);
assert.ok(isValidTokenUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }));

// ---- estimateImageTokens（按像素 tile 定价，缺尺寸退回固定启发式）----
assert.equal(estimateImageTokens({}), 1000, '缺尺寸 → 固定保守预算');
assert.equal(estimateImageTokens({ width: 512, height: 512 }), 85 + 170, '1 tile → 255');
assert.equal(estimateImageTokens({ width: 1024, height: 1024 }), 85 + 170 * 4, '2×2 tile → 765');
assert.equal(
  estimateImageTokens({ width: 5120, height: 5120 }),
  85 + 170 * 10,
  '超大图封顶 10 tile → 1785',
);
assert.equal(typeof ROLE_OVERHEAD, 'number');
assert.ok(ROLE_OVERHEAD >= 4, '每条消息保留角色/结构开销');

console.log('\ntoken-usage tests: all PASS');
