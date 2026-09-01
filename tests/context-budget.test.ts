// Deterministic Agent-level test: the context budget hard-fail path.
// When the mandatory model view (system + last user + tool schemas) cannot fit
// the budget, runAgent must abort WITHOUT calling the LLM, record a failed
// checkpoint, and emit an error trace event. No real network is used.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../src/runtime/agent.js";
import { createAgentExecutionContext, createDefaultRuntimeServices } from "../src/bootstrap/runtime-bootstrap.js";
import { checkpointPath, loadCheckpoint } from "../src/persistence/file-checkpoint-store.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-overbudget-"));
process.env.SANDBOX_ROOT = path.join(base, "runtime-sandbox");

const originalFetch = globalThis.fetch;
const originalEnv = {
  window: process.env.MODEL_CONTEXT_WINDOW_TOKENS,
  output: process.env.MODEL_MAX_OUTPUT_TOKENS,
  safety: process.env.MODEL_CONTEXT_SAFETY_TOKENS,
};

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  await test("runAgent hard-fails on over-budget context without calling LLM", async () => {
    // Tiny but valid budget (1000 - 400 - 200 = 400 input tokens) so the
    // mandatory system + last user + tool schemas cannot fit. The over-budget
    // check happens BEFORE chat(), so the LLM must never be reached.
    process.env.MODEL_CONTEXT_WINDOW_TOKENS = "1000";
    process.env.MODEL_MAX_OUTPUT_TOKENS = "400";
    process.env.MODEL_CONTEXT_SAFETY_TOKENS = "200";

    let llmCalled = false;
    globalThis.fetch = async () => {
      llmCalled = true;
      throw new Error("LLM must not be reached when context is over budget");
    };

    const runId = "overbudget-run";
    const events: { type?: string; message?: string }[] = [];
    try {
      await assert.rejects(
        () =>
          runAgent("overbudget task " + "x".repeat(200), undefined, {
            executionContext: createAgentExecutionContext({ runId }),
            ...createDefaultRuntimeServices(),
            onTrace: (ev) => events.push(ev as { type?: string; message?: string }),
          }),
        /Context budget exceeded/
      );

      assert.equal(llmCalled, false, "LLM must not be called when context is over budget");
      assert.ok(
        events.some((e) => e.type === "error" && /Context budget exceeded/.test(String(e.message))),
        "an error trace event should record the over-budget failure"
      );

      const cp = loadCheckpoint(runId);
      assert.equal(cp?.status, "failed", "checkpoint should persist a failed status");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv.window === undefined) delete process.env.MODEL_CONTEXT_WINDOW_TOKENS;
      else process.env.MODEL_CONTEXT_WINDOW_TOKENS = originalEnv.window;
      if (originalEnv.output === undefined) delete process.env.MODEL_MAX_OUTPUT_TOKENS;
      else process.env.MODEL_MAX_OUTPUT_TOKENS = originalEnv.output;
      if (originalEnv.safety === undefined) delete process.env.MODEL_CONTEXT_SAFETY_TOKENS;
      else process.env.MODEL_CONTEXT_SAFETY_TOKENS = originalEnv.safety;
      fs.rmSync(checkpointPath(runId), { force: true });
    }
  });

  console.log(`\ncontext-budget tests: ${passed} passed / ${failed} failed`);
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch { /* best effort */ }
  if (failed) process.exitCode = 1;
}

void main();
