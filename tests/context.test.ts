// Deterministic model-context configuration, estimation, and trimming tests.

import assert from "node:assert/strict";
import { ContextManager } from "../src/runtime/context.js";
import {
  estimateTextTokens,
  resolveModelContextConfig,
} from "../src/runtime/model-context.js";
import type { ChatMessage, ToolSchema } from "../src/llm/llm.js";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

test("MiniMax-M3 uses guaranteed 512K registry context", () => {
  const config = resolveModelContextConfig({}, { OPENAI_MODEL: "MiniMax-M3" });
  assert.equal(config.contextWindowTokens, 512_000);
  assert.equal(config.source, "model_registry");
  assert.ok(config.maxInputTokens < config.contextWindowTokens);
  assert.ok(config.maxInputTokens > 400_000);
});

test("explicit Host configuration overrides model registry", () => {
  const config = resolveModelContextConfig({}, {
    OPENAI_MODEL: "MiniMax-M3",
    MODEL_CONTEXT_WINDOW_TOKENS: "100000",
    MODEL_MAX_OUTPUT_TOKENS: "10000",
    MODEL_CONTEXT_SAFETY_TOKENS: "5000",
  });
  assert.equal(config.source, "env");
  assert.equal(config.maxInputTokens, 85_000);
});

test("invalid context configuration fails early", () => {
  assert.throws(() => resolveModelContextConfig({}, { MODEL_CONTEXT_WINDOW_TOKENS: "nope" }));
  assert.throws(() => resolveModelContextConfig({}, {
    MODEL_CONTEXT_WINDOW_TOKENS: "1000",
    MODEL_MAX_OUTPUT_TOKENS: "900",
    MODEL_CONTEXT_SAFETY_TOKENS: "200",
  }));
});

// ---- v1.6 显式模型路径：Run 模型是能力解析的唯一来源，环境变量不参与 ----

test("explicit run model wins over OPENAI_MODEL env (Case 1)", () => {
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

test("explicit model path ignores numeric env overrides", () => {
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

test("unknown explicit run model uses conservative fallback with run_model source", () => {
  const config = resolveModelContextConfig(
    { model: "some-future-model" },
    { OPENAI_MODEL: "MiniMax-M3" },
  );
  assert.equal(config.model, "some-future-model");
  assert.equal(config.source, "run_model");
  assert.equal(config.contextWindowTokens, 32_768);
  assert.equal(config.maxOutputTokens, 4_096);
});

test("invalid explicit numeric input fails early", () => {
  assert.throws(() => resolveModelContextConfig({ model: "MiniMax-M3", contextWindowTokens: 0 }));
  assert.throws(() => resolveModelContextConfig({ model: "MiniMax-M3", maxOutputTokens: 1.5 }));
});

test("mixed-language estimator is deterministic and conservative", () => {
  assert.equal(estimateTextTokens("abcdef"), 2);
  assert.equal(estimateTextTokens("你好"), 2);
  assert.equal(estimateTextTokens("abc你好"), 3);
});

test("tool schemas count toward the input budget", () => {
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

test("old history is trimmed but mandatory system/user remain", () => {
  const manager = new ContextManager(120);
  const messages: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    { role: "assistant", content: "old".repeat(80) },
    { role: "tool", tool_call_id: "old", content: "old-result".repeat(40) },
    { role: "assistant", content: "recent" },
  ];
  const { messages: trimmed, usage } = manager.process(messages);
  assert.equal(trimmed[0].role, "system");
  assert.equal(trimmed[1].role, "user");
  assert.ok(usage.trimmedMessages > 0);
  assert.equal(usage.overBudget, false);
});

console.log(`\nContext tests: ${passed} passed / ${failed} failed`);
if (failed) process.exitCode = 1;
