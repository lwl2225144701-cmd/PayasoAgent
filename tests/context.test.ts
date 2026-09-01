// Deterministic model-context configuration, estimation, and trimming tests.

import assert from "node:assert/strict";
import { ContextManager } from "../src/harness/context-manager.js";
import { DefaultContextHarness } from "../src/harness/context-harness.js";
import {
  estimateTextTokens,
  resolveModelContextConfig,
} from "../src/harness/model-context.js";
import type { ChatMessage, ToolSchema } from "../src/llm/llm.js";
import type { ConversationSummarizer } from "../src/harness/conversation-summarizer.js";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

await test("MiniMax-M3 uses guaranteed 512K registry context", () => {
  const config = resolveModelContextConfig({}, { OPENAI_MODEL: "MiniMax-M3" });
  assert.equal(config.contextWindowTokens, 512_000);
  assert.equal(config.source, "model_registry");
  assert.ok(config.maxInputTokens < config.contextWindowTokens);
  assert.ok(config.maxInputTokens > 400_000);
});

await test("explicit Host configuration overrides model registry", () => {
  const config = resolveModelContextConfig({}, {
    OPENAI_MODEL: "MiniMax-M3",
    MODEL_CONTEXT_WINDOW_TOKENS: "100000",
    MODEL_MAX_OUTPUT_TOKENS: "10000",
    MODEL_CONTEXT_SAFETY_TOKENS: "5000",
  });
  assert.equal(config.source, "env");
  assert.equal(config.maxInputTokens, 85_000);
});

await test("invalid context configuration fails early", () => {
  assert.throws(() => resolveModelContextConfig({}, { MODEL_CONTEXT_WINDOW_TOKENS: "nope" }));
  assert.throws(() => resolveModelContextConfig({}, {
    MODEL_CONTEXT_WINDOW_TOKENS: "1000",
    MODEL_MAX_OUTPUT_TOKENS: "900",
    MODEL_CONTEXT_SAFETY_TOKENS: "200",
  }));
});

// ---- v1.6 显式模型路径：Run 模型是能力解析的唯一来源，环境变量不参与 ----

await test("explicit run model wins over OPENAI_MODEL env (Case 1)", () => {
  const config = resolveModelContextConfig(
    { model: "MiniMax-M3" },
    { OPENAI_MODEL: "gpt-4o-mini" },
  );
  assert.equal(config.model, "MiniMax-M3");
  assert.equal(config.source, "run_model");
  assert.equal(config.contextWindowTokens, 512_000);
  assert.equal(config.maxOutputTokens, 16_384);
  assert.ok(config.maxInputTokens < config.contextWindowTokens);
});

await test("explicit model path ignores numeric env overrides", () => {
  const config = resolveModelContextConfig(
    { model: "MiniMax-M3", contextWindowTokens: 100_000 },
    {
      OPENAI_MODEL: "gpt-4o-mini",
      MODEL_CONTEXT_WINDOW_TOKENS: "999999",
      MODEL_MAX_OUTPUT_TOKENS: "7777",
    },
  );
  assert.equal(config.source, "run_model");
  assert.equal(config.contextWindowTokens, 100_000);
  assert.equal(config.maxOutputTokens, 16_384);
});

await test("unknown explicit run model uses conservative fallback with run_model source", () => {
  const config = resolveModelContextConfig(
    { model: "some-future-model" },
    { OPENAI_MODEL: "MiniMax-M3" },
  );
  assert.equal(config.model, "some-future-model");
  assert.equal(config.source, "run_model");
  assert.equal(config.contextWindowTokens, 32_768);
  assert.equal(config.maxOutputTokens, 4_096);
});

await test("invalid explicit numeric input fails early", () => {
  assert.throws(() => resolveModelContextConfig({ model: "MiniMax-M3", contextWindowTokens: 0 }));
  assert.throws(() => resolveModelContextConfig({ model: "MiniMax-M3", maxOutputTokens: 1.5 }));
});

await test("mixed-language estimator is deterministic and conservative", () => {
  assert.equal(estimateTextTokens("abcdef"), 2);
  assert.equal(estimateTextTokens("你好"), 2);
  assert.equal(estimateTextTokens("abc你好"), 3);
});

await test("tool schemas count toward the input budget", () => {
  const manager = new ContextManager(100);
  const messages: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
  ];
  const tools: ToolSchema[] = [{
    type: "function",
    function: {
      name: "large",
      description: "x".repeat(240),
      parameters: { type: "object", properties: {} },
    },
  }];
  const { usage } = manager.process(messages, tools);
  assert.ok(usage.toolSchemaTokens > 80);
  assert.equal(usage.overBudget, true);
});

await test("old complete turns are trimmed while current turn stays chronological", () => {
  const manager = new ContextManager(120);
  const messages: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "old-task" },
    { role: "assistant", content: "old".repeat(100) },
    { role: "user", content: "current-task" },
    { role: "assistant", content: "current-tool-call" },
    { role: "tool", tool_call_id: "current", content: "current-result" },
  ];
  const { messages: trimmed, usage } = manager.process(messages);
  assert.equal(trimmed[0].role, "system");
  assert.equal(trimmed[1].role, "user");
  assert.equal(trimmed[1].content, "current-task");
  assert.deepEqual(trimmed.slice(2).map((message) => message.role), ["assistant", "tool"]);
  assert.ok(usage.trimmedMessages > 0);
  assert.equal(usage.overBudget, false);
});

await test("Harness builds a temporary model view without mutating the transcript", async () => {
  const harness = new DefaultContextHarness({
    permissionMode: "read-only",
    model: "MiniMax-M3",
  });
  const transcript = harness.createTranscript("current task", [
    { role: "user", content: "previous question" },
    { role: "assistant", content: "previous answer" },
  ]);
  const original = structuredClone(transcript);
  const view = await harness.prepareTurn(transcript, {
    task: "current task",
    completedSteps: [],
    failedSteps: [],
    invalidSteps: [],
    nextStep: null,
    lastResult: "",
  }, []);

  assert.deepEqual(transcript, original, "canonical transcript must remain unchanged");
  assert.match(view.messages[0].content, /Read Only/);
  assert.match(view.messages[0].content, /执行进度 Scratchpad/);
  assert.doesNotMatch(transcript[0].content, /执行进度 Scratchpad/);
});

await test("Harness removes provider reasoning and inline think text from history", () => {
  const harness = new DefaultContextHarness({ permissionMode: "workspace-write", model: "MiniMax-M3" });
  const sanitized = harness.sanitizeAssistantMessage({
    role: "assistant",
    content: "<think>secret</think> visible",
    reasoning_content: "provider reasoning",
  });
  assert.equal(sanitized.content, "visible");
  assert.equal(sanitized.reasoning_content, undefined);
});

await test("Harness bounds the Scratchpad model view", async () => {
  const modelContext = resolveModelContextConfig({
    model: "context-test",
    contextWindowTokens: 6_000,
    maxOutputTokens: 1_000,
    safetyTokens: 500,
  });
  const harness = new DefaultContextHarness({
    permissionMode: "workspace-write",
    modelContext,
  });
  const completedSteps = Array.from({ length: 40 }, (_, index) => ({
    step: index + 1,
    tool: "readFile",
    input: `file-${index}.txt`,
    result: "r".repeat(2_000),
  }));
  const view = await harness.prepareTurn(
    harness.createTranscript("bounded scratchpad"),
    {
      task: "bounded scratchpad",
      completedSteps,
      failedSteps: [],
      invalidSteps: [],
      nextStep: null,
      lastResult: "z".repeat(5_000),
    },
    [],
  );
  assert.equal(view.scratchpadTruncated, true);
  assert.ok(view.scratchpadTokens <= 450, `scratchpad tokens=${view.scratchpadTokens}`);
  assert.match(view.messages[0].content, /已省略更早/);
});

await test("Harness incrementally summarizes old complete turns and restores summary state", async () => {
  const modelContext = resolveModelContextConfig({
    model: "context-test",
    contextWindowTokens: 6_000,
    maxOutputTokens: 1_000,
    safetyTokens: 500,
  });
  const requests: Array<{ previousSummary: string; messages: ChatMessage[] }> = [];
  const summarizer: ConversationSummarizer = {
    summarize: async (request) => {
      requests.push({
        previousSummary: request.previousSummary,
        messages: structuredClone(request.messages),
      });
      return `Goal: keep context\nProgress: compacted batch ${requests.length}`;
    },
  };
  const harness = new DefaultContextHarness({
    permissionMode: "workspace-write",
    modelContext,
    summarizer,
  });
  const history: ChatMessage[] = [];
  for (let index = 0; index < 8; index++) {
    history.push({ role: "user", content: `old-user-${index} ${"u".repeat(1_500)}` });
    history.push({ role: "assistant", content: `old-answer-${index} ${"a".repeat(1_500)}` });
  }
  const transcript = harness.createTranscript("current-task", history);
  const scratchpad = {
    task: "current-task",
    completedSteps: [],
    failedSteps: [],
    invalidSteps: [],
    nextStep: null,
    lastResult: "",
  };
  const first = await harness.prepareTurn(transcript, scratchpad, []);
  assert.ok(first.compaction && first.compaction.summarizedMessages > 0);
  assert.equal(requests.length, 1);
  assert.match(first.messages[0].content, /\[Conversation Summary\]/);
  assert.match(first.messages[0].content, /compacted batch 1/);
  assert.equal(first.messages.at(-1)?.content, "current-task");
  assert.ok(!first.messages.some((message) => message.content.includes("old-user-0")));

  transcript.push({ role: "assistant", content: `current-answer ${"x".repeat(4_000)}` });
  transcript.push({ role: "user", content: "next-task" });
  const second = await harness.prepareTurn(transcript, { ...scratchpad, task: "next-task" }, []);
  assert.ok(second.compaction && second.compaction.summarizedMessages > 0);
  assert.equal(requests.length, 2);
  assert.match(requests[1].previousSummary, /compacted batch 1/);
  assert.equal(second.messages.at(-1)?.content, "next-task");

  const savedState = harness.snapshotState();
  const restored = new DefaultContextHarness({
    permissionMode: "workspace-write",
    modelContext,
    state: savedState,
    summarizer: { summarize: async () => { throw new Error("should not be needed"); } },
  });
  const restoredView = await restored.prepareTurn(transcript, { ...scratchpad, task: "next-task" }, []);
  assert.deepEqual(restored.snapshotState(), savedState);
  assert.match(restoredView.messages[0].content, /compacted batch 2/);
  assert.ok(!restoredView.messages.some((message) => message.content.includes("old-user-0")));
});

console.log(`\nContext tests: ${passed} passed / ${failed} failed`);
if (failed) process.exitCode = 1;
