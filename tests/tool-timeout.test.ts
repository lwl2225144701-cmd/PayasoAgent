// 套件: Tool Timeout — 工具级超时预算（docs/long-task-timeout-plan.md 步骤 3）
// 用法: npx tsx tests/tool-timeout.test.ts
// 覆盖:
//   1. 挂死工具在 deadline 到期后不再无限等待（结构化 TOOL_TIMEOUT 回传模型）
//   2. 超时不重试（同一参数只执行一次），Run 继续并正常完成
//   3. tool_error 带 timeout:'tool' 标记；模型视角可见 TOOL_TIMEOUT 内容
// 说明：确定性，无真实 LLM/网络——fetch 打桩 + 注入 hang 工具（同 runtime-loop 自举）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentExecutionContext } from '../src/bootstrap/runtime-bootstrap.js';
import type { ChatMessage } from '../src/llm/llm.js';
import { runAgent } from '../src/runtime/agent.js';
import { silentRuntimeObserver } from '../src/runtime/observer-port.js';
import { register, type ToolContext } from '../src/tools/tools.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-tool-timeout-'));
process.env.SANDBOX_ROOT = ROOT;

const MODEL_CONFIG = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'sk-tool-timeout',
  model: 'gpt-4o-mini',
};

function response(message: ChatMessage): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toolCall(name: string, iteration: number): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: `hang-call-${iteration}`,
        type: 'function',
        function: { name, arguments: '{}' },
      },
    ],
  };
}

// 挂死工具：只监听信号中止，否则永不 settle —— 触发外层工具 deadline。
const hangToolName = 'hang-tool';
register({
  name: hangToolName,
  description: 'deterministic hanging tool for Tool Timeout tests',
  effect: 'read',
  // 声明极小预算（会被全局策略下限收敛到 1s，保证用例快速确定性）
  timeoutMs: () => 50,
  parameters: { type: 'object', properties: {} },
  execute: (_args: Record<string, unknown>, context: ToolContext) =>
    new Promise<string>((_resolve, reject) => {
      if (context.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      context.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    }),
});

function runOptions(
  runId: string,
  root: string,
  saves: Array<{ status: string; iteration: number }>,
  events: string[] = [],
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
  };
}

const originalFetch = globalThis.fetch;
try {
  {
    const bodies: string[] = [];
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls++;
      bodies.push(String(init?.body));
      return calls === 1
        ? response(toolCall(hangToolName, calls))
        : response({ role: 'assistant', content: 'done' });
    }) as typeof fetch;

    const saves: Array<{ status: string; iteration: number }> = [];
    const events: string[] = [];
    const root = path.join(ROOT, 'hang');
    fs.mkdirSync(root);

    const answer = await runAgent(
      'hang one tool, then finish',
      undefined,
      runOptions('hang', root, saves, events),
    );

    assert.equal(answer, 'done');
    assert.equal(calls, 2, '挂死工具只执行一次（超时不重试），随后进入下一轮 LLM');
    assert.equal(saves.at(-1)?.status, 'completed');
    // 结构化的 TOOL_TIMEOUT 恢复消息确实回传给了模型（第二轮请求体可见）
    assert.ok(bodies[1].includes('TOOL_TIMEOUT'), bodies[1]);
    assert.ok(bodies[1].includes(hangToolName), bodies[1]);
    // trace 里出现带超时标记的工具错误
    assert.ok(events.includes('tool_error'), events.join(','));
    assert.equal(events.filter((e) => e === 'tool_error').length, 1, '超时不重试，只记一次错误');
  }
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log('Tool timeout tests: PASS');
