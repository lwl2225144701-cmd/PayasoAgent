// 套件: Tool Call Raw Arguments — 原生适配器畸形参数不再被静默当成 {}
// 用法: npx tsx tests/tool-call-arguments.test.ts
// 回归目标（v1.10）：pi-ai 原生适配器把未闭合的 JSON 解成 {}，Runtime 于是拿着
// "合法空对象"去执行工具（报"缺少参数 path"），而不是回传可恢复的
// INVALID_ARGUMENT_JSON。这里锁定"原始参数恢复"这条链路。

import assert from 'node:assert/strict';
import { chat } from '../src/llm/llm.js';
import {
  mergeRawArguments,
  rawArgumentsByToolCallId,
  shouldPreferRawArguments,
  ToolArgumentAccumulator,
} from '../src/llm/tool-call-arguments.js';

const originalFetch = globalThis.fetch;

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

// ---- 1. 累积器 ----

await test('累积器：按 contentIndex 拼接片段，忽略空片段', () => {
  const acc = new ToolArgumentAccumulator();
  acc.push(0, '{"path"');
  acc.push(0, ': "src/a.ts"}');
  acc.push(0, '');
  acc.push(1, '{}');
  const snapshot = acc.snapshot();
  assert.equal(snapshot.get(0), '{"path": "src/a.ts"}');
  assert.equal(snapshot.get(1), '{}');
});

await test('累积器：snapshot 是副本，后续 push 不影响已取快照', () => {
  const acc = new ToolArgumentAccumulator();
  acc.push(0, '{"a":');
  const snapshot = acc.snapshot();
  acc.push(0, '1}');
  assert.equal(snapshot.get(0), '{"a":');
  assert.equal(acc.snapshot().get(0), '{"a":1}');
});

// ---- 2. 何时用原始参数 ----

await test('解码为空对象且原文非空非 {} → 用原始参数（畸形 JSON）', () => {
  assert.equal(shouldPreferRawArguments({}, '{"path": '), true);
  assert.equal(shouldPreferRawArguments({}, '{"path":"a"'), true);
  assert.equal(shouldPreferRawArguments({}, 'not json at all'), true);
});

await test('原文就是空对象 → 不接管（合法的无参调用）', () => {
  assert.equal(shouldPreferRawArguments({}, '{}'), false);
  assert.equal(shouldPreferRawArguments({}, '  {  }  '), false);
  assert.equal(shouldPreferRawArguments({}, ''), false);
  assert.equal(shouldPreferRawArguments({}, '   '), false);
});

await test('解码非空 → 永远信任解码结果（不覆盖）', () => {
  assert.equal(shouldPreferRawArguments({ path: 'a' }, '{"path": '), false);
  assert.equal(shouldPreferRawArguments({ path: 'a' }, '{"path":"b"}'), false);
});

await test('解码为数组/字符串/数字等非对象 → 不按"空对象"处理', () => {
  assert.equal(shouldPreferRawArguments([], '[]'), false);
  assert.equal(shouldPreferRawArguments('x', 'x'), false);
  assert.equal(shouldPreferRawArguments(0, '0'), false);
  assert.equal(shouldPreferRawArguments(null, 'null'), false);
});

// ---- 3. 映射到 tool_call id ----

await test('按 content 索引把原始参数映射到 tool_call id', () => {
  const blocks = [
    { type: 'text' },
    { type: 'toolCall', id: 'call-1', arguments: {} },
    { type: 'toolCall', id: 'call-2', arguments: { path: 'a' } },
  ];
  const fragments = new Map<number, string>([
    [1, '{"path": '],
    [2, '{"path":"a"}'],
  ]);
  const mapped = rawArgumentsByToolCallId(blocks, fragments);
  assert.equal(mapped.get('call-1'), '{"path": ');
  assert.equal(mapped.has('call-2'), false, '解码非空不应被接管');
});

await test('非 toolCall 块与缺失 id 被忽略', () => {
  const blocks = [
    { type: 'text' },
    { type: 'toolCall', arguments: {} },
    { type: 'toolCall', id: 'ok', arguments: {} },
  ];
  const mapped = rawArgumentsByToolCallId(blocks, new Map([[0, 'text'], [1, '{}'], [2, '{}']]));
  assert.equal(mapped.size, 0);
});

await test('mergeRawArguments：不覆盖传输层已有条目', () => {
  const existing = new Map([['call-1', '{"from":"openai-path"}']]);
  const merged = mergeRawArguments(existing, new Map([['call-1', '{"raw":'], ['call-2', '{"b":']]));
  assert.equal(merged?.get('call-1'), '{"from":"openai-path"}');
  assert.equal(merged?.get('call-2'), '{"b":');
});

await test('mergeRawArguments：两边都空 → undefined（不产生空 map）', () => {
  assert.equal(mergeRawArguments(undefined, new Map()), undefined);
});

// ---- 4. 集成：Anthropic 原生适配器（pi-ai）流式解析 ----

interface SseEvent {
  event: string;
  data: unknown;
}

function anthropicStream(partialJsonFragments: string[]): string {
  const events: SseEvent[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'MiniMax-M3',
          content: [],
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_test', name: 'read', input: {} },
      },
    },
    ...partialJsonFragments.map((fragment) => ({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: fragment },
      },
    })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  return events
    .map((item) => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`)
    .join('');
}

async function chatViaAnthropic(fragments: string[]) {
  globalThis.fetch = (async () =>
    new Response(anthropicStream(fragments), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch;
  return chat([{ role: 'user', content: '读取文件' }], undefined, undefined, {
    baseUrl: 'https://api.minimaxi.com/anthropic',
    apiKey: 'sk-test',
    model: 'MiniMax-M3',
    providerId: 'minimax-cn',
    piProviderId: 'minimax-cn',
  });
}

await test('集成：畸形 JSON 被还原为原文（Runtime 才能报 INVALID_ARGUMENT_JSON）', async () => {
  const message = await chatViaAnthropic(['{"path":', ' ']);
  assert.equal(message.tool_calls?.length, 1);
  assert.equal(
    message.tool_calls?.[0].function.arguments,
    '{"path": ',
    '必须保留模型原文，而不是 {}',
  );
  assert.equal(message.tool_calls?.[0].function.name, 'read');
});

await test('集成：合法 JSON 参数保持原样（不被原文接管）', async () => {
  const message = await chatViaAnthropic(['{"path": "src/a.ts"}']);
  assert.equal(message.tool_calls?.[0].function.arguments, '{"path":"src/a.ts"}');
});

await test('集成：合法的空对象参数保持 {}', async () => {
  const message = await chatViaAnthropic(['{}']);
  assert.equal(message.tool_calls?.[0].function.arguments, '{}');
});

globalThis.fetch = originalFetch;

console.log(`\ntool-call-arguments 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
