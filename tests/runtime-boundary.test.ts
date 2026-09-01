// Deterministic architecture boundary test: importing Agent Runtime alone must
// not register product tools or derive an execution root. Bootstrap owns both.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-runtime-boundary-"));
process.env.SANDBOX_ROOT = path.join(root, "sandbox");

const { runAgent } = await import("../src/runtime/agent.js");
const { silentRuntimeObserver } = await import("../src/runtime/observer-port.js");
const { getSchemas } = await import("../src/tools/tools.js");

assert.equal(getSchemas().length, 0, "Runtime import must not register concrete tools");

const { createAgentExecutionContext } = await import("../src/bootstrap/runtime-bootstrap.js");
assert.ok(getSchemas().length > 0, "bootstrap must register the default local tools");

const legacy = createAgentExecutionContext({ runId: "boundary-legacy" });
assert.ok(fs.statSync(legacy.workspaceRoot).isDirectory());
assert.equal(legacy.permissionMode, "workspace-write");
for (const child of ["input", "work", "output"]) {
  assert.ok(fs.statSync(path.join(legacy.workspaceRoot, child)).isDirectory());
}

const realRoot = path.join(root, "real-workspace");
fs.mkdirSync(realRoot);
const explicit = createAgentExecutionContext({
  runId: "boundary-real",
  workspaceRoot: realRoot,
  permissionMode: "read-only",
});
assert.equal(explicit.workspaceRoot, fs.realpathSync.native(realRoot));
assert.equal(explicit.permissionMode, "read-only");
assert.throws(
  () => createAgentExecutionContext({ runId: "boundary-relative", workspaceRoot: "relative/path" }),
  /绝对路径/
);

let llmCalled = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  llmCalled = true;
  throw new Error("LLM should not run for mismatched execution context");
};
try {
  await assert.rejects(
    () => runAgent("mismatch", {
      runId: "checkpoint-run",
      task: "mismatch",
      status: "running",
      iteration: 0,
      scratchpad: {
        task: "mismatch",
        completedSteps: [],
        failedSteps: [],
        invalidSteps: [],
        nextStep: null,
        lastResult: "",
      },
      messages: [{ role: "user", content: "mismatch" }],
      state: {
        runId: "checkpoint-run",
        task: "mismatch",
        status: "running",
        iteration: 0,
        currentStep: "init",
        toolCalls: 0,
        successfulToolCalls: 0,
        failedToolCalls: 0,
        invalidToolResults: 0,
        startTime: new Date().toISOString(),
      },
    }, {
      executionContext: explicit,
      checkpointWriter: {
        save: () => {
          throw new Error("checkpoint should not be written for mismatched context");
        },
      },
      observer: silentRuntimeObserver,
    }),
    /runId does not match/
  );
  assert.equal(llmCalled, false);

  const snapshots: Array<{ runId: string; status: string; workspaceRoot?: string }> = [];
  const observedEvents: string[] = [];
  const observedStates: string[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "boundary done" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  const answer = await runAgent("injected persistence", undefined, {
    executionContext: explicit,
    checkpointWriter: {
      save: (snapshot) => {
        snapshots.push(snapshot);
        return `memory://${snapshot.runId}`;
      },
    },
    observer: {
      log: () => {},
      state: (state, detail) => {
        observedStates.push(`${detail}:${state.status}`);
        (state as { status: string }).status = "failed";
      },
      scratchpad: () => {},
      traceEvent: (event) => observedEvents.push(event.type),
      trace: () => {},
    },
    modelConfig: {
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "gpt-4o-mini",
    },
  });
  assert.equal(answer, "boundary done");
  assert.equal(snapshots.length, 1, "Runtime must commit through the injected writer");
  assert.equal(snapshots[0]?.runId, explicit.runId);
  assert.equal(snapshots[0]?.status, "completed");
  assert.equal(snapshots[0]?.workspaceRoot, explicit.workspaceRoot);
  assert.deepEqual(observedEvents, ["context_trim", "context_usage", "llm_call", "final_answer"]);
  assert.ok(observedStates.includes("summary:completed"));
  assert.ok(observedStates.includes("full:completed"));

  const resilientContext = createAgentExecutionContext({
    runId: "boundary-observer-failure",
    workspaceRoot: realRoot,
  });
  const resilientAnswer = await runAgent("observer failure", undefined, {
    executionContext: resilientContext,
    checkpointWriter: { save: () => "memory://observer-failure" },
    observer: {
      log: () => { throw new Error("observer log failed"); },
      state: () => { throw new Error("observer state failed"); },
      scratchpad: () => { throw new Error("observer scratchpad failed"); },
      traceEvent: () => { throw new Error("observer event failed"); },
      trace: () => { throw new Error("observer trace failed"); },
    },
    modelConfig: {
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "gpt-4o-mini",
    },
  });
  assert.equal(resilientAnswer, "boundary done", "observer failure must not change execution");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("Runtime boundary tests: PASS");
