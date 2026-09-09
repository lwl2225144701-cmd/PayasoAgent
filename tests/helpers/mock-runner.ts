// Shared test helper: deterministic Runtime runs driven by a scripted mock LLM.
//
// Every Runtime integration suite needs the same three things: a workspace, an
// AgentExecutionContext with in-memory checkpoints, and a scripted `fetch` that
// returns canned Chat Completions responses. Keeping that here means a suite
// only declares *what the model says*, not how the transport is wired.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentExecutionContext,
  createDefaultRuntimeServices,
} from '../../src/bootstrap/runtime-bootstrap.js';
import type { AgentContextHarness } from '../../src/harness/context-harness.js';
import { runAgent } from '../../src/runtime/agent.js';
import type { TraceEvent } from '../../src/runtime/trace.js';

export const MOCK_MODEL_CONFIG = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'sk-mock-runner',
  model: 'MiniMax-M3',
};

/** One assistant turn carrying plain text. */
export function textResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One assistant turn carrying tool calls (arguments may be a raw JSON string). */
export function toolCallResponse(
  calls: Array<{ id: string; name: string; args: object | string }>,
): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
              },
            })),
          },
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** One assistant turn with neither content nor tool calls (the empty-turn case). */
export function emptyResponse(): Response {
  return textResponse('');
}

export interface ScriptedFetch {
  fetch: typeof fetch;
  calls: number;
}

/**
 * Install a scripted `fetch`. Each entry is consumed in order; when the script
 * is exhausted the last entry repeats (so a run can always terminate).
 * `onRequest` receives each parsed request body, which lets a suite assert on
 * what the model actually saw (messages, tools) without re-parsing streams.
 */
export function scriptedFetch(
  script: Array<() => Response>,
  onRequest?: (body: unknown) => void,
): ScriptedFetch {
  const state: ScriptedFetch = {
    calls: 0,
    fetch: (async () => new Response('', { status: 500 })) as typeof fetch,
  };
  state.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const index = Math.min(state.calls, script.length - 1);
    state.calls++;
    if (onRequest && typeof init?.body === 'string') {
      try {
        onRequest(JSON.parse(init.body));
      } catch {
        /* non-JSON body: nothing to assert on */
      }
    }
    return script[index]();
  }) as typeof fetch;
  return state;
}

/** Isolated workspace root for one suite; also points the sandbox at it. */
export function createTestWorkspaceRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.SANDBOX_ROOT = root;
  return root;
}

export interface MockRunOptions {
  runId: string;
  task: string;
  /** Canned responses, consumed in order. */
  script: Array<() => Response>;
  workspaceRoot: string;
  contextHarness?: AgentContextHarness;
  /** Observes each parsed request body (what the model actually saw). */
  onRequest?: (body: unknown) => void;
}

export interface MockRunResult {
  answer?: string;
  error?: Error;
  traces: TraceEvent[];
  fetchCalls: number;
}

/**
 * Run the Agent against a scripted model. Never throws: failures are returned
 * as `error` so a suite can assert on them.
 */
export async function runMockAgent(options: MockRunOptions): Promise<MockRunResult> {
  const scripted = scriptedFetch(options.script, options.onRequest);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = scripted.fetch;
  const traces: TraceEvent[] = [];
  try {
    const answer = await runAgent(options.task, undefined, {
      executionContext: createAgentExecutionContext({
        runId: options.runId,
        workspaceRoot: options.workspaceRoot,
      }),
      ...createDefaultRuntimeServices(),
      modelConfig: MOCK_MODEL_CONFIG,
      signal: new AbortController().signal,
      onTrace: (event) => traces.push(event),
      ...(options.contextHarness ? { contextHarness: options.contextHarness } : {}),
    });
    return { answer, traces, fetchCalls: scripted.calls };
  } catch (error) {
    return { error: error as Error, traces, fetchCalls: scripted.calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
