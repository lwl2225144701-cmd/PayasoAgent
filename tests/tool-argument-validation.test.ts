// 套件: Tool Argument Validation — 声明的 schema 是契约，违反必须显式回告模型
// 用法: npx tsx tests/tool-argument-validation.test.ts
// 覆盖：
//   1. 纯函数：未知参数 / 缺必填 / 类型错 / 枚举错 / 嵌套数组 / additionalProperties
//   2. 集成：未知参数 → 工具不执行 + INVALID_ARGUMENT_SHAPE + 结构化提示（含可接受参数）
//   3. 集成：模型按提示修正后工具恰好执行一次
//   4. 回归：shell 的 `timeout`（未声明）被拒绝并指向 `timeoutMs`（已声明）

import assert from 'node:assert/strict';
import { formatToolArgumentIssues, validateToolArguments } from '../src/tools/tool-arguments.js';
import { register } from '../src/tools/tools.js';
import {
  createTestWorkspaceRoot,
  runMockAgent,
  textResponse,
  toolCallResponse,
} from './helpers/mock-runner.js';

const WORKSPACE = createTestWorkspaceRoot('payaso-tool-arg-validation-');

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

// ---- 测试工具（形状与真实工具一致：声明式 schema + 执行计数）----

const probe = {
  executeCount: 0,
  lastArgs: null as Record<string, unknown> | null,
};

const PROBE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    limit: { type: 'integer' },
    mode: { type: 'string', enum: ['fast', 'safe'] },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
        required: ['oldText', 'newText'],
      },
    },
  },
  required: ['path'],
};

register({
  name: 'arg-probe',
  description: 'argument validation probe',
  effect: 'read',
  parameters: PROBE_SCHEMA,
  execute: async (args) => {
    probe.executeCount++;
    probe.lastArgs = args;
    return 'probe-ok';
  },
});

register({
  name: 'shell-like-probe',
  description: 'declares command + timeoutMs, mirroring the real shell tool',
  effect: 'read',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } },
    required: ['command'],
  },
  execute: async () => 'shell-like-ok',
});

// ---- 1. 纯函数 ----

await check('未知参数 → unknown issue，并列出可接受参数', () => {
  const result = validateToolArguments(PROBE_SCHEMA, { path: 'a', bogus: 1 });
  assert.equal(result.ok, false);
  const issue = result.issues.find((item) => item.kind === 'unknown');
  assert.ok(issue, JSON.stringify(result.issues));
  assert.equal(issue?.key, 'bogus');
  assert.deepEqual(issue?.accepted, ['path', 'limit', 'mode', 'edits']);
});

await check('缺必填 → missing issue', () => {
  const result = validateToolArguments(PROBE_SCHEMA, { limit: 5 });
  assert.ok(result.issues.some((item) => item.kind === 'missing' && item.key === 'path'));
});

await check('类型不匹配 → type issue（含期望与实际）', () => {
  const result = validateToolArguments(PROBE_SCHEMA, { path: 'a', limit: 'five' });
  const issue = result.issues.find((item) => item.kind === 'type' && item.key === 'limit');
  assert.ok(issue);
  assert.equal(issue?.expected, 'integer');
  assert.equal(issue?.received, 'string');
});

await check('枚举越界 → enum issue', () => {
  const result = validateToolArguments(PROBE_SCHEMA, { path: 'a', mode: 'turbo' });
  assert.ok(result.issues.some((item) => item.kind === 'enum' && item.key === 'mode'));
});

await check('嵌套数组对象：逐项校验并给出索引路径', () => {
  const result = validateToolArguments(PROBE_SCHEMA, {
    path: 'a',
    edits: [{ oldText: 'x', newText: 'y' }, { oldText: 1, newText: 'z' }],
  });
  const issue = result.issues.find((item) => item.kind === 'type');
  assert.equal(issue?.key, 'edits[1].oldText', JSON.stringify(result.issues));
});

await check('合法参数 → ok，无 issue', () => {
  const result = validateToolArguments(PROBE_SCHEMA, {
    path: 'a',
    limit: 3,
    mode: 'safe',
    edits: [{ oldText: 'x', newText: 'y' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

await check('additionalProperties: true → 允许未知参数（显式声明的例外）', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: true,
  };
  assert.equal(validateToolArguments(schema, { path: 'a', extra: 1 }).ok, true);
});

await check('未声明 type 的 schema → 不因校验器局限而拦截', () => {
  assert.equal(validateToolArguments({ type: 'object', properties: {} }, { anything: 1 }).ok, false);
  // 显式允许扩展时才放行
  assert.equal(
    validateToolArguments(
      { type: 'object', properties: {}, additionalProperties: true },
      { anything: 1 },
    ).ok,
    true,
  );
});

await check('提示文案包含可接受参数与重试指引（模型可据此自修正）', () => {
  const result = validateToolArguments(PROBE_SCHEMA, { bogus: 1 });
  const message = formatToolArgumentIssues('arg-probe', result.issues);
  assert.ok(message.includes('unknown parameter "bogus"'));
  assert.ok(message.includes('path, limit, mode, edits'));
  assert.ok(message.includes('missing required parameter "path"'));
  assert.ok(message.includes('Retry this tool call'));
});

// ---- 2. 集成：未知参数不执行工具，回传结构化错误 ----

await check('集成：未知参数 → 工具不执行 + INVALID_ARGUMENT_SHAPE + 模型修正后恰好执行一次', async () => {
  probe.executeCount = 0;
  probe.lastArgs = null;
  const result = await runMockAgent({
    runId: 'arg-validation-unknown',
    task: '校验参数',
    workspaceRoot: WORKSPACE,
    script: [
      () => toolCallResponse([{ id: 'c1', name: 'arg-probe', args: { path: 'a', bogus: 1 } }]),
      () => toolCallResponse([{ id: 'c2', name: 'arg-probe', args: { path: 'a' } }]),
      () => textResponse('done'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.answer, 'done');
  assert.equal(probe.executeCount, 1, '未知参数不得执行工具');
  assert.deepEqual(probe.lastArgs, { path: 'a' });
  const invalid = result.traces.find((event) => event.type === 'tool_call_invalid');
  assert.ok(invalid, '必须产生 tool_call_invalid');
  assert.equal(invalid.type === 'tool_call_invalid' ? invalid.code : '', 'INVALID_ARGUMENT_SHAPE');
});

await check('集成：缺必填同样被拦截，不执行工具', async () => {
  probe.executeCount = 0;
  const result = await runMockAgent({
    runId: 'arg-validation-missing',
    task: '缺参数',
    workspaceRoot: WORKSPACE,
    script: [
      () => toolCallResponse([{ id: 'm1', name: 'arg-probe', args: { limit: 1 } }]),
      () => textResponse('stopped'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(probe.executeCount, 0);
  const invalid = result.traces.find((event) => event.type === 'tool_call_invalid');
  assert.equal(invalid?.type === 'tool_call_invalid' ? invalid.code : '', 'INVALID_ARGUMENT_SHAPE');
});

// ---- 3. 回归：模型把 `timeout` 当成 shell 参数 ----

await check('回归：未声明的 timeout 被拒绝，提示指向 timeoutMs', async () => {
  let executed = 0;
  register({
    name: 'shell-like-counting',
    description: 'counts executions',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } },
      required: ['command'],
    },
    execute: async () => {
      executed++;
      return 'ok';
    },
  });
  const result = await runMockAgent({
    runId: 'arg-validation-shell-timeout',
    task: '跑测试',
    workspaceRoot: WORKSPACE,
    script: [
      () =>
        toolCallResponse([
          { id: 's1', name: 'shell-like-counting', args: { command: 'npm test', timeout: 120 } },
        ]),
      () =>
        toolCallResponse([
          { id: 's2', name: 'shell-like-counting', args: { command: 'npm test', timeoutMs: 120000 } },
        ]),
      () => textResponse('ran'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.answer, 'ran');
  assert.equal(executed, 1, '只有修正后的调用才执行');
  const invalid = result.traces.find((event) => event.type === 'tool_call_invalid');
  assert.equal(invalid?.type === 'tool_call_invalid' ? invalid.code : '', 'INVALID_ARGUMENT_SHAPE');
});

console.log(`\ntool-argument-validation 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
