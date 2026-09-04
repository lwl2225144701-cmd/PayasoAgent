import assert from "node:assert/strict";
import { mergeStreamingEvents } from "../web/src/hooks/stream-state.js";
import type { HostEvent } from "../web/src/types.js";

const base = { runId: "stream-run", timestamp: "2026-09-04T00:00:00.000Z" };
const assistant = (messageId: string, delta: string): HostEvent => ({
  ...base,
  type: "assistant_delta",
  messageId,
  delta,
});
const reasoning = (messageId: string, delta: string): HostEvent => ({
  ...base,
  type: "reasoning_delta",
  messageId,
  delta,
});

const merged = mergeStreamingEvents(
  [assistant("m1", "你好")],
  [assistant("m1", "，"), assistant("m1", "世界")],
);
assert.equal(merged.length, 1, "consecutive assistant chunks should be one UI event");
assert.equal((merged[0] as { delta: string }).delta, "你好，世界");
console.log("  [PASS] consecutive assistant deltas are coalesced");

const separated = mergeStreamingEvents(
  [],
  [reasoning("m1", "思考"), assistant("m1", "答案"), assistant("m1", "继续")],
);
assert.equal(separated.length, 2, "reasoning and answer streams must stay separate");
assert.equal((separated[0] as { type: string; delta: string }).type, "reasoning_delta");
assert.equal((separated[1] as { type: string; delta: string }).delta, "答案继续");
console.log("  [PASS] reasoning and assistant streams keep their boundaries");

const ordered = mergeStreamingEvents(
  [],
  [assistant("m1", "a"), { ...base, type: "run_completed" }, assistant("m1", "b")],
);
assert.equal(ordered.length, 3, "non-stream events must preserve order and boundaries");
assert.equal(ordered[1].type, "run_completed");
console.log("  [PASS] terminal events are not swallowed by stream coalescing");

const replay = mergeStreamingEvents(
  [assistant("m1", "a")],
  [assistant("m1", "b"), { ...base, type: "run_completed" }, assistant("m2", "c")],
);
assert.deepEqual(
  replay.map((event) => event.type),
  ["assistant_delta", "run_completed", "assistant_delta"],
  "a later message must not merge across a terminal event",
);
console.log("  [PASS] later stream messages do not merge across lifecycle events");

console.log("\nFrontend streaming tests: 4 PASS / 0 FAIL");
