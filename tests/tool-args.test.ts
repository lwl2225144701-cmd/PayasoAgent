// Deterministic recoverable-malformed-tool-arguments tests (v1.6):
// 模型生成 malformed/invalid tool arguments → 可恢复 invocation error
// （工具不执行、无 side-effect、结构化错误回传模型修正），而非 fatal run failure。
// 覆盖 stream / non-stream 两条路径与 side-effect / abort / checkpoint 语义。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentExecutionContext,
  createDefaultRuntimeServices,
} from '../src/bootstrap/runtime-bootstrap.js';
import { checkpointPath, loadCheckpoint } from '../src/persistence/file-checkpoint-store.js';
import { runAgent } from '../src/runtime/agent.js';
import { canonicalizeWorkspaceRoot, createWorkspace } from '../src/sandbox/sandbox-manager.js';
import { parseToolArguments, register, type ToolContext } from '../src/tools/tools.js';
import { isAbortError } from '../src/util/abort.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-tool-args-'));
process.env.SANDBOX_ROOT = ROOT;
fs.mkdirSync(ROOT, { recursive: true });

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ---- 解析器单元（统一入口：stream / non-stream 共享）----
check(
  'parse: empty string → INVALID_ARGUMENT_JSON',
  (() => {
    const r = parseToolArguments('');
    return !r.ok && r.error.code === 'INVALID_ARGUMENT_JSON';
  })(),
);
check(
  'parse: whitespace-only → INVALID_ARGUMENT_JSON',
  (() => {
    const r = parseToolArguments('   ');
    return !r.ok && r.error.code === 'INVALID_ARGUMENT_JSON';
  })(),
);
check(
  'parse: truncated JSON → INVALID_ARGUMENT_JSON with stable message',
  (() => {
    const r = parseToolArguments('{"path":');
    return (
      !r.ok &&
      r.error.code === 'INVALID_ARGUMENT_JSON' &&
      r.error.message ===
        'Tool arguments are not valid JSON. Retry this tool call with arguments as one valid JSON object.'
    );
  })(),
);
for (const bad of ['null', '[]', '"hello"', '123']) {
  check(
    `parse: valid JSON but not object (${bad}) → INVALID_ARGUMENTS`,
    (() => {
      const r = parseToolArguments(bad);
      return !r.ok && r.error.code === 'INVALID_ARGUMENTS';
    })(),
  );
}
check(
  'parse: valid object → ok',
  (() => {
    const r = parseToolArguments('{"path":"a.txt"}');
    return r.ok && r.args.path === 'a.txt';
  })(),
);

// ---- 测试工具 ----
const probeState: { executeCount: number; lastArgs: unknown } = { executeCount: 0, lastArgs: null };
register({
  name: 'args-probe',
  description: 'record execution count and last args',
  effect: 'read',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  execute: async (args) => {
    probeState.executeCount++;
    probeState.lastArgs = args;
    return `probe-content(${String((args as { path?: string }).path ?? '')})`;
  },
});

const nonIdem: { executeCount: number } = { executeCount: 0 };
register({
  name: 'args-non-idem',
  description: 'non-idempotent probe for side-effect isolation',
  effect: 'non_idempotent',
  getOperationKey: () => 'args-non-idem:v1',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    nonIdem.executeCount++;
    return 'executed';
  },
});

const originalFetch = globalThis.fetch;
const MODEL_CONFIG = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'sk-tool-args',
  model: 'MiniMax-M3',
};

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
  });
}
function toolCallResponse(id: string, name: string, rawArguments: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id, type: 'function', function: { name, arguments: rawArguments } }],
          },
        },
      ],
    }),
    { status: 200 },
  );
}
// 流式 tool_call：分片 deltas 拼出 rawArguments（验证 partial delta 不被提前 parse）
function streamToolCallResponse(id: string, name: string, rawArguments: string): Response {
  // 分片 deltas：partial delta 不会被提前 parse，只有最终拼接结果进入统一管线
  const mid = Math.ceil(rawArguments.length / 2);
  const parts = [rawArguments.slice(0, mid), rawArguments.slice(mid)];
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"' +
      id +
      '","function":{"name":"' +
      name +
      '","arguments":""}}]}}]}\n\n',
    ...parts.map(
      (p) =>
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":' +
        JSON.stringify(p) +
        '}}]}}]}\n\n',
    ),
    'data: [DONE]\n\n',
  ];
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
function streamOkResponse(content: string): Response {
  return new Response(
    'data: {"choices":[{"delta":{"content":' +
      JSON.stringify(content) +
      '}}]}\n\n' +
      'data: [DONE]\n\n',
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function cleanupCheckpoint(runId: string): void {
  fs.rmSync(checkpointPath(runId), { force: true });
}

try {
  const workspaceRoot = canonicalizeWorkspaceRoot(createWorkspace('tool-args-ws'));

  // ---- Case 1 + 2 + 3: malformed → 可恢复 tool error → 模型修正 → 执行恰好一次 → completed ----
  {
    const controller = new AbortController();
    let calls = 0;
    probeState.executeCount = 0;
    const traces: Array<{ type: string; code?: string; tool?: string }> = [];
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return toolCallResponse('call-1', 'args-probe', '{"path":'); // malformed
      if (calls === 2) return toolCallResponse('call-2', 'args-probe', '{"path":"test.txt"}'); // 修正
      return okResponse('finished');
    }) as typeof fetch;

    const answer = await runAgent('修我', undefined, {
      executionContext: createAgentExecutionContext({ runId: 'tool-args-recover', workspaceRoot }),
      ...createDefaultRuntimeServices(),
      modelConfig: MODEL_CONFIG,
      signal: controller.signal,
      onTrace: (ev) => traces.push(ev as { type: string; code?: string; tool?: string }),
    });

    check('Case1: run completed (not failed) after malformed arguments', answer === 'finished');
    check(
      'Case2: tool never executed with malformed arguments',
      probeState.executeCount === 1,
      `executeCount=${probeState.executeCount}`,
    );
    check(
      'Case3: LLM corrected args and tool executed exactly once with valid args',
      probeState.lastArgs !== null &&
        (probeState.lastArgs as { path?: string }).path === 'test.txt',
      JSON.stringify(probeState.lastArgs),
    );
    const invalid = traces.find((t) => t.type === 'tool_call_invalid');
    check(
      'Case1: tool_call_invalid trace emitted with INVALID_ARGUMENT_JSON',
      !!invalid && invalid.code === 'INVALID_ARGUMENT_JSON' && invalid.tool === 'args-probe',
    );

    // Case 10: checkpoint 一致性 —— assistant(malformed tool_call) 与 tool(error result)
    // 成对序列化，resume 后模型能看到完整上下文并自行修正
    const recoveredCp = loadCheckpoint('tool-args-recover');
    check(
      'Case10: completed checkpoint contains paired error tool result',
      !!recoveredCp &&
        recoveredCp.messages.some(
          (m) =>
            m.role === 'tool' &&
            m.tool_call_id === 'call-1' &&
            m.content.includes('INVALID_ARGUMENT_JSON'),
        ) &&
        recoveredCp.messages.some(
          (m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === 'call-1'),
        ),
    );
    cleanupCheckpoint('tool-args-recover');
  }

  // ---- Case 4: 合法 JSON 但不是 object（null/[]/string/number）统一 INVALID_ARGUMENTS ----
  for (const [idx, raw] of ['null', '[]', '"hello"', '123'].entries()) {
    const controller = new AbortController();
    let calls = 0;
    probeState.executeCount = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? toolCallResponse(`call-no-${idx}`, 'args-probe', raw)
        : okResponse('done');
    }) as typeof fetch;
    const traces: Array<{ type: string; code?: string }> = [];
    const answer = await runAgent(`c4-${idx}`, undefined, {
      executionContext: createAgentExecutionContext({
        runId: `tool-args-obj-${idx}`,
        workspaceRoot,
      }),
      ...createDefaultRuntimeServices(),
      modelConfig: MODEL_CONFIG,
      signal: controller.signal,
      onTrace: (ev) => traces.push(ev as { type: string; code?: string }),
    });
    const invalid = traces.find((t) => t.type === 'tool_call_invalid');
    check(
      `Case4: ${raw} → INVALID_ARGUMENTS, tool not executed, run completed`,
      answer === 'done' && probeState.executeCount === 0 && invalid?.code === 'INVALID_ARGUMENTS',
    );
    cleanupCheckpoint(`tool-args-obj-${idx}`);
  }

  // ---- Case 5: unknown tool → TOOL_NOT_FOUND，run 不 crash ----
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? toolCallResponse('call-unk', 'deleteUniverse', '{}')
        : okResponse('cannot do that');
    }) as typeof fetch;
    const traces: Array<{ type: string; code?: string }> = [];
    const answer = await runAgent('c5', undefined, {
      executionContext: createAgentExecutionContext({ runId: 'tool-args-unknown', workspaceRoot }),
      ...createDefaultRuntimeServices(),
      modelConfig: MODEL_CONFIG,
      onTrace: (ev) => traces.push(ev as { type: string; code?: string }),
    });
    const invalid = traces.find((t) => t.type === 'tool_call_invalid');
    check(
      'Case5: unknown tool → TOOL_NOT_FOUND error to LLM, run completes',
      answer === 'cannot do that' && invalid?.code === 'TOOL_NOT_FOUND',
    );
    cleanupCheckpoint('tool-args-unknown');
  }

  // ---- Case 6 + 7: streaming malformed → 同一恢复路径；streaming 修正后正常 ----
  {
    const controller = new AbortController();
    let calls = 0;
    probeState.executeCount = 0;
    const traces: Array<{ type: string; code?: string }> = [];
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return streamToolCallResponse('call-s1', 'args-probe', '{"path":'); // streaming malformed
      if (calls === 2)
        return streamToolCallResponse('call-s2', 'args-probe', '{"path":"stream.txt"}'); // streaming 修正
      return streamOkResponse('stream-finished');
    }) as typeof fetch;

    const answer = await runAgent('c6', undefined, {
      executionContext: createAgentExecutionContext({ runId: 'tool-args-stream', workspaceRoot }),
      ...createDefaultRuntimeServices(),
      modelConfig: MODEL_CONFIG,
      signal: controller.signal,
      onTrace: (ev) => traces.push(ev as { type: string; code?: string }),
    });
    const invalid = traces.find((t) => t.type === 'tool_call_invalid');
    check(
      'Case6: streaming malformed args → same recoverable path (tool_call_invalid)',
      invalid?.code === 'INVALID_ARGUMENT_JSON',
    );
    check(
      'Case7: streaming correction executes tool exactly once, run completes',
      answer === 'stream-finished' &&
        probeState.executeCount === 1 &&
        (probeState.lastArgs as { path?: string }).path === 'stream.txt',
    );
    cleanupCheckpoint('tool-args-stream');
  }

  // ---- Case 8: malformed arguments 不创建 side-effect operation（不 started / 不 uncertain）----
  {
    const controller = new AbortController();
    let calls = 0;
    nonIdem.executeCount = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? toolCallResponse('call-ni', 'args-non-idem', '{"bad":')
        : okResponse('done');
    }) as typeof fetch;
    const answer = await runAgent('c8', undefined, {
      executionContext: createAgentExecutionContext({ runId: 'tool-args-nonidem', workspaceRoot }),
      ...createDefaultRuntimeServices(),
      modelConfig: MODEL_CONFIG,
      signal: controller.signal,
    });
    const cp = loadCheckpoint('tool-args-nonidem');
    const sideEffects = cp?.sideEffects ?? [];
    check(
      'Case8: malformed call → no side-effect operation started/uncertain, tool not executed',
      answer === 'done' &&
        nonIdem.executeCount === 0 &&
        !sideEffects.some((op) => op.key.startsWith('args-non-idem')),
      `executed=${nonIdem.executeCount}, ops=${JSON.stringify(sideEffects)}`,
    );
    cleanupCheckpoint('tool-args-nonidem');
  }

  // ---- Case 9: malformed error 之后 abort → 不再调用下一轮 LLM + checkpoint 成对 ----
  {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        // 返回 malformed tool_call 的同时模拟用户 Stop（真实场景：stop abort 在途请求）
        controller.abort();
        return toolCallResponse('call-abort', 'args-probe', '{"path":');
      }
      return okResponse('should-not-happen');
    }) as typeof fetch;
    const pending = runAgent('c9', undefined, {
      executionContext: createAgentExecutionContext({ runId: 'tool-args-abort', workspaceRoot }),
      ...createDefaultRuntimeServices(),
      modelConfig: MODEL_CONFIG,
      signal: controller.signal,
    });
    await assert.rejects(pending, (err: unknown) => isAbortError(err));
    check('Case9: abort after malformed result → no next LLM call', calls === 1, `calls=${calls}`);

    // Case 9 补充：abort 边界先于 error result 构造 —— checkpoint 中不产生
    // 孤立的 tool result（protocol 一致性：不会出现无响应的 tool_call 悬挂）
    const abortCp = loadCheckpoint('tool-args-abort');
    check(
      'Case9: abort checkpoint has no dangling tool result',
      !!abortCp && !abortCp.messages.some((m) => m.role === 'tool'),
    );
    cleanupCheckpoint('tool-args-abort');
  }

  // ---- Case 11: 正常 calculator 路径不受影响（既有行为回归）----
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return toolCallResponse('call-calc', 'calculator', '{"expression":"6*7"}');
      return okResponse('42');
    }) as typeof fetch;
    const answer = await runAgent('c11', undefined, {
      executionContext: createAgentExecutionContext({ runId: 'tool-args-valid', workspaceRoot }),
      ...createDefaultRuntimeServices(),
      modelConfig: MODEL_CONFIG,
    });
    check('Case11: valid tool call path unchanged', answer === '42' && calls === 2);
    cleanupCheckpoint('tool-args-valid');
  }
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\nTool args recovery tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
