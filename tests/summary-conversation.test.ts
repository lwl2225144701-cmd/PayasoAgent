// 套件: 摘要请求构造（P2-E）—— 真前缀复现 / 安全降级 / 图片剥离
// 用法: npx tsx tests/summary-conversation.test.ts
// 验收：快路径与原请求前缀逐字节一致（system + tools + 消息原样重放）/
//       以 tool 开头时降级为冷启动 JSON 写法 / 重放剥离图片与思考字段 /
//       instruction 带上 previousSummary（摘要才能增量续写）。
import assert from 'node:assert/strict';
import { buildSummaryConversation } from '../src/harness/conversation-summarizer.js';
import type { ChatMessage, ToolSchema } from '../src/llm/llm.js';

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

const TOOLS: ToolSchema[] = [
  {
    type: 'function',
    function: { name: 'shell', description: 'run', parameters: { type: 'object' } },
  },
];
const SYSTEM = 'KERNEL INSTRUCTIONS — 内核指令';
const HISTORY: ChatMessage[] = [
  { role: 'user', content: '旧任务' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'c1', content: '结果' },
];

const base = { previousSummary: 'Goal: x', maxSummaryTokens: 512 };

// ---- 快路径：复现真前缀 ----

check('快路径：system / tools / 历史消息与原请求逐字节一致', () => {
  const built = buildSummaryConversation({
    ...base,
    messages: HISTORY,
    prefix: { system: SYSTEM, tools: TOOLS },
  });
  assert.equal(built.cacheAligned, true);
  assert.equal(built.tools, TOOLS, 'tools 必须是同一个引用（序列化结果才一致）');
  assert.equal(built.messages[0].role, 'system');
  assert.equal(built.messages[0].content, SYSTEM, 'system 必须是内核指令原文');
  // 历史消息原样重放（同一 role/content/tool_call_id/tool_calls）
  for (let i = 0; i < HISTORY.length; i++) {
    assert.equal(built.messages[i + 1].role, HISTORY[i].role);
    assert.equal(built.messages[i + 1].content, HISTORY[i].content);
    assert.equal(built.messages[i + 1].tool_call_id, HISTORY[i].tool_call_id);
    assert.deepEqual(built.messages[i + 1].tool_calls, HISTORY[i].tool_calls);
  }
  // 末尾才是指令（新增部分，只有这一段需要 provider 重新计算）
  const last = built.messages.at(-1);
  assert.equal(last?.role, 'user');
  assert.match(String(last?.content), /Previous summary:\nGoal: x/);
  assert.match(String(last?.content), /Summarize it now/);
});

check('快路径：重放剥离图片与思考字段（带 path 的图片块会被 provider 拒收）', () => {
  const built = buildSummaryConversation({
    ...base,
    messages: [
      { role: 'user', content: '看图', images: [{ mimeType: 'image/png', path: 'input/a.png' }] },
      { role: 'assistant', content: '答', reasoning_content: '隐藏推理' },
    ],
    prefix: { system: SYSTEM, tools: TOOLS },
  });
  assert.equal(built.cacheAligned, true);
  assert.equal(built.messages[1].images, undefined, '图片必须剥离');
  assert.equal(built.messages[2].reasoning_content, undefined, '思考字段必须剥离');
  assert.equal(built.messages[1].content, '看图', '文本内容保留');
});

// ---- 降级 ----

check('降级：切片以 tool 开头 → 冷启动 JSON 写法（不带 tools）', () => {
  const built = buildSummaryConversation({
    ...base,
    messages: [{ role: 'tool', tool_call_id: 'c1', content: '孤儿结果' }],
    prefix: { system: SYSTEM, tools: TOOLS },
  });
  assert.equal(built.cacheAligned, false);
  assert.deepEqual(built.tools, [], '冷启动不带 tools');
  assert.equal(built.messages.length, 2, 'system + 单条 user');
  assert.match(String(built.messages[1].content), /New messages:/);
  assert.match(String(built.messages[1].content), /孤儿结果/, '内容仍要被摘要');
});

check('降级：没有 prefix 时同样走冷启动', () => {
  const built = buildSummaryConversation({ ...base, messages: HISTORY });
  assert.equal(built.cacheAligned, false);
  assert.equal(
    built.messages[0].content,
    'You compact agent conversation history into a precise structured summary.',
  );
});

check('降级：空切片不误判为快路径', () => {
  const built = buildSummaryConversation({
    ...base,
    messages: [],
    prefix: { system: SYSTEM, tools: TOOLS },
  });
  assert.equal(built.cacheAligned, false);
});

// ---- 增量摘要 ----

check('previousSummary 为空时给出占位，不为 undefined', () => {
  for (const request of [
    { ...base, previousSummary: '', messages: HISTORY, prefix: { system: SYSTEM, tools: TOOLS } },
    { ...base, previousSummary: '', messages: HISTORY },
  ]) {
    const built = buildSummaryConversation(request);
    assert.match(String(built.messages.at(-1)?.content), /Previous summary:\n\(none\)/);
  }
});

check('maxSummaryTokens 进入指令（预算可约束摘要长度）', () => {
  const built = buildSummaryConversation({
    ...base,
    maxSummaryTokens: 1234,
    messages: HISTORY,
    prefix: { system: SYSTEM, tools: TOOLS },
  });
  assert.match(String(built.messages.at(-1)?.content), /under 1234 tokens/);
});

console.log(`\n摘要请求构造汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：真前缀逐字节一致 / tool 开头降级 / 图片与思考剥离 / 增量 previousSummary');
