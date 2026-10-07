// 套件: 工具输出投影（P2-C · context-management-plan）
// 用法: npx tsx tests/tool-output-projection.test.ts
// 验收：只动 tool 消息 / 保留配对结构 / 只会变小 / 最近 N 轮与最近 K 条保留全文 /
//       未变更消息保持同一引用 / transcript 不被改动 / UTF-8 安全 / env 可关闭可调。
import assert from 'node:assert/strict';
import {
  DEFAULT_PROJECTION_POLICY,
  type ProjectionPolicy,
  projectStaleToolOutputs,
  resolveProjectionPolicy,
} from '../src/harness/tool-output-projection.js';
import type { ChatMessage } from '../src/llm/llm.js';
import { TOOL_OUTPUT_MARKER, utf8ByteLength } from '../src/tool-output-budget.js';

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

// 一轮 = user → assistant(带 tool_call) → tool(结果)
function turn(i: number, toolBytes: number, fill = 'x'): ChatMessage[] {
  return [
    { role: 'user', content: `任务 ${i}` },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: `call-${i}`, type: 'function', function: { name: 'shell', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: `call-${i}`, content: fill.repeat(toolBytes) },
  ];
}

function transcript(turns: number, toolBytes = 2_000): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: '内核指令' }];
  for (let i = 1; i <= turns; i++) messages.push(...turn(i, toolBytes));
  return messages;
}

function toolMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role === 'tool');
}

const OFF: ProjectionPolicy = { ...DEFAULT_PROJECTION_POLICY, enabled: false };

// ---- 开关 ----

check('关闭时：原样返回（同一数组引用，零分配）', () => {
  const input = transcript(50);
  const r = projectStaleToolOutputs(input, OFF);
  assert.equal(r.messages, input, '应返回同一引用');
  assert.equal(r.projectedCount, 0);
  assert.equal(r.savedBytes, 0);
});

check('轮数不超过保留阈值：不投影', () => {
  const input = transcript(2); // 正好 2 轮 = keepRecentTurns(2)，没有"更老的轮"
  const r = projectStaleToolOutputs(input);
  assert.equal(r.projectedCount, 0, '不该投影');
  assert.equal(r.messages, input);
});

// ---- 核心行为 ----

check('超过阈值：老的被投影，最近的保持全文', () => {
  const input = transcript(40); // 40 条 tool
  const r = projectStaleToolOutputs(input);
  assert.ok(r.projectedCount > 0, '应有投影发生');
  assert.ok(r.savedBytes > 0, '应省下字节');

  const tools = toolMessages(r.messages);
  const last = tools.at(-1);
  assert.equal(last?.content.length, 2_000, '最近一条必须保持全文');
  const first = tools[0];
  assert.ok(first.content.includes(TOOL_OUTPUT_MARKER), '最旧一条应带标记');
  const bound =
    DEFAULT_PROJECTION_POLICY.headBytes +
    utf8ByteLength(TOOL_OUTPUT_MARKER) +
    DEFAULT_PROJECTION_POLICY.tailBytes;
  assert.ok(
    utf8ByteLength(first.content) <= bound,
    `投影后应 <= ${bound} 字节，实际 ${utf8ByteLength(first.content)}`,
  );
});

check('保留「最近 K 条工具结果」全文（K=20）', () => {
  const input = transcript(40);
  const r = projectStaleToolOutputs(input);
  const tools = toolMessages(r.messages);
  for (let i = tools.length - 20; i < tools.length; i++) {
    assert.equal(tools[i].content.length, 2_000, `倒数第 ${tools.length - i} 条应保持全文`);
  }
  assert.ok(tools[tools.length - 21].content.includes(TOOL_OUTPUT_MARKER), '再往前一条应被投影');
});

check('只动 tool 消息：system / user / assistant 一字不改', () => {
  const input = transcript(40);
  const r = projectStaleToolOutputs(input);
  for (let i = 0; i < input.length; i++) {
    const role = input[i].role;
    if (role === 'tool') continue;
    assert.equal(r.messages[i], input[i], `${role} 消息应保持同一引用（未改动）`);
  }
});

check('配对结构完整：role 与 tool_call_id 原样保留', () => {
  const input = transcript(40);
  const r = projectStaleToolOutputs(input);
  const tools = toolMessages(r.messages);
  assert.equal(tools.length, 40, '工具消息条数不变（不是删除）');
  for (const t of tools) {
    assert.equal(t.role, 'tool');
    assert.ok(t.tool_call_id?.startsWith('call-'), 'tool_call_id 必须保留');
  }
  // 每个 assistant 的 tool_call 都能找到对应结果
  const ids = new Set(tools.map((t) => t.tool_call_id));
  for (const m of r.messages) {
    for (const call of m.tool_calls ?? []) assert.ok(ids.has(call.id), `配对丢失: ${call.id}`);
  }
});

check('只会变小：原文不比投影长度长时原样保留', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }];
  for (let i = 1; i <= 30; i++) messages.push(...turn(i, i <= 5 ? 100 : 2_000));
  const r = projectStaleToolOutputs(messages);
  for (let i = 0; i < messages.length; i++) {
    const before = utf8ByteLength(messages[i].content);
    const after = utf8ByteLength(r.messages[i].content);
    assert.ok(after <= before, `第 ${i} 条变大了：${before} → ${after}`);
  }
});

check('未变更的消息保持同一对象引用（前缀缓存与内存受益）', () => {
  const input = transcript(40);
  const r = projectStaleToolOutputs(input);
  let sameRefs = 0;
  for (let i = 0; i < input.length; i++) if (r.messages[i] === input[i]) sameRefs++;
  // system + 40 user + 40 assistant = 81 条不动；工具 40 条里约 20 条不动
  assert.ok(sameRefs >= 80, `应大量复用引用，实际 ${sameRefs}/${input.length}`);
});

check('不改动 canonical transcript（入参字节不变）', () => {
  const input = transcript(40);
  const snapshot = JSON.stringify(input);
  projectStaleToolOutputs(input);
  assert.equal(JSON.stringify(input), snapshot, 'transcript 不得被改动');
});

// ---- 成批推进（前缀缓存） ----
//
// 背景：边界每前移一条就把该处之后的整个前缀改写一遍，provider 缓存从那里起失效。
// 逐条前移 = 每轮打断一次缓存（实测过一次：命中率 89% → 20%）。以下锁住"成批"行为。

check('不足一批：边界完全静止（同一数组引用，前缀一个字节都不改）', () => {
  // K=20、batch=10：工具结果 20~29 条时还凑不满一批，应当一条都不动。
  for (const n of [20, 21, 22, 25, 29]) {
    const input = transcript(n);
    const r = projectStaleToolOutputs(input);
    assert.equal(r.projectedCount, 0, `${n} 条时不该投影（否则每轮都打断一次缓存）`);
    assert.equal(r.messages, input, `${n} 条时应返回同一引用`);
    assert.equal(r.savedBytes, 0);
  }
});

check('满一批才前移，且一次前移一整批', () => {
  assert.equal(projectStaleToolOutputs(transcript(30)).projectedCount, 10, '第 30 条时投影 10 条');
  assert.equal(projectStaleToolOutputs(transcript(39)).projectedCount, 10, '第 39 条时仍是 10 条');
  assert.equal(
    projectStaleToolOutputs(transcript(40)).projectedCount,
    20,
    '第 40 条时前进到 20 条',
  );
});

check('工具规则生效区间内单调不回退（n>=20）', () => {
  let prev = -1;
  for (let n = 20; n <= 60; n++) {
    const c = projectStaleToolOutputs(transcript(n)).projectedCount;
    assert.ok(c >= prev, `从 ${n - 1} 到 ${n} 条时投影数回退了：${prev} → ${c}`);
    prev = c;
  }
});

check('batch<=1：退回逐条推进（保留旧行为，env 可回退）', () => {
  const perOne: ProjectionPolicy = { ...DEFAULT_PROJECTION_POLICY, batchToolResults: 1 };
  // 22 条工具结果、K=20：逐条模式下"倒数第 21 条"立刻被投影
  assert.equal(projectStaleToolOutputs(transcript(22), perOne).projectedCount, 2);
  // 成批模式下同样输入一条都不动
  assert.equal(projectStaleToolOutputs(transcript(22)).projectedCount, 0);
  assert.equal(
    projectStaleToolOutputs(transcript(22), { ...perOne, batchToolResults: 0 }).projectedCount,
    2,
    'batch=0 视同关闭成批',
  );
});

check('env：PAYASO_PROJECT_BATCH 可调，非法值回退默认', () => {
  assert.equal(resolveProjectionPolicy({ PAYASO_PROJECT_BATCH: '4' }).batchToolResults, 4);
  assert.equal(
    resolveProjectionPolicy({}).batchToolResults,
    DEFAULT_PROJECTION_POLICY.batchToolResults,
  );
  assert.equal(
    resolveProjectionPolicy({ PAYASO_PROJECT_BATCH: 'abc' }).batchToolResults,
    DEFAULT_PROJECTION_POLICY.batchToolResults,
  );
});

// ---- 边界 ----

check('连续 user 提醒不会把边界推得过于靠后（最近 K 条兜底）', () => {
  // 40 轮工具结果之后，再追加 5 条连续 user 提醒（模拟空回合/进度提醒）
  const messages = transcript(40);
  for (let i = 0; i < 5; i++) messages.push({ role: 'user', content: `提醒 ${i}` });
  const r = projectStaleToolOutputs(messages);
  const tools = toolMessages(r.messages);
  const kept = tools.filter((t) => !t.content.includes(TOOL_OUTPUT_MARKER));
  assert.ok(kept.length >= 20, `无论如何应保留最近 20 条全文，实际保留 ${kept.length}`);
});

check('与 P1 协同：被 spill 的结果投影后仍保留完整可读回路径', () => {
  const spillPath = 'input/spill/shell-0123456789abcdef.txt';
  const notice = `[中间被省略的内容已完整落盘，可用 read 读回：${spillPath}]`;
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }];
  for (let i = 1; i <= 30; i++) {
    messages.push(...turn(i, 2_000));
    // 让每条工具结果都带上 spill 提示（模拟超 16KB 被落盘过的结果）
    const last = messages[messages.length - 1];
    last.content = `${last.content}\n${notice}`;
  }
  const r = projectStaleToolOutputs(messages);
  const first = toolMessages(r.messages)[0];
  assert.ok(first.content.includes(TOOL_OUTPUT_MARKER), '应被投影');
  assert.ok(
    first.content.includes(spillPath),
    `投影后必须保留完整 spill 路径（否则模型会去读半截路径）：${first.content.slice(-120)}`,
  );
});

check('UTF-8 安全：中文 / emoji 投影后不乱码', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }];
  for (let i = 1; i <= 30; i++) messages.push(...turn(i, 1_500, '中🎉'));
  const r = projectStaleToolOutputs(messages);
  const first = toolMessages(r.messages)[0];
  assert.ok(first.content.includes(TOOL_OUTPUT_MARKER));
  assert.ok(!first.content.includes('\ufffd'), '不得出现替换字符');
});

check('空 transcript / 无工具消息：安全返回', () => {
  assert.equal(projectStaleToolOutputs([], DEFAULT_PROJECTION_POLICY).projectedCount, 0);
  const noTools: ChatMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: 'a' },
  ];
  assert.equal(projectStaleToolOutputs(noTools).messages, noTools);
});

// ---- env ----

check('env：可关闭、可调保留条数', () => {
  assert.equal(resolveProjectionPolicy({ PAYASO_PROJECT_OLD_TOOL_OUTPUTS: '0' }).enabled, false);
  assert.equal(resolveProjectionPolicy({}).enabled, true);
  assert.equal(resolveProjectionPolicy({ PAYASO_PROJECT_OLD_TOOL_OUTPUTS: '1' }).enabled, true);
  const tuned = resolveProjectionPolicy({
    PAYASO_PROJECT_KEEP_TOOL_RESULTS: '5',
    PAYASO_PROJECT_KEEP_TURNS: '1',
  });
  assert.equal(tuned.keepRecentToolResults, 5);
  assert.equal(tuned.keepRecentTurns, 1);
  // 非法值回退默认
  assert.equal(
    resolveProjectionPolicy({ PAYASO_PROJECT_KEEP_TOOL_RESULTS: 'abc' }).keepRecentToolResults,
    DEFAULT_PROJECTION_POLICY.keepRecentToolResults,
  );
});

console.log(`\n工具输出投影汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log(
  '验收：只动 tool / 配对完整 / 只变小 / 保留最近 / 引用复用 / transcript 不动 / UTF-8 安全',
);
