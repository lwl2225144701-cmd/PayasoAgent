// 套件: Operation Identity — 验证"什么叫同一个操作"的解析语义
// 覆盖：operationIdentity 按工具名命名空间隔离；canonical key 与参数顺序的关系。
// 注：注册期强制校验（non_idempotent 必须实现 getOperationKey）与
//     resolveOperationKey 回退/禁止回退语义已归一到 tool-contract.test.ts（契约套件），
//     本套件仅保留 operation identity 特有语义，避免重复。

import assert from 'node:assert/strict';
import { operationIdentity } from '../src/runtime/side-effect.js';
import { resolveOperationKey, type Tool } from '../src/tools/tools.js';

const tests: { name: string; fn: () => void }[] = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

// ---- 1. operationIdentity：跨工具命名空间隔离 ----
test('operationIdentity 按工具名隔离（同 key 不同工具 → 不同身份）', () => {
  const w1: Tool = {
    name: 'writeFile',
    description: 'd',
    effect: 'non_idempotent',
    parameters: {},
    getOperationKey: (args) => `w:${args.path}:${args.content}`,
    execute: async () => 'x',
  };
  const w2: Tool = {
    name: 'writeDb',
    description: 'd',
    effect: 'non_idempotent',
    parameters: {},
    getOperationKey: (args) => `w:${args.path}:${args.content}`,
    execute: async () => 'x',
  };
  const args = { path: 'a', content: 'x' };
  assert.equal(operationIdentity(w1, args), 'writeFile::w:a:x');
  assert.equal(operationIdentity(w2, args), 'writeDb::w:a:x');
  assert.notEqual(operationIdentity(w1, args), operationIdentity(w2, args));
});

// ---- 2. canonical key 稳定性：参数顺序 ----
test('回退 JSON.stringify 对参数顺序敏感（回退的固有局限）', () => {
  // 这正是 non_idempotent 禁止回退的原因：默认参数序列化猜测不可靠
  const readTool: Tool = {
    name: 'r',
    description: 'd',
    effect: 'read',
    parameters: {},
    execute: async () => 'x',
  };
  assert.notEqual(
    resolveOperationKey(readTool, { a: 1, b: 2 }),
    resolveOperationKey(readTool, { b: 2, a: 1 }),
  );
});

test('显式 getOperationKey 可归一化参数顺序（canonical key 的价值）', () => {
  const t: Tool = {
    name: 'w',
    description: 'd',
    effect: 'non_idempotent',
    parameters: {},
    // 工具自行定义"同一个操作"：与参数顺序无关，只取语义字段
    getOperationKey: (args) => {
      const keys = ['path', 'content'].filter((k) => k in args).sort();
      return `w:${keys.map((k) => `${k}=${args[k]}`).join('&')}`;
    },
    execute: async () => 'x',
  };
  assert.equal(
    resolveOperationKey(t, { content: 'x', path: 'a' }),
    resolveOperationKey(t, { path: 'a', content: 'x' }),
  );
});

// ---- 汇总 ----
async function main() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.fn();
      passed++;
      console.log(`  PASS  ${t.name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${(e as Error).message}`);
    }
  }
  console.log(`\noperation-identity 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
  else
    console.log(
      '验收：operation identity 语义成立（工具名命名空间隔离 + canonical key 参数顺序归一）✓',
    );
}

main();
