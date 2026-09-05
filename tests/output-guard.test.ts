// 套件: Tool Output Guard — 验证工具输出大小限制（UTF-8 byte 级、不切坏字符、metadata 正确）
// 用法: npx tsx tests/output-guard.test.ts
// 覆盖：小结果不截断 / 16KB 边界 / 超限截断 / UTF-8 中文与 emoji 不乱码 / metadata / 前后内容保留

import assert from 'node:assert/strict';
import { guardToolOutput, MAX_TOOL_OUTPUT_BYTES } from '../src/runtime/output-guard.js';

const tests: { name: string; fn: () => void }[] = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

// ---- 1. 小结果不截断 ----
test('小结果（<16KB）原样返回，不截断', () => {
  const s = 'hello world';
  const g = guardToolOutput(s);
  assert.equal(g.content, s);
  assert.equal(g.truncated, false);
  assert.equal(g.originalBytes, Buffer.byteLength(s, 'utf8'));
  assert.equal(g.returnedBytes, g.originalBytes);
});

// ---- 2. 16KB 边界 ----
test('恰好 16KB 不截断', () => {
  const s = 'a'.repeat(MAX_TOOL_OUTPUT_BYTES); // 全 ASCII，1 char = 1 byte
  const g = guardToolOutput(s);
  assert.equal(g.truncated, false);
  assert.equal(g.originalBytes, MAX_TOOL_OUTPUT_BYTES);
  assert.equal(g.content, s);
});

test('略超 16KB 截断，metadata 正确', () => {
  const s = 'b'.repeat(MAX_TOOL_OUTPUT_BYTES + 1);
  const g = guardToolOutput(s);
  assert.equal(g.truncated, true);
  assert.equal(g.originalBytes, MAX_TOOL_OUTPUT_BYTES + 1);
  assert.ok(g.content.includes('[OUTPUT TRUNCATED]'));
  assert.ok(g.returnedBytes < MAX_TOOL_OUTPUT_BYTES, `returnedBytes=${g.returnedBytes} 应 < 16KB`);
  // 前后内容保留
  assert.ok(g.content.startsWith('b'.repeat(10)), '开头保留');
  assert.ok(g.content.endsWith('b'.repeat(10)), '结尾保留');
});

// ---- 3. 超限截断：前后保留 + 中间替换为标记 ----
test('超限：前 ~6KB + 标记 + 后 ~4KB', () => {
  const head = 'H'.repeat(10000); // >6KB
  const tail = 'T'.repeat(8000); // >4KB → 总 18000B > 16KB
  const g = guardToolOutput(head + tail);
  assert.equal(g.truncated, true);
  assert.ok(g.content.startsWith('H'.repeat(100)), '前部保留');
  assert.ok(g.content.includes('[OUTPUT TRUNCATED]'), '含截断标记');
  assert.ok(g.content.endsWith('T'.repeat(100)), '后部保留');
  // 标记两侧：前部 H 与后部 T 之间应有标记，且 H/T 不混合（中间被替换）
  const markerIdx = g.content.indexOf('[OUTPUT TRUNCATED]');
  assert.ok(markerIdx > 0, '标记在中间');
  assert.equal(g.content.slice(0, markerIdx).includes('T'), false, '标记前不含尾部内容');
});

// ---- 4. UTF-8 中文 / emoji 不乱码 ----
const MARKER = '[OUTPUT TRUNCATED]';

test('UTF-8：中文（3 字节）截断不乱码', () => {
  const head = '汉'.repeat(5000); // 15000 bytes
  const tail = '字'.repeat(3000); // 9000 bytes → 总 24000B > 16KB
  const g = guardToolOutput(head + tail);
  assert.equal(g.truncated, true);
  assert.ok(g.content.startsWith('汉'), '前部中文完整');
  assert.ok(g.content.endsWith('字'), '后部中文完整');
  assert.ok(!g.content.includes('\uFFFD'), '不应出现乱码替换字符');
  // 标记两侧边界必须是完整字符
  const markerIdx = g.content.indexOf(MARKER);
  const before = g.content.slice(markerIdx - 3, markerIdx);
  const after = g.content.slice(markerIdx + MARKER.length, markerIdx + MARKER.length + 3);
  assert.ok(Buffer.from(before, 'utf8').toString('utf8') === before, '标记前为完整字符');
  assert.ok(Buffer.from(after, 'utf8').toString('utf8') === after, '标记后为完整字符');
});

test('UTF-8：emoji（4 字节）截断不乱码', () => {
  const head = '😀'.repeat(3000); // 12000 bytes
  const tail = '🚀'.repeat(2000); // 8000 bytes → 总 20000B > 16KB
  const g = guardToolOutput(head + tail);
  assert.equal(g.truncated, true);
  assert.ok(g.content.startsWith('😀'), '前部 emoji 完整');
  assert.ok(g.content.endsWith('🚀'), '后部 emoji 完整');
  assert.ok(!g.content.includes('\uFFFD'), '不应出现乱码替换字符');
});

// ---- 5. 空 / 纯边界 ----
test('空串不截断', () => {
  const g = guardToolOutput('');
  assert.equal(g.truncated, false);
  assert.equal(g.content, '');
  assert.equal(g.originalBytes, 0);
});

test('返回字节数按 UTF-8 计算（中文串）', () => {
  const s = '中文abc'; // 2*3 + 3 = 9 bytes
  const g = guardToolOutput(s);
  assert.equal(g.originalBytes, 9);
  assert.equal(g.returnedBytes, 9);
});

// ---- 汇总 ----
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
console.log(`\noutput-guard 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
else console.log('验收：Tool Output Guard 成立（UTF-8 byte 级限制、不切坏字符、metadata 正确）✓');
