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
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "done", reasoning_content: "private" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    const message = await chat([{ role: "user", content: "hello" }]);
    assert.equal(message.content, "done");
    assert.equal(message.reasoning_content, "private");
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
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\nLLM transport tests: ${passed} passed / ${failed} failed`);
if (failed) process.exitCode = 1;
