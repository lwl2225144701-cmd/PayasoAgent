import assert from 'node:assert/strict';
import { mergeStreamingEvents } from '../web/src/hooks/stream-state.js';
import { appendFinalAnswerBatch, collectFinalAnswerText } from '../web/src/hooks/useEventStream.js';
import type { HostEvent } from '../web/src/types.js';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

/** 流式通道事件工厂（assistant/reasoning，每人独立 messageId）。 */
const base = { runId: 'stream-run', timestamp: '2026-09-04T00:00:00.000Z' };
const assistant = (messageId: string, delta: string): HostEvent => ({
  ...base,
  type: 'assistant_delta',
  messageId,
  delta,
});
const reasoning = (messageId: string, delta: string): HostEvent => ({
  ...base,
  type: 'reasoning_delta',
  messageId,
  delta,
});

check('consecutive assistant deltas are coalesced', () => {
  const merged = mergeStreamingEvents(
    [assistant('m1', '你好')],
    [assistant('m1', '，'), assistant('m1', '世界')],
  );
  assert.equal(merged.length, 1, 'consecutive assistant chunks should be one UI event');
  assert.equal((merged[0] as { delta: string }).delta, '你好，世界');
});

check('reasoning and assistant streams keep their boundaries', () => {
  const separated = mergeStreamingEvents(
    [],
    [reasoning('m1', '思考'), assistant('m1', '答案'), assistant('m1', '继续')],
  );
  assert.equal(separated.length, 2, 'reasoning and answer streams must stay separate');
  assert.equal((separated[0] as { type: string; delta: string }).type, 'reasoning_delta');
  assert.equal((separated[1] as { type: string; delta: string }).delta, '答案继续');
});

check('terminal events are not swallowed by stream coalescing', () => {
  const ordered = mergeStreamingEvents(
    [],
    [assistant('m1', 'a'), { ...base, type: 'run_completed' }, assistant('m1', 'b')],
  );
  assert.equal(ordered.length, 3, 'non-stream events must preserve order and boundaries');
  assert.equal(ordered[1].type, 'run_completed');
});

check('later stream messages do not merge across lifecycle events', () => {
  const replay = mergeStreamingEvents(
    [assistant('m1', 'a')],
    [assistant('m1', 'b'), { ...base, type: 'run_completed' }, assistant('m2', 'c')],
  );
  assert.deepEqual(
    replay.map((event) => event.type),
    ['assistant_delta', 'run_completed', 'assistant_delta'],
    'a later message must not merge across a terminal event',
  );
});

// ---- 最终答案流式文本：只跟最后一个 messageId ----
//
// 真实事故（2026-09-28）：多轮工具调用的过渡句（各有独立 messageId）被无差别
// 累加进回复气泡，69 轮短句拼成一大段。修复后：新 messageId 出现即重新起头。

check('collectFinalAnswerText: 只保留最后一个 messageId 的增量', () => {
  // 场景：轮 1 过渡句（m1）→ 轮 2 过渡句（m2）→ 轮 3 最终答案（m3，分多个 delta）
  const events: HostEvent[] = [
    assistant('m1', '先建计划：'),
    reasoning('m1', '思考中'),
    assistant('m2', '现在看 X：'),
    assistant('m3', '修复完成。'),
    assistant('m3', '回归全绿。'),
  ];
  assert.equal(collectFinalAnswerText(events), '修复完成。回归全绿。');
});

check('collectFinalAnswerText: 单轮 messageId 行为不变', () => {
  // 单轮场景：只有一个 messageId，行为与旧的累加完全一致
  const events: HostEvent[] = [assistant('m1', '你好'), assistant('m1', '，世界')];
  assert.equal(collectFinalAnswerText(events), '你好，世界');
});

check('collectFinalAnswerText: 无答案增量 → 空串', () => {
  // 无 assistant 增量 → 空串（不触碰 streamedText 的既有短路逻辑）
  const events: HostEvent[] = [
    reasoning('m1', '思考'),
    { ...base, type: 'tool_call' } as unknown as HostEvent,
  ];
  assert.equal(collectFinalAnswerText(events), '');
});

check('appendFinalAnswerBatch: 分批增量跨轮正确重新起头', () => {
  // live 增量路径：分批到达也能正确重新起头
  // 批 1 = 轮 1 过渡句；批 2 = 轮 2 过渡句（新 messageId → 重新起头）；批 3 = 轮 2 继续 + 轮 3 最终答案
  const b1 = [assistant('m1', '先建计划：')];
  const b2 = [assistant('m2', '现在看 X：')];
  const b3 = [assistant('m2', '继续'), assistant('m3', '修复完成。')];
  let state = { text: '', lastMessageId: null as string | null };
  state = appendFinalAnswerBatch(state.text, state.lastMessageId, b1);
  assert.equal(state.text, '先建计划：');
  state = appendFinalAnswerBatch(state.text, state.lastMessageId, b2);
  assert.equal(state.text, '现在看 X：', '新轮重新起头');
  state = appendFinalAnswerBatch(state.text, state.lastMessageId, b3);
  assert.equal(state.text, '修复完成。', '批内新轮也重新起头');
  assert.equal(state.lastMessageId, 'm3');
});

check('appendFinalAnswerBatch: 同轮后续增量继续拼接', () => {
  // 批内新 messageId 后：后续同轮增量继续拼接（不重复起头）
  const batch = [assistant('m3', '修复完成。'), assistant('m3', '回归全绿。')];
  const state = appendFinalAnswerBatch('旧轮文本', 'm2', batch);
  assert.equal(state.text, '修复完成。回归全绿。');
  assert.equal(state.lastMessageId, 'm3');
});

check('collectFinalAnswerText: 重放幂等', () => {
  // 幂等性：同一批事件重复回放（SSE 重连场景）结果不变
  const events: HostEvent[] = [assistant('m1', 'a'), assistant('m2', 'b')];
  assert.equal(collectFinalAnswerText(events), collectFinalAnswerText(events));
});

console.log(`\nFrontend streaming tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：相邻块合并 / 类型与生命周期边界 / 最终答案只跟最后一个 messageId ✓');
