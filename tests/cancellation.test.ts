// Deterministic true-cancellation tests (v1.6): AbortSignal propagation,
// tool-signal identity, no-next-LLM after abort, shell process-group
// termination, and side-effect uncertainty on abort. No real network / LLM.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runAgent } from "../src/runtime/agent.js";
import { createAgentExecutionContext } from "../src/bootstrap/runtime-bootstrap.js";
import { checkpointPath, loadCheckpoint } from "../src/runtime/checkpoint.js";
import { register, execute, type ToolContext } from "../src/tools/tools.js";
import {
  createWorkspace,
  canonicalizeWorkspaceRoot,
} from "../src/sandbox/sandbox-manager.js";
import {
  probeSandboxAvailability,
  terminateProcessTree,
} from "../src/sandbox/macos-sandbox.js";
import { isAbortError } from "../src/util/abort.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-cancellation-"));
process.env.SANDBOX_ROOT = ROOT;
fs.mkdirSync(ROOT, { recursive: true });

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.error(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const originalFetch = globalThis.fetch;

function okResponse(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
function toolCallResponse(id: string, name: string, argsJson: string): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: argsJson } }],
      },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

const MODEL_CONFIG = {
  baseUrl: "https://provider.example/v1",
  apiKey: "sk-cancellation",
  model: "MiniMax-M3",
};

// ---- 测试工具（本套件子进程内注册）----
const probeCtx: { signal?: AbortSignal; runId?: string } = {};
let probeAbortsCaller: (() => void) | null = null;
register({
  name: "abort-probe",
  description: "capture the ToolContext signal identity",
  effect: "read",
  parameters: { type: "object", properties: {} },
  execute: async (_args, ctx: ToolContext) => {
    probeCtx.signal = ctx.signal;
    probeCtx.runId = ctx.runId;
    probeAbortsCaller?.();
    return "probe ok";
  },
});

let nonIdemStarted = false;
register({
  name: "abort-non-idem",
  description: "non-idempotent tool that rejects when the run is aborted mid-execution",
  effect: "non_idempotent",
  getOperationKey: () => "abort-non-idem:v1",
  parameters: { type: "object", properties: {} },
  execute: async (_args, ctx) => {
    nonIdemStarted = true;
    await new Promise<void>((_, reject) => {
      ctx.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
    return "never";
  },
});

function cleanupCheckpoint(runId: string): void {
  fs.rmSync(checkpointPath(runId), { force: true });
}

try {
  // ---- Case 1: LLM request cancellation ----
  {
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = (async (_input, init) => {
      signals.push(init?.signal);
      // 模拟真实 fetch：永不返回，但收到 abort 信号时以 AbortError 拒绝
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;

    const pending = runAgent("c1", undefined, {
      executionContext: createAgentExecutionContext({ runId: "cancel-llm" }),
      modelConfig: MODEL_CONFIG,
      signal: controller.signal,
    });
    await waitFor(() => signals.length > 0);
    check("Case1: fetch received an AbortSignal", signals[0] instanceof AbortSignal);
    controller.abort();
    await assert.rejects(pending, (err: unknown) => isAbortError(err));
    check("Case1: runAgent exits with AbortError (not a generic failure)", true);
    cleanupCheckpoint("cancel-llm");
  }

  // ---- Case 4 + 7: tool signal identity + normal flow unaffected ----
  {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? toolCallResponse("call-probe", "abort-probe", "{}")
        : okResponse("done");
    }) as typeof fetch;

    const answer = await runAgent("c4", undefined, {
      executionContext: createAgentExecutionContext({ runId: "cancel-probe" }),
      modelConfig: MODEL_CONFIG,
      signal: controller.signal,
    });
    check("Case7: normal LLM→tool→LLM→final flow unchanged", answer === "done" && calls === 2, `answer=${answer}, calls=${calls}`);
    check("Case4: tool received the run's exact AbortSignal", probeCtx.signal === controller.signal);
    check("Case4: tool received the runId via ToolContext", probeCtx.runId === "cancel-probe");
    cleanupCheckpoint("cancel-probe");
  }

  // ---- Case 6: abort after tool returns → no next LLM call ----
  {
    const controller = new AbortController();
    probeAbortsCaller = () => controller.abort();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? toolCallResponse("call-probe-6", "abort-probe", "{}")
        : okResponse("done");
    }) as typeof fetch;

    const pending = runAgent("c6", undefined, {
      executionContext: createAgentExecutionContext({ runId: "cancel-after-tool" }),
      modelConfig: MODEL_CONFIG,
      signal: controller.signal,
    });
    await assert.rejects(pending, (err: unknown) => isAbortError(err));
    check("Case6: tool returned after abort → agent did NOT start the next LLM call", calls === 1, `calls=${calls}`);
    probeAbortsCaller = null;
    cleanupCheckpoint("cancel-after-tool");
  }

  // ---- Case 8: non-idempotent abort → operation marked uncertain ----
  {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return toolCallResponse("call-non-idem", "abort-non-idem", "{}");
    }) as typeof fetch;

    const pending = runAgent("c8", undefined, {
      executionContext: createAgentExecutionContext({ runId: "cancel-non-idem" }),
      modelConfig: MODEL_CONFIG,
      signal: controller.signal,
    });
    await waitFor(() => nonIdemStarted);
    controller.abort();
    await assert.rejects(pending, (err: unknown) => isAbortError(err));

    const checkpoint = loadCheckpoint("cancel-non-idem");
    const ops = checkpoint?.sideEffects ?? [];
    check("Case8: aborted non-idempotent op is recorded", ops.length > 0, JSON.stringify(ops));
    check("Case8: op state is uncertain (NOT safe-to-replay succeeded)",
      ops.some((op) => op.state === "uncertain") && !ops.some((op) => op.state === "succeeded"),
      JSON.stringify(ops),
    );
    check("Case8: checkpoint persisted for later inspection", !!checkpoint);
    cleanupCheckpoint("cancel-non-idem");
  }

  // ---- Case 5: shell cancellation ----
  // 5a: 进程组终止机制本身（不依赖 sandbox-exec，POSIX 下确定性成立）
  if (process.platform === "darwin" || process.platform === "linux") {
    const child = spawn("/bin/sleep", ["5"], { detached: true, stdio: "ignore" });
    const start = Date.now();
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      setTimeout(() => terminateProcessTree(child), 150);
    });
    const elapsed = Date.now() - start;
    check("Case5a: sleep 5 exits early via process-group SIGTERM",
      elapsed < 3_000 && (child.signalCode === "SIGTERM" || child.signalCode === "SIGKILL"),
      `elapsed=${elapsed}ms, signal=${child.signalCode}`);
  }

  // 5b: shell 工具集成（依赖本机 sandbox-exec 真正可执行；不可用/被拒时如实 SKIP）
  if (process.platform === "darwin") {
    const sandboxOk = await probeSandboxAvailability();
    if (!sandboxOk) {
      check("Case5b: SKIP — sandbox-exec unavailable in this environment", true);
    } else {
      const runId = "cancel-shell";
      const workspaceRoot = canonicalizeWorkspaceRoot(createWorkspace(runId));
      const shellCtx: ToolContext = { runId, workspaceRoot };
      let shellUsable = true;
      let skipReason = "";
      try {
        await execute("shell", { command: "true" }, shellCtx);
      } catch (err) {
        shellUsable = false;
        skipReason = (err as Error).message;
      }
      if (!shellUsable) {
        check(`Case5b: SKIP — shell denied/unavailable here (${skipReason})`, true);
      } else {
        const controller = new AbortController();
        const start = Date.now();
        const pending = execute("shell", { command: "sleep 5" }, { ...shellCtx, signal: controller.signal });
        await new Promise((resolve) => setTimeout(resolve, 400));
        controller.abort();
        await assert.rejects(pending, (err: unknown) => isAbortError(err));
        const elapsed = Date.now() - start;
        check("Case5b: sleep 5 shell command cancelled early with AbortError", elapsed < 3_000, `elapsed=${elapsed}ms`);
        fs.rmSync(path.join(workspaceRoot, ".payaso-shell-*"), { force: true });
      }
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\nCancellation tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
