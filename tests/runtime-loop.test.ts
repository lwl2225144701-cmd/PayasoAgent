// Deterministic Runtime loop policy tests (no real network / LLM).
// Locks the boundary between an unbounded Runtime loop and Host/Harness
// termination policies: more than ten tool turns may complete, while a
// Harness policy can still request a graceful stop.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentExecutionContext } from '../src/bootstrap/runtime-bootstrap.js';
import { type AgentContextHarness, DefaultContextHarness } from '../src/harness/context-harness.js';
import type { ChatMessage } from '../src/llm/llm.js';
import { AgentStopRequestedError, runAgent } from '../src/runtime/agent.js';
import { silentRuntimeObserver } from '../src/runtime/observer-port.js';
import { register, type ToolContext } from '../src/tools/tools.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-runtime-loop-'));
process.env.SANDBOX_ROOT = ROOT;

const MODEL_CONFIG = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'sk-runtime-loop',
  model: 'gpt-4o-mini',
};

function response(message: ChatMessage): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const toolName = 'runtime-loop-probe';
register({
  name: toolName,
  description: 'deterministic successful tool for Runtime loop tests',
  effect: 'read',
  parameters: { type: 'object', properties: {} },
  execute: async (_args: Record<string, unknown>, _context: ToolContext) => 'ok',
});

function toolCall(iteration: number): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: `loop-call-${iteration}`,
        type: 'function',
        function: { name: toolName, arguments: '{}' },
      },
    ],
  };
}

function runOptions(
  runId: string,
  root: string,
  saves: Array<{ status: string; iteration: number }>,
  events: string[] = [],
  contextHarness?: AgentContextHarness,
) {
  return {
    executionContext: createAgentExecutionContext({ runId, workspaceRoot: root }),
    checkpointWriter: {
      save: (snapshot: { status: string; iteration: number }) => {
        saves.push({ status: snapshot.status, iteration: snapshot.iteration });
        return `memory://${runId}/${saves.length}`;
      },
    },
    observer: {
      ...silentRuntimeObserver,
      traceEvent: (event: { type: string }) => events.push(event.type),
    },
    modelConfig: MODEL_CONFIG,
    contextHarness,
  };
}

const originalFetch = globalThis.fetch;
try {
  // Runtime must not fail merely because a model needs more than the former
  // MAX_ITERATIONS=10 turns. Eleven tool turns plus a final answer complete.
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls <= 11
        ? response(toolCall(calls))
        : response({ role: 'assistant', content: 'done' });
    }) as typeof fetch;
    const saves: Array<{ status: string; iteration: number }> = [];
    const root = path.join(ROOT, 'long-loop');
    fs.mkdirSync(root);
    const answer = await runAgent(
      'run a long deterministic loop',
      undefined,
      runOptions('loop', root, saves),
    );
    assert.equal(answer, 'done');
    assert.equal(calls, 12);
    assert.equal(saves.at(-1)?.status, 'completed');
    assert.equal(saves.at(-1)?.iteration, 12);
  }

  // Harness policy stops after the current completed tool turn. Runtime keeps
  // the checkpoint resumable and does not emit a generic error trace.
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return response(toolCall(calls));
    }) as typeof fetch;
    const saves: Array<{ status: string; iteration: number }> = [];
    const events: string[] = [];
    const root = path.join(ROOT, 'policy-stop');
    fs.mkdirSync(root);
    const harness = new DefaultContextHarness({
      permissionMode: 'workspace-write',
      modelConfig: MODEL_CONFIG,
    });
    (harness as AgentContextHarness).shouldStopAfterTurn = ({ iteration }) => iteration >= 1;
    const options = runOptions('policy-stop', root, saves, events, harness);
    await assert.rejects(
      runAgent('stop after one tool turn', undefined, options),
      (error: unknown) => error instanceof AgentStopRequestedError,
    );
    assert.equal(calls, 1);
    assert.equal(saves.at(-1)?.status, 'running');
    assert.equal(saves.at(-1)?.iteration, 1);
    assert.equal(events.includes('error'), false);
  }
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log('Runtime loop policy tests: PASS');
