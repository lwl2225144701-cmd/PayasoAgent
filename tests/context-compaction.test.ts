// Agent-level deterministic proof for Harness compaction, checkpoint state and
// canonical transcript preservation. No real network or provider is used.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../src/runtime/agent.js";
import { DefaultContextHarness } from "../src/harness/context-harness.js";
import { resolveModelContextConfig } from "../src/harness/model-context.js";
import { createAgentExecutionContext, createDefaultRuntimeServices } from "../src/bootstrap/runtime-bootstrap.js";
import { checkpointPath, loadCheckpoint } from "../src/persistence/file-checkpoint-store.js";
import { silentRuntimeObserver } from "../src/runtime/observer-port.js";
import type { ChatMessage } from "../src/llm/llm.js";
import type { TraceEvent } from "../src/runtime/trace.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-context-compaction-"));
process.env.SANDBOX_ROOT = path.join(root, "sandbox");
const runId = "context-compaction-run";
const originalFetch = globalThis.fetch;

try {
  const history: ChatMessage[] = [];
  for (let index = 0; index < 8; index++) {
    history.push({ role: "user", content: `old-user-${index} ${"u".repeat(1_500)}` });
    history.push({ role: "assistant", content: `old-answer-${index} ${"a".repeat(1_500)}` });
  }
  let summaryCalls = 0;
  const harness = new DefaultContextHarness({
    permissionMode: "workspace-write",
    modelContext: resolveModelContextConfig({
      model: "context-test",
      contextWindowTokens: 6_000,
      maxOutputTokens: 1_000,
      safetyTokens: 500,
    }),
    summarizer: {
      summarize: async () => {
        summaryCalls++;
        return "Goal: preserve the long session\nProgress: earlier turns compacted";
      },
    },
  });
  const requestMessages: ChatMessage[][] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
    requestMessages.push(body.messages);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "done" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const traces: TraceEvent[] = [];
  const result = await runAgent("current-task", undefined, {
    executionContext: createAgentExecutionContext({ runId }),
    ...createDefaultRuntimeServices(),
    observer: silentRuntimeObserver,
    conversationHistory: history,
    contextHarness: harness,
    modelConfig: {
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "context-test",
    },
    onTrace: (event) => traces.push(event),
  });

  assert.equal(result, "done");
  assert.equal(summaryCalls, 1);
  const compaction = traces.find(
    (event): event is Extract<TraceEvent, { type: "context_compaction" }> =>
      event.type === "context_compaction",
  );
  assert.ok(compaction && compaction.summarizedMessages > 0);
  assert.match(requestMessages[0][0].content, /\[Conversation Summary\]/);
  assert.equal(requestMessages[0].at(-1)?.content, "current-task");
  assert.ok(!requestMessages[0].some((message) => message.content.includes("old-user-0")));

  const checkpoint = loadCheckpoint(runId);
  assert.ok(checkpoint?.harnessState?.conversationSummary.includes("earlier turns compacted"));
  assert.equal(
    checkpoint?.harnessState?.summarizedMessageCount,
    compaction.summarizedMessages,
  );
  assert.ok(
    checkpoint?.messages.some((message) => message.content.includes("old-user-0")),
    "canonical checkpoint transcript must retain summarized history",
  );

  assert.ok(checkpoint);
  const resumedHarness = new DefaultContextHarness({
    permissionMode: "workspace-write",
    modelContext: resolveModelContextConfig({
      model: "context-test",
      contextWindowTokens: 6_000,
      maxOutputTokens: 1_000,
      safetyTokens: 500,
    }),
    summarizer: {
      summarize: async () => { throw new Error("resume should retain the existing summary"); },
    },
  });
  const resumed = await runAgent(checkpoint.task, checkpoint, {
    executionContext: createAgentExecutionContext({
      runId,
      workspaceRoot: checkpoint.workspaceRoot,
      permissionMode: checkpoint.permissionMode,
    }),
    ...createDefaultRuntimeServices(),
    observer: silentRuntimeObserver,
    contextHarness: resumedHarness,
    modelConfig: {
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "context-test",
    },
  });
  assert.equal(resumed, "done");
  assert.match(requestMessages[1][0].content, /\[Conversation Summary\]/);
  assert.match(requestMessages[1][0].content, /earlier turns compacted/);
  assert.ok(!requestMessages[1].some((message) => message.content.includes("old-user-0")));
  console.log("Context compaction Agent test: PASS");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(checkpointPath(runId), { force: true });
  fs.rmSync(root, { recursive: true, force: true });
}
