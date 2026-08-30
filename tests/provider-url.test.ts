// 模块: Provider URL 校验测试 — 失败必须非零退出

import { canonicalizeProviderBaseUrl, fetchAvailableModelsSafe } from "../src/host/provider-url.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

console.log("Provider URL tests:");

// 1. HTTPS 正常
{
  const url = canonicalizeProviderBaseUrl("https://api.openai.com/v1/");
  check("HTTPS canonical", url === "https://api.openai.com/v1", `got ${url}`);
}

// 2. HTTP loopback 允许（开发模式）
{
  const url = canonicalizeProviderBaseUrl("http://localhost:8080/v1/", { allowLoopbackHttp: true });
  check("HTTP loopback allowed", url === "http://localhost:8080/v1", `got ${url}`);
}

// 3. HTTP 外部拒绝
{
  try {
    canonicalizeProviderBaseUrl("http://api.example.com/v1/");
    check("HTTP external rejected", false, "should have thrown");
  } catch {
    check("HTTP external rejected", true);
  }
}

// 4. URL credentials 拒绝
{
  try {
    canonicalizeProviderBaseUrl("https://user:pass@api.example.com/v1/");
    check("URL credentials rejected", false, "should have thrown");
  } catch {
    check("URL credentials rejected", true);
  }
}

// 5. 空 hostname 拒绝
{
  try {
    canonicalizeProviderBaseUrl("https://:8080/");
    check("empty hostname rejected", false, "should have thrown");
  } catch {
    check("empty hostname rejected", true);
  }
}

// 6. 尾部斜杠去除
{
  const url = canonicalizeProviderBaseUrl("https://api.openai.com/v1/");
  check("trailing slash removed", !url.endsWith("/"), `got ${url}`);
}

// 7. fetchAvailableModelsSafe 不暴露 endpoint
{
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("secret endpoint info", { status: 404 });
    try {
      await fetchAvailableModelsSafe("https://api.example.com/v1/", "sk-test");
      check("upstream error not leaked", false, "should have thrown");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check("upstream error not leaked", !msg.includes("api.example.com"), `got ${msg}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// 8. redirect 真正被拒绝：模拟真实 3xx（302 + Location），fetch redirect:"error" 必须失败
{
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => {
      // 断言 fetch 传了 redirect:"error"（实现应显式拒绝重定向）
      check("fetch redirect mode is error", (init as RequestInit | undefined)?.redirect === "error");
      return new Response("", { status: 302, headers: { Location: "https://evil.com/v1/models" } });
    };
    try {
      await fetchAvailableModelsSafe("https://api.example.com/v1/", "sk-test", { allowRedirect: false });
      check("redirect rejected", false, "should have thrown");
    } catch {
      check("redirect rejected", true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// 9. allowRedirect:false 时内容长度超限被拒
{
  const originalFetch = globalThis.fetch;
  try {
    const bigBody = "x".repeat(5_000_000);
    globalThis.fetch = async () => new Response(bigBody, { status: 200, headers: { "Content-Length": String(bigBody.length) } });
    try {
      await fetchAvailableModelsSafe("https://api.example.com/v1/", "sk-test", { maxBodyBytes: 1000 });
      check("large response aborted", false, "should have thrown");
    } catch {
      check("large response aborted", true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// 10. 流式响应实际字节超限被拒（无 Content-Length）
{
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(500)));
          controller.enqueue(new TextEncoder().encode("y".repeat(500)));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
    try {
      await fetchAvailableModelsSafe("https://api.example.com/v1/", "sk-test", { maxBodyBytes: 1000 });
      check("streamed response aborted", false, "should have thrown");
    } catch {
      check("streamed response aborted", true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(`\nProvider URL tests: ${passed} PASS / ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
