// Deterministic toolchain capability refresh tests (v1.6 工具链闭环①)：
// 受控安装成功后，刷新的能力快照经准备结果通道流回 agent，当前 Run 的
// 下一轮模型视图即感知新工具；原命令不自动重试（Side-Effect Safety）。
// shell 工具以确定性 stub 覆盖（子进程内注册），不依赖本机 git 状态。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentExecutionContext,
  createDefaultRuntimeServices,
} from '../src/bootstrap/runtime-bootstrap.js';
import { DefaultContextHarness } from '../src/harness/context-harness.js';
import { checkpointPath } from '../src/persistence/file-checkpoint-store.js';
import { runAgent } from '../src/runtime/agent.js';
import type { RuntimeToolchainCapabilities } from '../src/sandbox/toolchain-manager.js';
import { RequiredRuntimeToolUnavailableError, register } from '../src/tools/tools.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-toolchain-refresh-'));
process.env.SANDBOX_ROOT = ROOT;

const MODEL_CONFIG = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'sk-toolchain-refresh',
  model: 'MiniMax-M3',
};

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

const INITIAL: RuntimeToolchainCapabilities = {
  platform: 'macos',
  discovery: 'startup',
  tools: {
    git: { status: 'missing', reason: 'not_found' },
    node: { status: 'available' },
    npm: { status: 'available' },
  },
};
const REFRESHED: RuntimeToolchainCapabilities = {
  platform: 'macos',
  discovery: 'startup',
  tools: {
    git: { status: 'available' },
    node: { status: 'available' },
    npm: { status: 'available' },
  },
};

const originalFetch = globalThis.fetch;

try {
  // ---- Harness 单元：refreshToolchain 更新下一轮模型视图 ----
  {
    const harness = new DefaultContextHarness({ permissionMode: 'workspace-write' });
    const before = harness.createTranscript('t')[0].content;
    check(
      'harness: 默认（无快照）不含可用清单',
      before.includes('determined once by Host') && !before.includes('Available tools: git'),
    );
    harness.refreshToolchain(REFRESHED);
    const after = harness.createTranscript('t')[0].content;
    check(
      'harness: refreshToolchain 后模型视图含 git 可用',
      after.includes('Available tools: git, node, npm') && !after.includes('Missing tools: git'),
    );
  }

  // ---- Agent 集成：shell 缺依赖 → 准备成功 + 能力刷新 → 下一轮视图更新 ----
  {
    // stub 覆盖真实 shell（本套件子进程内）：模拟"git 命令不存在"的可恢复失败
    register({
      name: 'shell',
      description: 'deterministic stub',
      effect: 'non_idempotent',
      getOperationKey: (args) => `cmd:${String((args as { command?: unknown }).command ?? '')}`,
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'shell command' } },
        required: ['command'],
      },
      execute: async () => {
        throw new RequiredRuntimeToolUnavailableError('git');
      },
    });

    const bodies: Array<{ messages: Array<{ role: string; content: string }>; model: unknown }> =
      [];
    let portRequests = 0;
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
        model: unknown;
      };
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'shell', arguments: '{"command":"git status"}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return okResponse('已安装完成，等待用户确认重试');
    }) as typeof fetch;

    const executionContext = {
      ...createAgentExecutionContext({ runId: 'toolchain-refresh' }),
      toolchain: INITIAL,
    };
    const answer = await runAgent('验证能力刷新', undefined, {
      executionContext,
      ...createDefaultRuntimeServices(),
      modelConfig: MODEL_CONFIG,
      toolchainPreparationPort: {
        request: async () => {
          portRequests++;
          return {
            approved: true,
            prepared: true,
            status: 'prepared',
            capabilities: REFRESHED,
          };
        },
      },
    });

    check('agent: run completed after preparation', answer === '已安装完成，等待用户确认重试');
    check('agent: preparation port requested exactly once', portRequests === 1);
    check(
      'refresh: turn-1 model view had git missing',
      bodies[0]?.messages[0]?.content.includes('Missing tools: git') === true,
    );
    check(
      'refresh: turn-2 model view has git available (current Run感知)',
      bodies[1]?.messages[0]?.content.includes('Available tools: git') === true,
      bodies[1]?.messages[0]?.content.slice(0, 200),
    );
    const toolResult = bodies[1]?.messages.find((m) => m.role === 'tool');
    check(
      'agent: tool result states no auto-retry (Side-Effect Safety)',
      typeof toolResult?.content === 'string' &&
        toolResult.content.includes('not retried automatically'),
    );
    check('refresh: request model still the run model', bodies[1]?.model === 'MiniMax-M3');
    cleanupCheckpoint('toolchain-refresh');
  }

  function okResponse(content: string): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
      { status: 200 },
    );
  }
  function cleanupCheckpoint(runId: string): void {
    fs.rmSync(checkpointPath(runId), { force: true });
  }
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\nToolchain refresh tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
