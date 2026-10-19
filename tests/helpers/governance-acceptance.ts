// 治理验收夹具：真实 Runtime / Harness，模拟模型传输，所有文件只落临时目录。
// 流式场景真实分批推送 SSE 并监听取消，避免用一次延迟冒充持续输出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentExecutionContext } from '../../src/bootstrap/runtime-bootstrap.js';
import { DefaultContextHarness } from '../../src/harness/context-harness.js';
import type { ChatMessage, ModelConfig } from '../../src/llm/llm.js';
import { runAgent } from '../../src/runtime/agent.js';
import type { CheckpointSnapshot } from '../../src/runtime/checkpoint-port.js';
import { silentRuntimeObserver } from '../../src/runtime/observer-port.js';
import type { TraceEvent } from '../../src/runtime/trace.js';
import { register } from '../../src/tools/tools.js';

export const MODEL: ModelConfig = {
  baseUrl: 'https://governance-acceptance.invalid/v1',
  apiKey: 'acceptance-only',
  model: 'acceptance-model',
  maxOutputTokens: 4096,
};
export const PROBE = 'governance-acceptance-probe';
export const WRITE_PROBE = 'governance-acceptance-write';
export type HarnessOptions = ConstructorParameters<typeof DefaultContextHarness>[0];
export type RequestBody = { messages: ChatMessage[]; max_tokens?: number; tools?: unknown[] };
export interface Step {
  message?: ChatMessage;
  outputTokens?: number;
  status?: number;
  live?: boolean;
  json?: boolean;
  onFetch?: () => void;
}
export interface Transport {
  bodies: RequestBody[];
  chunks: number;
  abortedStreams: number;
}
export interface Outcome {
  answer?: string;
  error?: unknown;
  elapsedMs: number;
}

let nextCallId = 0;
export function call(label: string, args: Record<string, unknown> = {}, tool = PROBE) {
  return {
    id: 'acceptance-call-' + ++nextCallId,
    type: 'function' as const,
    function: { name: tool, arguments: JSON.stringify({ label, ...args }) },
  };
}
export function tools(...calls: ReturnType<typeof call>[]): ChatMessage {
  return { role: 'assistant', content: '', tool_calls: calls };
}
export const done = (): ChatMessage => ({ role: 'assistant', content: '已完成验收夹具任务。' });
export const turn = (message: ChatMessage, outputTokens = 5): Step => ({ message, outputTokens });

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export class GovernanceFixture {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-governance-acceptance-'));
  readonly starts = new Map<string, string[]>();
  readonly completions = new Map<string, string[]>();
  private readonly originalFetch = globalThis.fetch;
  private readonly env = { ...process.env };
  private readonly activeStreams = new Set<() => void>();

  constructor() {
    process.env.PAYASO_HOME = path.join(this.root, 'home');
    process.env.PAYASO_CHECKPOINT_DIR = path.join(this.root, 'checkpoints');
    process.env.SANDBOX_ROOT = path.join(this.root, 'sandbox');
    this.resetEnvironment();
    const parameters = {
      type: 'object' as const,
      required: ['label'],
      properties: {
        label: { type: 'string' },
        durationMs: { type: 'number' },
        fail: { type: 'string' },
      },
    };
    for (const [name, effect] of [
      [PROBE, 'read'],
      [WRITE_PROBE, 'non_idempotent'],
    ] as const) {
      register({
        name,
        description: '隔离的治理验收探针',
        effect,
        parameters,
        getOperationKey: (args) => 'acceptance-operation:' + String(args.label),
        execute: async (args, ctx) => {
          const id = ctx.runId ?? 'unknown';
          this.starts.set(id, [...(this.starts.get(id) ?? []), String(args.label)]);
          if (name === WRITE_PROBE) {
            fs.appendFileSync(
              path.join(ctx.workspaceRoot!, 'probe-writes.txt'),
              String(args.label) + '\n',
            );
          }
          if (args.durationMs) await abortableDelay(Number(args.durationMs), ctx.signal);
          if (args.fail) {
            const error = new Error('验收探针失败');
            if (args.fail === 'transient') Object.assign(error, { code: 'ECONNRESET' });
            if (args.fail === 'permanent') Object.assign(error, { code: 'ENOENT' });
            throw error;
          }
          this.completions.set(id, [...(this.completions.get(id) ?? []), String(args.label)]);
          return 'probe-result:' + String(args.label);
        },
      });
    }
  }

  resetEnvironment() {
    for (const key of Object.keys(process.env)) {
      if (
        /^PAYASO_(?:EXECUTION_BUDGET|MAX_MODEL_CALLS|MAX_OUTPUT_TOKENS|MAX_ACTIVE_MS|BUDGET_|WRAPUP_|GOAL_REVIEW|REPEAT_CALL_REMINDER|FINAL_REVIEW)/.test(
          key,
        )
      ) {
        delete process.env[key];
      }
    }
  }

  script(steps: Step[]): Transport {
    const transport: Transport = { bodies: [], chunks: 0, abortedStreams: 0 };
    globalThis.fetch = (async (_url, init) => {
      const index = transport.bodies.length;
      transport.bodies.push(JSON.parse(String(init?.body)) as RequestBody);
      const step = steps[index];
      if (!step) throw new Error('模型调用超出验收脚本，序号=' + (index + 1));
      step.onFetch?.();
      if (step.status) return new Response('injected upstream failure', { status: step.status });
      if (step.live) return this.liveResponse(init?.signal ?? undefined, transport);
      const message = step.message ?? done();
      const usage = {
        prompt_tokens: 10,
        completion_tokens: step.outputTokens ?? 5,
        total_tokens: 10 + (step.outputTokens ?? 5),
      };
      if (step.json) {
        return new Response(JSON.stringify({ choices: [{ message }], usage }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const delta = {
        ...message,
        tool_calls: message.tool_calls?.map((item, index) => ({ ...item, index })),
      };
      const chunks = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop',
            },
          ],
          usage,
        },
      ];
      return new Response(
        chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') +
          'data: [DONE]\n\n',
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      );
    }) as typeof fetch;
    return transport;
  }

  private liveResponse(signal: AbortSignal | undefined, transport: Transport): Response {
    const encoder = new TextEncoder();
    let finish = () => {};
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          signal?.removeEventListener('abort', abort);
          this.activeStreams.delete(close);
          controller.close();
        };
        const abort = () => {
          if (closed) return;
          transport.abortedStreams += 1;
          close();
        };
        const push = () => {
          if (closed) return;
          transport.chunks += 1;
          controller.enqueue(
            encoder.encode(
              'data: ' +
                JSON.stringify({
                  choices: [
                    {
                      index: 0,
                      delta: { role: 'assistant', content: '持续输出。' },
                      finish_reason: null,
                    },
                  ],
                }) +
                '\n\n',
            ),
          );
        };
        const timer = setInterval(push, 40);
        finish = close;
        this.activeStreams.add(close);
        if (signal?.aborted) abort();
        else {
          signal?.addEventListener('abort', abort, { once: true });
          push();
        }
      },
      cancel: () => finish(),
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  run(
    id: string,
    overrides: Partial<HarnessOptions> = {},
    extra: {
      signal?: AbortSignal;
      previousHarnessState?: Parameters<typeof runAgent>[2]['previousHarnessState'];
      conversationHistory?: ChatMessage[];
    } = {},
  ) {
    const workspace = path.join(this.root, id);
    fs.mkdirSync(workspace, { recursive: true });
    const harness = new DefaultContextHarness({
      permissionMode: 'workspace-write',
      modelConfig: MODEL,
      ...overrides,
    });
    const snapshots: CheckpointSnapshot[] = [];
    const events: TraceEvent[] = [];
    const options: Parameters<typeof runAgent>[2] = {
      executionContext: createAgentExecutionContext({ runId: id, workspaceRoot: workspace }),
      modelConfig: MODEL,
      contextHarness: harness,
      checkpointWriter: {
        save: (snapshot) => {
          snapshots.push(structuredClone(snapshot));
          return 'memory';
        },
      },
      observer: silentRuntimeObserver,
      onTrace: (event) => events.push(structuredClone(event)),
      ...extra,
    };
    return {
      id,
      workspace,
      harness,
      snapshots,
      events,
      execute: async (checkpoint?: CheckpointSnapshot): Promise<Outcome> => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new DOMException('验收场景超时', 'AbortError')),
          8_000,
        );
        const begin = performance.now();
        try {
          const answer = await runAgent(
            '完成隔离的治理验收任务',
            checkpoint && structuredClone(checkpoint),
            {
              ...options,
              signal: extra.signal
                ? AbortSignal.any([extra.signal, controller.signal])
                : controller.signal,
            },
          );
          return { answer, elapsedMs: performance.now() - begin };
        } catch (error) {
          return { error, elapsedMs: performance.now() - begin };
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  closeStreams() {
    for (const close of [...this.activeStreams]) close();
  }
  dispose() {
    this.closeStreams();
    globalThis.fetch = this.originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in this.env)) delete process.env[key];
    Object.assign(process.env, this.env);
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
