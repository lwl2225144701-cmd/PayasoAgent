// Deterministic LLM transport tests: no real network or credentials.

import assert from 'node:assert/strict';
import { deriveMaxOutputTokens } from '../src/harness/model-context.js';
import { chat } from '../src/llm/llm.js';

const originalFetch = globalThis.fetch;
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

try {
  await test('valid assistant response is normalized', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'done', reasoning_content: 'private' } }],
          usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const message = await chat([{ role: 'user', content: 'hello' }]);
    assert.equal(message.content, 'done');
    assert.equal(message.reasoning_content, 'private');
    assert.equal(message.usage?.totalTokens, 150);
    // DISJOINT 分桶透传：input 为未缓存输入，cache 命中单独计桶（此处为 0 → 省略）。
    assert.equal(message.usage?.inputTokens, 120);
    assert.equal(message.usage?.outputTokens, 30);
    assert.equal(message.usage?.cacheReadTokens, undefined);
    assert.ok(typeof requestBodies[0]?.max_tokens === 'number' && requestBodies[0].max_tokens > 0);
  });

  await test('usage buckets with cache and reasoning are passed through disjointly', async () => {
    let requestUrl = '';
    globalThis.fetch = async (input) => {
      requestUrl = String(input);
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
          'data: {"usage":{"prompt_tokens":500,"completion_tokens":120,' +
          '"prompt_tokens_details":{"cached_tokens":200},' +
          '"completion_tokens_details":{"reasoning_tokens":50}},"choices":[]}\n\n' +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    const message = await chat([{ role: 'user', content: 'hello' }]);
    // pi-ai 归一化：input = 500 - 200 = 300（未缓存），cacheRead = 200，reasoning = 50。
    assert.equal(message.usage?.inputTokens, 300);
    assert.equal(message.usage?.outputTokens, 120);
    assert.equal(message.usage?.cacheReadTokens, 200);
    assert.equal(message.usage?.reasoningTokens, 50);
    // total = input + output + cacheRead + cacheWrite = 300 + 120 + 200 = 620。
    assert.equal(message.usage?.totalTokens, 620);
    assert.ok(requestUrl.endsWith('/chat/completions'));
  });

  await test('malformed usage never fails the call (宁缺勿错)', async () => {
    globalThis.fetch = async () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
          'data: {"usage":{"prompt_tokens":120,"completion_tokens":-5},"choices":[]}\n\n' +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    const message = await chat([{ role: 'user', content: 'hello' }]);
    assert.equal(message.content, 'ok');
    assert.equal(message.usage, undefined);
  });

  await test('streaming content/reasoning and fragmented tool calls are assembled', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"nk>秘密</th"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ink>你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"cal","arguments":"{\\"exp"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"culator","arguments":"ression\\":\\"1+1\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = async () =>
      new Response(chunks.join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    const deltas: string[] = [];
    const message = await chat([{ role: 'user', content: 'hello' }], undefined, (delta) =>
      deltas.push(`${delta.type}:${delta.delta}`),
    );
    assert.equal(message.content, '<think>秘密</think>你好');
    assert.equal(message.reasoning_content, '想');
    assert.equal(message.tool_calls?.[0]?.function.name, 'calculator');
    assert.equal(message.tool_calls?.[0]?.function.arguments, '{"expression":"1+1"}');
    assert.deepEqual(deltas, [
      'reasoning_delta:想',
      'reasoning_delta:秘密',
      'assistant_delta:你',
      'assistant_delta:好',
    ]);
  });

  await test('streaming frames without blank-line separators remain parseable', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"第一段"}}]}\n',
      'data: {"choices":[{"delta":{"content":"第二段"}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
      'data: [DONE]\n',
    ];
    globalThis.fetch = async () =>
      new Response(chunks.join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    const message = await chat([{ role: 'user', content: 'hello' }]);
    assert.equal(message.content, '第一段第二段');
  });

  await test('malformed JSON and missing choices are rejected deterministically', async () => {
    globalThis.fetch = async () => new Response('not-json', { status: 200 });
    await assert.rejects(() => chat([{ role: 'user', content: 'hello' }]), /invalid JSON/);
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
    await assert.rejects(() => chat([{ role: 'user', content: 'hello' }]), /missing choices/);
  });

  await test('malformed tool_calls are rejected before Runtime execution', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'x', type: 'function', function: { name: 'shell' } }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hello' }]),
      /invalid tool_call function/,
    );
  });

  await test('retryable 5xx is retried and then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1)
        return new Response('temporary', { status: 503, headers: { 'Retry-After': '0' } });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    assert.equal((await chat([{ role: 'user', content: 'hello' }])).content, 'recovered');
    assert.equal(calls, 2);
  });

  await test('non-retryable 4xx fails once', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('bad request', { status: 400 });
    };
    await assert.rejects(() => chat([{ role: 'user', content: 'hello' }]), /LLM API error: 400/);
    assert.equal(calls, 1);
  });

  await test('network errors retry at most two times', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error('offline');
    };
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hello' }]),
      /after 3 attempts: offline/,
    );
    assert.equal(calls, 3);
  });

  await test('headers arrived, slow body aborts at total timeout (no retry)', async () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = '60';
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const signal = init?.signal;
      const stream = new ReadableStream({
        start(readController) {
          // Body never completes on its own (simulates a long generation); the
          // abort signal interrupts it at the total request timeout.
          const finish = setTimeout(() => {
            try {
              readController.close();
            } catch {
              /* already cancelled */
            }
          }, 1000);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(finish);
              try {
                readController.error(new DOMException('Aborted', 'AbortError'));
              } catch {
                /* already cancelled */
              }
            },
            { once: true },
          );
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      await assert.rejects(
        () => chat([{ role: 'user', content: 'hello' }]),
        /timed out after 60ms/,
      );
      assert.equal(calls, 1); // total timeout must NOT be retried
    } finally {
      delete process.env.LLM_REQUEST_TIMEOUT_MS;
    }
  });

  await test('total timeout before any response does not retry', async () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = '50';
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    };
    try {
      await assert.rejects(
        () => chat([{ role: 'user', content: 'hello' }]),
        /timed out after 50ms/,
      );
      assert.equal(calls, 1); // total timeout must NOT be retried
    } finally {
      delete process.env.LLM_REQUEST_TIMEOUT_MS;
    }
  });

  await test('incomplete modelConfig is rejected without falling back to env config', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error('must not be called');
    };
    // 空 apiKey 绝不能静默换成宿主环境密钥（跨 Provider 泄露防线）
    await assert.rejects(
      () =>
        chat([{ role: 'user', content: 'hello' }], undefined, undefined, {
          baseUrl: 'https://api.deepseek.com',
          apiKey: '',
          model: 'deepseek-chat',
        }),
      /modelConfig is incomplete/,
    );
    await assert.rejects(
      () =>
        chat([{ role: 'user', content: 'hello' }], undefined, undefined, {
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-x',
          model: '',
        }),
      /modelConfig is incomplete/,
    );
    assert.equal(fetchCalls, 0);
  });

  await test('complete modelConfig is used atomically (no env config mixing)', async () => {
    const requests: Array<{ url: string; authorization: string | null; model: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        url: String(input),
        authorization: headers.Authorization ?? null,
        model: (JSON.parse(String(init?.body)) as { model: unknown }).model,
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      });
    };
    const message = await chat([{ role: 'user', content: 'hello' }], undefined, undefined, {
      providerId: 'p1',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'sk-provider-key',
      model: 'model-from-provider',
    });
    assert.equal(message.content, 'ok');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://provider.example/v1/chat/completions');
    assert.equal(requests[0].authorization, 'Bearer sk-provider-key');
    assert.equal(requests[0].model, 'model-from-provider');
  });

  await test('OpenCode Go receives the host session routing header', async () => {
    let sessionHeader: string | null = null;
    globalThis.fetch = async (_input, init) => {
      sessionHeader = new Headers(init?.headers).get('x-opencode-session');
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    await chat([{ role: 'user', content: 'hello' }], undefined, undefined, {
      providerId: 'opencode-go-test',
      piProviderId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'sk-opencode-test',
      model: 'deepseek-v4-flash',
      sessionId: 'payaso-session-123',
    });
    assert.equal(sessionHeader, 'payaso-session-123');
  });

  await test('custom Provider keeps the configured StepFun endpoint', async () => {
    let requestUrl = '';
    globalThis.fetch = async (input) => {
      requestUrl = String(input);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await chat([{ role: 'user', content: 'hello' }], undefined, undefined, {
      baseUrl: 'https://api.stepfun.com/step_plan/v1',
      apiKey: 'sk-test',
      model: 'step-3.7-flash',
    });
    assert.equal(requestUrl, 'https://api.stepfun.com/step_plan/v1/chat/completions');
  });
  await test('max_tokens follows the requested run model, not the env model (Case 2/3)', async () => {
    const originalModel = process.env.OPENAI_MODEL;
    process.env.OPENAI_MODEL = 'gpt-4o-mini'; // 环境模型 ≠ Run 模型
    const bodies: Array<{ model: unknown; max_tokens: unknown }> = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { model: unknown; max_tokens: unknown });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      });
    };
    try {
      // 显式 modelConfig：能力必须来自该模型（MiniMax-M3 注册表：16384）
      await chat([{ role: 'user', content: 'hello' }], undefined, undefined, {
        baseUrl: 'https://provider.example/v1',
        apiKey: 'sk-run',
        model: 'MiniMax-M3',
      });
      // 无 modelConfig：环境 fallback 路径保持原语义（CLI 兼容）
      await chat([{ role: 'user', content: 'hello' }]);
    } finally {
      if (originalModel === undefined) delete process.env.OPENAI_MODEL;
      else process.env.OPENAI_MODEL = originalModel;
    }
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].model, 'MiniMax-M3');
    assert.equal(bodies[0].max_tokens, 16_384);
    assert.equal(bodies[1].model, 'gpt-4o-mini');
    // v1.8：未登记模型不再固定 4K 输出，按窗口推导（256K fallback → 20971）
    assert.equal(bodies[1].max_tokens, deriveMaxOutputTokens(262_144));
  });
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\nLLM transport tests: ${passed} passed / ${failed} failed`);
if (failed) process.exitCode = 1;
