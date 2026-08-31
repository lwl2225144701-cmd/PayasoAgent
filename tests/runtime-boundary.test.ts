// Deterministic architecture boundary test: importing Agent Runtime alone must
// not register product tools or derive an execution root. Bootstrap owns both.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-runtime-boundary-"));
process.env.SANDBOX_ROOT = path.join(root, "sandbox");

const { runAgent } = await import("../src/runtime/agent.js");
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
    }),
    /runId does not match/
  );
  assert.equal(llmCalled, false);
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("Runtime boundary tests: PASS");
