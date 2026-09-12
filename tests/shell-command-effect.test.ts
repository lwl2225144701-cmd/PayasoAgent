// 套件: Shell Command Effect — 只读命令免回放 + 动态 effect 机制
// 用法: npx tsx tests/shell-command-effect.test.ts
// 回归目标（v1.9）：shell 整体声明 non_idempotent，导致同一条只读命令第二次
// 调用返回第一次的缓存结果（`git status` 拿到旧输出，`npm test` 复现旧失败）。
// 现在按命令解析 effect：只读命令不走回放，写命令保留完整保护。

import assert from 'node:assert/strict';
import { classifyShellCommand } from '../src/sandbox/shell-command-effect.js';
import { getTool, register, resolveToolEffect } from '../src/tools/tools.js';
import {
  createTestWorkspaceRoot,
  runMockAgent,
  textResponse,
  toolCallResponse,
} from './helpers/mock-runner.js';

const WORKSPACE = createTestWorkspaceRoot('payaso-shell-command-effect-');

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

// ---- 1. 纯函数：分类规则 ----

await test('只读命令白名单：ls / cat / git log / find / grep', () => {
  for (const command of [
    'ls -la',
    'cat package.json',
    'git log --oneline -20',
    'git status',
    'git diff HEAD~1',
    'find src -name "*.ts"',
    'grep -rn TODO src',
    'wc -l src/index.ts',
    'pwd',
  ]) {
    assert.equal(classifyShellCommand(command).effect, 'read', `应判定只读: ${command}`);
  }
});

await test('含 shell 组合/重定向 → 保守判为可能写', () => {
  for (const command of [
    'git status && ls',
    'cat a.txt > b.txt',
    'ls | head -5',
    'echo x >> log.txt',
    'git log; rm -rf work',
    'ls $(pwd)',
    'ls `pwd`',
    'echo a\nls',
  ]) {
    assert.equal(classifyShellCommand(command).effect, 'non_idempotent', `应保守判定: ${command}`);
  }
});

await test('写命令不在白名单 → non_idempotent', () => {
  for (const command of [
    'npm run test:all',
    'npx tsx build.ts',
    'rm -rf dist',
    'mv a b',
    'git commit -m x',
  ]) {
    assert.equal(classifyShellCommand(command).effect, 'non_idempotent', command);
  }
});

await test('git 子命令细分：读子命令只读，写子命令/裸 git 不读', () => {
  assert.equal(classifyShellCommand('git show HEAD').effect, 'read');
  assert.equal(classifyShellCommand('git ls-files').effect, 'read');
  assert.equal(classifyShellCommand('git').effect, 'non_idempotent', '裸 git 可能写');
  assert.equal(classifyShellCommand('git branch -d feature').effect, 'non_idempotent');
  assert.equal(classifyShellCommand('git stash').effect, 'non_idempotent');
  assert.equal(classifyShellCommand('git checkout main').effect, 'non_idempotent');
});

await test('git config 只在带读取标志时判为只读', () => {
  assert.equal(classifyShellCommand('git config --get user.name').effect, 'read');
  assert.equal(classifyShellCommand('git config --list').effect, 'read');
  assert.equal(classifyShellCommand('git config user.name someone').effect, 'non_idempotent');
});

await test('find 带 -exec/-delete → 不判只读', () => {
  assert.equal(classifyShellCommand('find . -name "*.log"').effect, 'read');
  assert.equal(classifyShellCommand('find . -name "*.log" -delete').effect, 'non_idempotent');
  assert.equal(classifyShellCommand('find . -exec rm {} ;').effect, 'non_idempotent');
});

await test('空命令 / 未登记程序 → non_idempotent', () => {
  assert.equal(classifyShellCommand('').effect, 'non_idempotent');
  assert.equal(classifyShellCommand('mytool --read-only').effect, 'non_idempotent');
  assert.equal(classifyShellCommand('/usr/local/bin/mytool').effect, 'non_idempotent');
  assert.equal(classifyShellCommand('/bin/ls -la').effect, 'read', '按 basename 判定');
});

// ---- 2. 真实 shell 工具已声明动态 effect ----

await test('shell 工具声明了 resolveEffect（只读命令 → read）', () => {
  const shell = getTool('shell');
  assert.ok(shell, 'shell 必须已注册');
  assert.equal(shell.effect, 'non_idempotent', '静态声明保持保守');
  assert.ok(shell.resolveEffect, 'shell 必须声明 resolveEffect');
  assert.equal(resolveToolEffect(shell, { command: 'git status' }), 'read');
  assert.equal(resolveToolEffect(shell, { command: 'npm install' }), 'non_idempotent');
});

await test('resolveToolEffect 缺省回退静态 effect', () => {
  register({
    name: 'static-effect-probe',
    description: 'no resolveEffect',
    effect: 'idempotent',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    execute: async () => 'ok',
  });
  const tool = getTool('static-effect-probe');
  assert.ok(tool);
  assert.equal(resolveToolEffect(tool, {}), 'idempotent');
});

// ---- 3. 集成：动态 effect 决定是否回放 ----

const probe = { calls: 0 };
register({
  name: 'effect-probe',
  description: 'declares a per-call effect, mirroring the shell tool',
  effect: 'non_idempotent',
  getOperationKey: (args) => `probe:${JSON.stringify(args)}`,
  resolveEffect: (args) => (args.readOnly === true ? 'read' : 'non_idempotent'),
  parameters: {
    type: 'object',
    properties: { readOnly: { type: 'boolean' } },
    additionalProperties: true,
  },
  execute: async () => {
    probe.calls++;
    return `result-${probe.calls}`;
  },
});

await test('集成：只读调用两次 → 执行两次（不回放缓存）', async () => {
  probe.calls = 0;
  const result = await runMockAgent({
    runId: 'effect-read-twice',
    task: '读两次',
    workspaceRoot: WORKSPACE,
    script: [
      () => toolCallResponse([{ id: 'r1', name: 'effect-probe', args: { readOnly: true } }]),
      () => toolCallResponse([{ id: 'r2', name: 'effect-probe', args: { readOnly: true } }]),
      () => textResponse('done'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(probe.calls, 2, `只读命令应重新执行，实际 ${probe.calls}`);
  assert.equal(
    result.traces.filter((event) => event.type === 'side_effect_skip').length,
    0,
    '只读调用不应产生回放',
  );
});

await test('集成：写调用两次 → 第二次回放首次结果，不重复执行', async () => {
  probe.calls = 0;
  const requestBodies: unknown[] = [];
  const result = await runMockAgent({
    runId: 'effect-write-twice',
    task: '写两次',
    workspaceRoot: WORKSPACE,
    onRequest: (body) => requestBodies.push(body),
    script: [
      () => toolCallResponse([{ id: 'w1', name: 'effect-probe', args: { readOnly: false } }]),
      () => toolCallResponse([{ id: 'w2', name: 'effect-probe', args: { readOnly: false } }]),
      () => textResponse('done'),
    ],
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(probe.calls, 1, `写调用不得重复执行，实际 ${probe.calls}`);
  assert.equal(
    result.traces.filter((event) => event.type === 'side_effect_skip').length,
    1,
    '应产生一次 side_effect_skip',
  );
  // 第二次调用回放的是首次结果
  const last = requestBodies[requestBodies.length - 1] as {
    messages?: Array<{ role: string; content: string; tool_call_id?: string }>;
  };
  const replay = last?.messages?.find(
    (message) => message.role === 'tool' && message.tool_call_id === 'w2',
  );
  assert.ok(replay, '第二次调用必须有 tool 结果');
  assert.ok(replay.content.includes('result-1'), `应回放首次结果: ${replay.content}`);
});

console.log(`\nshell-command-effect 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
