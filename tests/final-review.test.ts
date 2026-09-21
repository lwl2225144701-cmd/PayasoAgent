// 有界交付检查：不重放工具，不静默放过无法验证的答复。
import assert from 'node:assert/strict';
import { reviewFinalAnswer } from '../src/harness/final-review.js';
import type { ChatMessage } from '../src/llm/llm.js';
const messages: ChatMessage[] = [{ role: 'user', content: '总结日期' }, { role: 'tool', content: '日期尚未确认', tool_call_id: 'read1' }];
let calls = 0;
const response = (issues: string[], revisedAnswer: string | null): ChatMessage => ({ role: 'assistant', content: JSON.stringify({ issues, revisedAnswer }) });
assert.equal(await reviewFinalAnswer({ messages, answer: '日期未定', call: async () => { calls++; return response([], null); } }, 10000), '日期未定');
assert.equal(calls, 1);
calls = 0;
assert.equal(await reviewFinalAnswer({ messages, answer: '明天上线', call: async input => {
  assert.ok(input.every(m => m.role === 'system' || m.role === 'user'));
  return ++calls === 1 ? response(['原文未确认'], '日期未定') : response([], null);
} }, 10000), '日期未定');
assert.equal(calls, 2);
calls = 0;
await assert.rejects(reviewFinalAnswer({ messages, answer: '错误', call: async () => { calls++; return response(['仍无依据'], '再次改写'); } }, 10000), /未通过/);
assert.equal(calls, 2);
await assert.rejects(reviewFinalAnswer({ messages, answer: '已修复', call: async () => response(['代码未修改'], null) }, 10000), /未通过/);
await assert.rejects(reviewFinalAnswer({ messages, answer: '草稿', call: async () => ({ role: 'assistant', content: 'PASS' }) }, 10000), /有效结果/);
await assert.rejects(reviewFinalAnswer({ messages, answer: '草稿', call: async () => ({ ...response([], null), tool_calls: [{ id: 'x', type: 'function', function: { name: 'write', arguments: '{}' } }] }) }, 10000), /工具/);
await assert.rejects(reviewFinalAnswer({ messages, answer: '草稿', call: async () => { throw Error('不应调用'); } }, 1), /预算/);
console.log('Final review: 7 PASS');
