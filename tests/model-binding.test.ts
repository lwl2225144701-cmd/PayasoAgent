// Deterministic proof (v1.6): the Run's selected model — not OPENAI_MODEL —
// drives the Runtime context budget, the context_usage trace, and the LLM
// request's max_tokens. No real network: fetch is mocked.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentExecutionContext,
  createDefaultRuntimeServices,
} from '../src/bootstrap/runtime-bootstrap.js';
import { resolveModelContextConfig } from '../src/harness/model-context.js';
import { checkpointPath } from '../src/persistence/file-checkpoint-store.js';
import { runAgent } from '../src/runtime/agent.js';
import type { TraceEvent } from '../src/runtime/trace.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-model-binding-'));
process.env.SANDBOX_ROOT = ROOT;

const originalFetch = globalThis.fetch;
const originalModel = process.env.OPENAI_MODEL;
// 环境模型（gpt-4o-mini，保守 32K/4K）故意不同于 Run 模型（MiniMax-M3，512K/16K）
process.env.OPENAI_MODEL = 'gpt-4o-mini';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const bodies: Array<{ model: unknown; max_tokens: unknown }> = [];
const traces: TraceEvent[] = [];
const runId = 'model-binding-run';

try {
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as { model: unknown; max_tokens: unknown });
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  const answer = await runAgent('验证 Run 模型绑定', undefined, {
    executionContext: createAgentExecutionContext({ runId }),
    ...createDefaultRuntimeServices(),
    modelConfig: {
      baseUrl: 'https://provider.example/v1',
      apiKey: 'sk-binding',
      model: 'MiniMax-M3',
    },
    onTrace: (event) => traces.push(event),
  });

  // Case 2：请求体 model 与 max_tokens 都来自 Run 模型
  check(
    'request model is the run model',
    bodies[0]?.model === 'MiniMax-M3',
    `got ${bodies[0]?.model}`,
  );
  check(
    'max_tokens from run model capability (16384)',
    bodies[0]?.max_tokens === 16_384,
    `got ${bodies[0]?.max_tokens}`,
  );

  // Case 1 + 4：context_usage trace 全部对应当前 Run 模型
  const usage = traces.find(
    (event): event is Extract<TraceEvent, { type: 'context_usage' }> =>
      event.type === 'context_usage',
  );
  check('context_usage trace emitted', !!usage);
  const expected = resolveModelContextConfig({ model: 'MiniMax-M3' });
  check('usage.model is run model', usage?.model === 'MiniMax-M3', `got ${usage?.model}`);
  check('usage.modelSource is run', usage?.modelSource === 'run', `got ${usage?.modelSource}`);
  check(
    'usage.configSource is model_registry',
    usage?.configSource === 'model_registry',
    `got ${usage?.configSource}`,
  );
  check(
    'usage.contextWindowTokens is run model capability (512000)',
    usage?.contextWindowTokens === 512_000 &&
      usage?.contextWindowTokens === expected.contextWindowTokens,
    `got ${usage?.contextWindowTokens}`,
  );
  check(
    'usage.maxOutputTokens is run model capability (16384)',
    usage?.maxOutputTokens === 16_384 && usage?.maxOutputTokens === expected.maxOutputTokens,
    `got ${usage?.maxOutputTokens}`,
  );
  check(
    'usage.inputBudgetTokens matches run model budget',
    usage?.inputBudgetTokens === expected.maxInputTokens,
    `got ${usage?.inputBudgetTokens}, want ${expected.maxInputTokens}`,
  );

  // 环境模型能力（32K/4K）未被使用
  check(
    'env model capability (32K/4K) not used anywhere',
    usage?.contextWindowTokens !== 32_768 && bodies[0]?.max_tokens !== 4_096,
  );

  check('agent completed with mocked answer', answer === 'done');
} finally {
  globalThis.fetch = originalFetch;
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
  fs.rmSync(checkpointPath(runId), { force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\nModel binding tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
