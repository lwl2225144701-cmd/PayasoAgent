// Agent-level deterministic proof for Harness compaction, checkpoint state and
// canonical transcript preservation. No real network or provider is used.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentExecutionContext,
  createDefaultRuntimeServices,
} from '../src/bootstrap/runtime-bootstrap.js';
import { DefaultContextHarness } from '../src/harness/context-harness.js';
import { resolveModelContextConfig } from '../src/harness/model-context.js';
import type { ChatMessage } from '../src/llm/llm.js';
import { checkpointPath, loadCheckpoint } from '../src/persistence/file-checkpoint-store.js';
import { runAgent } from '../src/runtime/agent.js';
import { register } from '../src/tools/tools.js';

// 大输出探针：制造 12KB 工具结果以触发紧急裁剪路径（本套件子进程内注册）
register({
  name: 'emergency-probe',
  description: 'returns a large output to inflate the context',
  effect: 'read',
  parameters: { type: 'object', properties: { round: { type: 'number' } } },
  execute: async () => 'x'.repeat(12_000),
});

import { silentRuntimeObserver } from '../src/runtime/observer-port.js';
import type { TraceEvent } from '../src/runtime/trace.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-context-compaction-'));
process.env.SANDBOX_ROOT = path.join(root, 'sandbox');
const runId = 'context-compaction-run';
const originalFetch = globalThis.fetch;

try {
  const history: ChatMessage[] = [];
  for (let index = 0; index < 8; index++) {
    history.push({ role: 'user', content: `old-user-${index} ${'u'.repeat(1_500)}` });
    history.push({ role: 'assistant', content: `old-answer-${index} ${'a'.repeat(1_500)}` });
  }
  let summaryCalls = 0;
  const harness = new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelContext: resolveModelContextConfig({
      model: 'context-test',
      contextWindowTokens: 6_000,
      maxOutputTokens: 1_000,
      safetyTokens: 500,
    }),
    summarizer: {
      summarize: async () => {
        summaryCalls++;
        return 'Goal: preserve the long session\nProgress: earlier turns compacted';
      },
    },
  });
  const requestMessages: ChatMessage[][] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
    requestMessages.push(body.messages);
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const traces: TraceEvent[] = [];
  const result = await runAgent('current-task', undefined, {
    executionContext: createAgentExecutionContext({ runId }),
    ...createDefaultRuntimeServices(),
    observer: silentRuntimeObserver,
    conversationHistory: history,
    contextHarness: harness,
    modelConfig: {
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-key',
      model: 'context-test',
    },
    onTrace: (event) => traces.push(event),
  });

  assert.equal(result, 'done');
  assert.equal(summaryCalls, 1);
  const compaction = traces.find(
    (event): event is Extract<TraceEvent, { type: 'context_compaction' }> =>
      event.type === 'context_compaction',
  );
  assert.ok(compaction && compaction.summarizedMessages > 0);
  assert.match(requestMessages[0][0].content, /\[Conversation Summary\]/);
  assert.equal(requestMessages[0].at(-1)?.content, 'current-task');
  assert.ok(!requestMessages[0].some((message) => message.content.includes('old-user-0')));

  const checkpoint = loadCheckpoint(runId);
  assert.ok(checkpoint?.harnessState?.conversationSummary.includes('earlier turns compacted'));
  assert.equal(checkpoint?.harnessState?.summarizedMessageCount, compaction.summarizedMessages);
  assert.ok(
    checkpoint?.messages.some((message) => message.content.includes('old-user-0')),
    'canonical checkpoint transcript must retain summarized history',
  );

  assert.ok(checkpoint);
  const resumedHarness = new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelContext: resolveModelContextConfig({
      model: 'context-test',
      contextWindowTokens: 6_000,
      maxOutputTokens: 1_000,
      safetyTokens: 500,
    }),
    summarizer: {
      summarize: async () => {
        throw new Error('resume should retain the existing summary');
      },
    },
  });
  const resumed = await runAgent(checkpoint.task, checkpoint, {
    executionContext: createAgentExecutionContext({
      runId,
      workspaceRoot: checkpoint.workspaceRoot,
      permissionMode: checkpoint.permissionMode,
    }),
    ...createDefaultRuntimeServices(),
    observer: silentRuntimeObserver,
    contextHarness: resumedHarness,
    modelConfig: {
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-key',
      model: 'context-test',
    },
  });
  assert.equal(resumed, 'done');
  assert.match(requestMessages[1][0].content, /\[Conversation Summary\]/);
  assert.match(requestMessages[1][0].content, /earlier turns compacted/);
  assert.ok(!requestMessages[1].some((message) => message.content.includes('old-user-0')));
  console.log('Context compaction Agent test: PASS');

  // ---- v1.6 紧急兜底（复现线上失败场景）：单任务 + 大工具输出 + 未知模型
  // 保守预算 → 轮边界压缩无能为力 → 当前轮内紧急裁剪保证 Run 存活 ----
  const emergencyRunId = 'emergency-trim-run';
  const emergencyHarness = new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelContext: resolveModelContextConfig({
      model: 'unknown-small-model', // 不在能力注册表 → 保守 fallback 预算
      contextWindowTokens: 6_000, // 显式小窗口：让 12KB 工具结果稳定触发超限
      maxOutputTokens: 1_000,
      safetyTokens: 500,
    }),
  });
  const emergencyTraces: TraceEvent[] = [];
  const requestSizes: number[] = [];
  let bigCalls = 0;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
    requestSizes.push(body.messages.length);
    if (bigCalls < 2) {
      bigCalls++;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: `call-big-${bigCalls}`,
                    type: 'function',
                    function: { name: 'emergency-probe', arguments: `{"round":${bigCalls}}` },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'survived' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const emergencyResult = await runAgent('emergency scenario', undefined, {
    executionContext: createAgentExecutionContext({ runId: emergencyRunId }),
    ...createDefaultRuntimeServices(),
    observer: silentRuntimeObserver,
    contextHarness: emergencyHarness,
    modelConfig: {
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-key',
      model: 'unknown-small-model',
    },
    onTrace: (event) => emergencyTraces.push(event),
  });

  assert.equal(emergencyResult, 'survived');
  const lastUsage = [...emergencyTraces]
    .reverse()
    .find(
      (event): event is Extract<TraceEvent, { type: 'context_usage' }> =>
        event.type === 'context_usage',
    );
  assert.ok(lastUsage);
  assert.equal(lastUsage.emergencyTrim, true, 'last round must be flagged as emergency-trimmed');
  // 紧急裁剪生效：最终视图必然有界（第 2 轮即收敛，之后保持小视图不再膨胀）
  assert.ok(
    requestSizes[requestSizes.length - 1] <= 2 && requestSizes.every((n) => n <= 6),
    `final view must stay bounded: ${JSON.stringify(requestSizes)}`,
  );
  fs.rmSync(checkpointPath(emergencyRunId), { force: true });
  console.log('Emergency over-budget fallback test: PASS');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(checkpointPath(runId), { force: true });
  fs.rmSync(root, { recursive: true, force: true });
}
