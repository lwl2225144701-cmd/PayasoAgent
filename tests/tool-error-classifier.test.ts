// 套件: Tool Error Classifier — 只有瞬时错误才重试
// 用法: npx tsx tests/tool-error-classifier.test.ts
// 回归目标（v1.8）：确定性错误（ENOENT/参数错/策略拒绝）执行且仅执行一次，
// 错误明确回告模型"未重试"；瞬时错误（ETIMEDOUT）仍按预算重试。

import assert from 'node:assert/strict';
import { classifyToolError } from '../src/runtime/tool-error-classifier.js';
import { NetworkDeniedError, register, RequiredRuntimeToolUnavailableError } from '../src/tools/tools.js';
import {
  createTestWorkspaceRoot,
  runMockAgent,
  textResponse,
  toolCallResponse,
} from './helpers/mock-runner.js';

const WORKSPACE = createTestWorkspaceRoot('payaso-tool-error-classifier-');

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

function errnoError(code: string, message = `simulated ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

// ---- 1. 纯函数：分类规则 ----

await check('ENOENT（文件不存在）→ permanent，不重试', () => {
  const result = classifyToolError(errnoError('ENOENT', '文件不存在: a.ts'));
  assert.equal(result.kind, 'permanent');
  assert.equal(result.retryable, false);
  assert.equal(result.code, 'ENOENT');
});

await check('ETIMEDOUT / ECONNRESET / EBUSY → transient，可重试', () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EBUSY', 'EAGAIN']) {
    const result = classifyToolError(errnoError(code));
    assert.equal(result.kind, 'transient', `${code} 应为瞬时`);
    assert.equal(result.retryable, true, `${code} 应可重试`);
  }
});

await check('无 code 的普通错误 → 默认不重试（fail-safe）', () => {
  const result = classifyToolError(new Error('参数非法: limit 必须是正整数'));
  assert.equal(result.retryable, false);
  assert.ok(result.reason.includes('unclassified'));
});

await check('abort → 不重试（重试即忽略取消）', () => {
  const abort = new DOMException('Aborted', 'AbortError');
  const result = classifyToolError(abort);
  assert.equal(result.kind, 'abort');
  assert.equal(result.retryable, false);
});

await check('策略拒绝（网络 / 缺失工具链）→ policy，不重试', () => {
  const network = classifyToolError(new NetworkDeniedError('shell'));
  assert.equal(network.kind, 'policy');
  assert.equal(network.retryable, false);
  const toolchain = classifyToolError(new RequiredRuntimeToolUnavailableError('jq'));
  assert.equal(toolchain.kind, 'policy');
  assert.equal(toolchain.retryable, false);
});

await check('瞬时上游消息（fetch failed / timeout / 429）→ transient', () => {
  for (const message of [
    'fetch failed',
    'LLM request timed out after 240000ms',
    'request failed with HTTP 429',
    'connection reset by peer',
  ]) {
    const result = classifyToolError(new Error(message));
    assert.equal(result.kind, 'transient', `"${message}" 应为瞬时`);
    assert.equal(result.retryable, true, `"${message}" 应可重试`);
  }
});

// ---- 2. 集成：确定性错误只执行一次 ----

const permanentProbe = { calls: 0 };
register({
  name: 'permanent-error-probe',
  description: 'always throws ENOENT',
  effect: 'read',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async () => {
    permanentProbe.calls++;
    throw errnoError('ENOENT', '文件不存在: missing.ts');
  },
});

await check('集成：ENOENT 只执行一次，且回传的 tool 消息说明"未重试"', async () => {
  permanentProbe.calls = 0;
  const requestBodies: unknown[] = [];
  const result = await runMockAgent({
    runId: 'classifier-permanent',
    task: '读一个不存在的文件',
    workspaceRoot: WORKSPACE,
    onRequest: (body) => requestBodies.push(body),
    script: [
      () =>
        toolCallResponse([
          { id: 'p1', name: 'permanent-error-probe', args: { path: 'missing.ts' } },
        ]),
      () => textResponse('我会换一个路径'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(permanentProbe.calls, 1, `确定性错误必须只执行一次，实际 ${permanentProbe.calls}`);
  const toolErrors = result.traces.filter((event) => event.type === 'tool_error');
  assert.equal(toolErrors.length, 1, `tool_error 应只发一次，实际 ${toolErrors.length}`);
  const last = requestBodies[requestBodies.length - 1] as { messages?: Array<{ role: string; content: string }> };
  const recovery = last?.messages?.find(
    (message) => message.role === 'tool' && message.content.includes('文件不存在: missing.ts'),
  );
  assert.ok(recovery, '模型必须收到该工具错误');
  assert.ok(recovery.content.includes('未重试'), `恢复消息应说明未重试: ${recovery.content}`);
});

// ---- 3. 集成：瞬时错误仍按预算重试 ----

const transientProbe = { calls: 0 };
register({
  name: 'transient-error-probe',
  description: 'fails twice with ETIMEDOUT then succeeds',
  effect: 'read',
  parameters: { type: 'object', properties: {}, additionalProperties: true },
  execute: async () => {
    transientProbe.calls++;
    if (transientProbe.calls < 3) throw errnoError('ETIMEDOUT', 'upstream timeout');
    return 'finally-ok';
  },
});

await check('集成：ETIMEDOUT 前两次失败后成功（重试预算仍生效）', async () => {
  transientProbe.calls = 0;
  const result = await runMockAgent({
    runId: 'classifier-transient',
    task: '重试',
    workspaceRoot: WORKSPACE,
    script: [
      () => toolCallResponse([{ id: 't1', name: 'transient-error-probe', args: {} }]),
      () => textResponse('成功'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(transientProbe.calls, 3, `应重试到第 3 次成功，实际 ${transientProbe.calls}`);
  assert.equal(result.answer, '成功');
});

console.log(`\ntool-error-classifier 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
