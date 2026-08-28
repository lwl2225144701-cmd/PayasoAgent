// Deterministic LLM transport tests: no real network or credentials.

import assert from "node:assert/strict";
import { chat } from "../src/llm/llm.js";

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
  await test("valid assistant response is normalized", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "done", reasoning_content: "private" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const message = await chat([{ role: "user", content: "hello" }]);
    assert.equal(message.content, "done");
    assert.equal(message.reasoning_content, "private");
    assert.ok(typeof requestBodies[0]?.max_tokens === "number" && requestBodies[0].max_tokens > 0);
  });

  await test("streaming content/reasoning and fragmented tool calls are assembled", async () => {
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
    globalThis.fetch = async () => new Response(chunks.join(""), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const deltas: string[] = [];
    const message = await chat(
      [{ role: "user", content: "hello" }],
      undefined,
      (delta) => deltas.push(`${delta.type}:${delta.delta}`),
    );
    assert.equal(message.content, "<think>秘密</think>你好");
    assert.equal(message.reasoning_content, "想");
    assert.equal(message.tool_calls?.[0]?.function.name, "calculator");
    assert.equal(message.tool_calls?.[0]?.function.arguments, '{"expression":"1+1"}');
    assert.deepEqual(deltas, [
      "reasoning_delta:想",
      "reasoning_delta:秘密",
      "assistant_delta:你",
      "assistant_delta:好",
    ]);
  });

  await test("malformed JSON and missing choices are rejected deterministically", async () => {
    globalThis.fetch = async () => new Response("not-json", { status: 200 });
    await assert.rejects(() => chat([{ role: "user", content: "hello" }]), /invalid JSON/);
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
    await assert.rejects(() => chat([{ role: "user", content: "hello" }]), /missing choices/);
  });

  await test("malformed tool_calls are rejected before Runtime execution", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "shell" } }] } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    await assert.rejects(() => chat([{ role: "user", content: "hello" }]), /invalid tool_call function/);
  });

  await test("retryable 5xx is retried and then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response("temporary", { status: 503, headers: { "Retry-After": "0" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    assert.equal((await chat([{ role: "user", content: "hello" }])).content, "recovered");
    assert.equal(calls, 2);
  });

  await test("non-retryable 4xx fails once", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("bad request", { status: 400 });
    };
    await assert.rejects(() => chat([{ role: "user", content: "hello" }]), /LLM API error: 400/);
    assert.equal(calls, 1);
  });

  await test("network errors retry at most two times", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("offline");
    };
    await assert.rejects(() => chat([{ role: "user", content: "hello" }]), /after 3 attempts: offline/);
    assert.equal(calls, 3);
  });

  await test("headers arrived, slow body aborts at total timeout (no retry)", async () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = "60";
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const signal = init?.signal;
      const stream = new ReadableStream({
        start(readController) {
          // Body never completes on its own (simulates a long generation); the
          // abort signal interrupts it at the total request timeout.
          const finish = setTimeout(() => {
            try { readController.close(); } catch { /* already cancelled */ }
          }, 1000);
          signal?.addEventListener("abort", () => {
            clearTimeout(finish);
            try { readController.error(new DOMException("Aborted", "AbortError")); } catch { /* already cancelled */ }
          }, { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      await assert.rejects(() => chat([{ role: "user", content: "hello" }]), /timed out after 60ms/);
      assert.equal(calls, 1); // total timeout must NOT be retried
    } finally {
      delete process.env.LLM_REQUEST_TIMEOUT_MS;
    }
  });

  await test("total timeout before any response does not retry", async () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = "50";
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    };
    try {
      await assert.rejects(() => chat([{ role: "user", content: "hello" }]), /timed out after 50ms/);
      assert.equal(calls, 1); // total timeout must NOT be retried
    } finally {
      delete process.env.LLM_REQUEST_TIMEOUT_MS;
    }
  });

  await test("incomplete modelConfig is rejected without falling back to env config", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error("must not be called");
    };
    // 空 apiKey 绝不能静默换成宿主环境密钥（跨 Provider 泄露防线）
    await assert.rejects(
      () => chat(
        [{ role: "user", content: "hello" }],
        undefined,
        undefined,
        { baseUrl: "https://api.deepseek.com", apiKey: "", model: "deepseek-chat" },
      ),
      /modelConfig is incomplete/,
    );
    await assert.rejects(
      () => chat(
        [{ role: "user", content: "hello" }],
        undefined,
        undefined,
        { baseUrl: "https://api.deepseek.com", apiKey: "sk-x", model: "" },
      ),
      /modelConfig is incomplete/,
    );
    assert.equal(fetchCalls, 0);
  });

  await test("complete modelConfig is used atomically (no env config mixing)", async () => {
    const requests: Array<{ url: string; authorization: string | null; model: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        url: String(input),
        authorization: headers.Authorization ?? null,
        model: (JSON.parse(String(init?.body)) as { model: unknown }).model,
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    };
    const message = await chat(
      [{ role: "user", content: "hello" }],
      undefined,
      undefined,
      {
        providerId: "p1",
        baseUrl: "https://provider.example/v1",
        apiKey: "sk-provider-key",
        model: "model-from-provider",
      },
    );
    assert.equal(message.content, "ok");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://provider.example/v1/chat/completions");
    assert.equal(requests[0].authorization, "Bearer sk-provider-key");
    assert.equal(requests[0].model, "model-from-provider");
  });
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\nLLM transport tests: ${passed} passed / ${failed} failed`);
if (failed) process.exitCode = 1;
