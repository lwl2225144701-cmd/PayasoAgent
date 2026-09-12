// 套件: Tool Output Budget — 共享输出预算与 read 行感知切片
// 用法: npx tsx tests/tool-output-budget.test.ts
// 覆盖：
//   1. sliceTextToBudget：预算内恒等 / 超预算首尾保留 / UTF-8 边界安全 / 自定义预算硬上限
//   2. sliceNumberedWindow：预算内恒等 / 超预算保留整行首尾 + 精确续读区间
//   3. 分页完备性：按提示的 offset/limit 逐页读取，内容无丢失、每页均在预算内
//   4. 契约一致性：Runtime guard 与 read 使用同一份预算（read 结果永不触发 guard）

import assert from 'node:assert/strict';
import { guardToolOutput } from '../src/runtime/output-guard.js';
import {
  sliceTextToBudget,
  TOOL_OUTPUT_HEAD_BYTES,
  TOOL_OUTPUT_MARKER,
  TOOL_OUTPUT_MAX_BYTES,
  utf8ByteLength,
  utf8Head,
  utf8Tail,
} from '../src/tool-output-budget.js';
import { sliceNumberedWindow } from '../src/tools/filesystem.js';

const tests: { name: string; fn: () => void }[] = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

// ---- 1. sliceTextToBudget ----

test('预算内：恒等返回，不标记截断', () => {
  const text = 'hello 世界';
  const s = sliceTextToBudget(text);
  assert.equal(s.truncated, false);
  assert.equal(s.content, text);
  assert.equal(s.omittedBytes, 0);
  assert.equal(s.originalBytes, utf8ByteLength(text));
  assert.equal(s.returnedBytes, s.originalBytes);
});

test('超预算：保留首尾、含标记、字节数受控', () => {
  const text = 'a'.repeat(TOOL_OUTPUT_MAX_BYTES * 2);
  const s = sliceTextToBudget(text);
  assert.equal(s.truncated, true);
  assert.ok(s.content.includes(TOOL_OUTPUT_MARKER), '必须含截断标记');
  assert.ok(s.content.startsWith('a'.repeat(16)), '头部保留');
  assert.ok(s.content.endsWith('a'.repeat(16)), '尾部保留');
  assert.ok(s.returnedBytes <= TOOL_OUTPUT_MAX_BYTES, `returnedBytes=${s.returnedBytes}`);
  assert.ok(s.omittedBytes > 0, '应报告省略字节数');
});

test('UTF-8 边界：中文/emoji 截断不乱码', () => {
  const text = '中'.repeat(20_000) + '🎯'.repeat(5_000);
  const s = sliceTextToBudget(text);
  assert.ok(s.content.includes(TOOL_OUTPUT_MARKER));
  assert.ok(!s.content.includes('\uFFFD'), '不得出现替换字符');
  assert.ok(s.returnedBytes <= TOOL_OUTPUT_MAX_BYTES);
});

test('自定义预算：返回值硬上限恒成立', () => {
  const text = 'x'.repeat(10_000);
  const s = sliceTextToBudget(text, { maxBytes: 1_000, headBytes: 4_000, tailBytes: 4_000 });
  assert.ok(s.returnedBytes <= 1_000, `returnedBytes=${s.returnedBytes} 应 <= 1000`);
});

test('utf8Head / utf8Tail 不切坏多字节字符', () => {
  const text = 'a'.repeat(10) + '中'.repeat(10) + 'b'.repeat(10);
  const head = utf8Head(text, 13); // 落在「中」的中间
  assert.ok(!head.includes('\uFFFD'), 'head 不得切坏字符');
  assert.ok(utf8ByteLength(head) <= 13);
  const tail = utf8Tail(text, 13);
  assert.ok(!tail.includes('\uFFFD'), 'tail 不得切坏字符');
  assert.ok(utf8ByteLength(tail) <= 13);
});

// ---- 2. sliceNumberedWindow ----

function numbered(count: number, lineText = (i: number) => `line-${i}-${'x'.repeat(40)}`) {
  return Array.from(
    { length: count },
    (_, i) => `${String(i + 1).padStart(4, ' ')}→${lineText(i)}`,
  );
}

test('窗口在预算内：恒等，不标记截断', () => {
  const lines = numbered(10);
  const s = sliceNumberedWindow(lines, 1);
  assert.equal(s.truncated, false);
  assert.equal(s.text, lines.join('\n'));
  assert.equal(s.omittedLines, 0);
});

test('窗口超预算：保留整行首尾 + 精确续读区间', () => {
  const lines = numbered(2_000);
  const s = sliceNumberedWindow(lines, 1);
  assert.equal(s.truncated, true);
  assert.ok(s.text.includes('[READ TRUNCATED]'), '含续读标记');
  assert.ok(s.omittedLines > 0, '应省略中间行');
  assert.equal(s.omittedFromLine, 1 + (s.resumeOffset - 1));
  assert.equal(s.omittedToLine - s.omittedFromLine + 1, s.omittedLines);
  assert.ok(s.text.includes(`offset=${s.resumeOffset}`), '提示必须含精确 offset');
  assert.ok(s.text.includes(`limit=${s.resumeLimit}`), '提示必须含精确 limit');
  // 首行与末行都在文本里（首尾保留）
  assert.ok(s.text.startsWith(lines[0]), '头部从第一行开始');
  assert.ok(s.text.includes(lines[lines.length - 1]), '尾部包含最后一行');
});

// ---- 3. 分页完备性：逐页读取不丢内容 ----

test('分页完备性：按 offset/limit 逐页读取，行集合与原文一致且每页在预算内', () => {
  const lines = numbered(1_500, (i) => `row ${i} ${'数据'.repeat(20)}`);
  const seen: string[] = [];
  let offset = 1;
  let pages = 0;
  while (offset <= lines.length && pages < 200) {
    pages++;
    const startIdx = offset - 1;
    const window = lines.slice(startIdx);
    const slice = sliceNumberedWindow(window, offset);
    assert.ok(
      utf8ByteLength(slice.text) <= TOOL_OUTPUT_MAX_BYTES,
      `第 ${pages} 页 ${utf8ByteLength(slice.text)} 字节超预算`,
    );
    if (!slice.truncated) {
      seen.push(...window);
      break;
    }
    const headLines = window.slice(0, slice.resumeOffset - offset);
    seen.push(...headLines);
    if (slice.omittedLines === 0) break;
    // 省略区间由下一页取回
    offset = slice.resumeOffset;
    // 尾部已显示，但为了避免重复，下一页从省略区间开始（read 语义）
    // 这里只推进到省略区间末尾之前，模拟模型逐段精读。
    const nextWindow = lines.slice(offset - 1);
    const nextSlice = sliceNumberedWindow(nextWindow, offset);
    const headCount = nextSlice.truncated ? nextSlice.resumeOffset - offset : nextWindow.length;
    seen.push(...nextWindow.slice(0, headCount));
    offset = offset + headCount;
  }
  assert.ok(pages > 1, '大文件应产生多页');
  // 已读行去重后应覆盖全部行（顺序遍历，允许尾部重叠）
  const unique = new Set(seen);
  for (const line of lines) {
    assert.ok(unique.has(line), `缺失行: ${line.slice(0, 30)}`);
  }
});

// ---- 4. 契约一致性 ----

test('契约一致性：read 切片的产出永不触发 Runtime guard 二次截断', () => {
  const lines = numbered(3_000);
  const slice = sliceNumberedWindow(lines, 1);
  const guarded = guardToolOutput(slice.text);
  assert.equal(guarded.truncated, false, 'read 结果不应再被 guard 截断');
  assert.equal(guarded.content, slice.text);
});

test('契约一致性：guard 与预算模块使用同一常量', () => {
  assert.equal(TOOL_OUTPUT_HEAD_BYTES, 6 * 1024);
  const text = 'z'.repeat(TOOL_OUTPUT_MAX_BYTES + 1);
  const g = guardToolOutput(text);
  assert.equal(g.truncated, true);
  assert.ok(g.returnedBytes <= TOOL_OUTPUT_MAX_BYTES);
});

// ---- runner ----
let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`  [PASS] ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${t.name} — ${(err as Error).message}`);
  }
}
console.log(`\ntool-output-budget 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
