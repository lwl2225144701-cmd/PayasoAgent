// 套件: Execution Evidence — 执行事实存储、身份与复用核对（计划 §6 / P1-A 的 R01-R05）
//
// 断言语义（不是实现文本）：
//   R01 同 origin 不启动第二次执行，已结算记录可追溯；
//   R02 源/输入变化必须重新执行，不能被旧命令的副作用结果掩盖；
//   R03 reuse=false 只绕过"已完成结论复用"，不绕过 running/uncertain 保护；
//   R04 新 Run 清空、旧快照/未知版本按未知（绝不恢复出 passed）；
//   R05 输入闭包/检查对象/适配器版本变化 → 复用失效；相同命令 ≠ 相同检查。

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createExecutionEvidenceStore,
  EVIDENCE_SNAPSHOT_VERSION,
  MAX_CHECK_RECORDS,
  normalizeEvidenceSnapshot,
} from '../src/runtime/execution-evidence-store.js';
import { createScratchpad } from '../src/runtime/scratchpad.js';
import { createSideEffectGuard, resolveOperation } from '../src/runtime/side-effect.js';
import { createState } from '../src/runtime/state.js';
import { invokeToolCall } from '../src/runtime/tool-invocation/process-manager.js';
import type { TraceEventInput } from '../src/runtime/trace.js';
import { checkSpecDigest, checkTool, executeCheck, registerCheckTool } from '../src/tools/check.js';
import { readFacts } from '../src/tools/tool-facts.js';
import type { ToolContext } from '../src/tools/tools.js';

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

let passed = 0;
let failed = 0;

// check 必须注册进工具表（hidden 与否不影响 getTool 解析）。
registerCheckTool();

const processArgs = {
  profile: 'process',
  program: 'node',
  args: ['--version'],
} as const;

function processFacts(passedCheck: boolean) {
  return {
    version: 1,
    process: {
      exitCode: passedCheck ? 0 : 1,
      timedOut: false,
      logsComplete: true,
      stdoutRef: 'input/spill/run.log',
    },
    check: {
      profile: 'process',
      conclusion: passedCheck ? 'passed' : 'failed',
      diagnostics: null,
      reportComplete: true,
    },
  };
}

// ---- R01：同 origin 不启动第二次执行 ----
test('R01 同 origin 复用同一个 invocationId，已结算记录可追溯', () => {
  const store = createExecutionEvidenceStore();
  const specHash = checkSpecDigest(processArgs, workspaceContext());
  const first = store.getOrCreateInvocation('iter:1:batch:0:call:c1', { specHash });
  assert.ok(first, 'first invocation must be allocated');
  assert.equal(first.reused, false);
  store.recordResult(first.invocationId, processFacts(true));
  const settled = store.snapshot().records.at(0);
  assert.equal(settled?.invocationId, first.invocationId);
  assert.equal(settled?.conclusion, 'passed');
  assert.equal(settled?.executionState, 'settled');
  assert.equal(settled?.reusable, false, '通用进程的输入闭包未知，不能自动复用');

  const again = store.getOrCreateInvocation('iter:1:batch:0:call:c1', { specHash });
  assert.equal(again?.invocationId, first.invocationId, 'same origin must not allocate a new run');
  assert.equal(again?.reused, true);
  // 复用只更新访问，不复制检查实体
  assert.equal(store.findReusable(specHash, null), null);
  assert.equal(store.snapshot().records.length, 1, 'reuse must not duplicate the check entity');
});

test('R01 端到端：未知输入版本的旧 passed 不能掩盖不存在的程序', async () => {
  const store = createExecutionEvidenceStore();
  const args = { profile: 'process', program: 'definitely-not-a-real-binary-xyz', args: [] };
  const specHash = checkSpecDigest(args, workspaceContext());
  const seeded = store.getOrCreateInvocation('iter:1:batch:0:call:seed', { specHash });
  assert.ok(seeded);
  store.recordResult(seeded.invocationId, processFacts(true));

  const messages = await runCheckThroughManager(store, args, 'iter:9:batch:0:call:next');
  const content = messages.join('\n');
  assert.doesNotMatch(content, /check-reused/, '未知版本必须走实际执行通路');
  assert.equal(store.snapshot().records.length, 2, '新调用具有自己的执行记录');
});

// ---- R02：源/输入变化必须重新执行 ----
test('R02 检查对象变化 → 新身份、不复用（旧副作用结果不会掩盖新检查）', () => {
  const store = createExecutionEvidenceStore();
  const specA = checkSpecDigest(processArgs, workspaceContext());
  const first = store.getOrCreateInvocation('o1', { specHash: specA });
  assert.ok(first);
  store.recordResult(first.invocationId, processFacts(true));

  // 参数变化只改变检查对象；真实文件变化在另一个端到端用例覆盖。
  const changedArgs = { ...processArgs, args: ['--version', '--changed'] };
  const specB = checkSpecDigest(changedArgs, workspaceContext());
  assert.notEqual(specB, specA);
  assert.equal(store.findReusable(specB, null), null, 'changed check object must not reuse');

  const second = store.getOrCreateInvocation('o2', { specHash: specB });
  assert.notEqual(second?.invocationId, first.invocationId);
  // 执行身份不同 → side-effect guard 不可能回放旧一次检查的结果
  const ctx = workspaceContext();
  const keyA = `check::check:v2:invocation:${first.invocationId}`;
  const keyB = `check::check:v2:invocation:${second?.invocationId}`;
  assert.notEqual(keyA, keyB);
  const guard = createSideEffectGuard([{ key: keyA, state: 'succeeded', result: 'old' }]);
  const disposition = resolveOperation(
    guard,
    checkTool,
    processArgs,
    { ...ctx, invocationId: second?.invocationId },
    'non_idempotent',
  );
  assert.equal(disposition.kind, 'start', 'new invocation must actually execute');
});

test('R02 端到端：同一检查对象的新调用不复用（reuse=false 时强制重跑）', async () => {
  const store = createExecutionEvidenceStore();
  const args = { profile: 'process', program: 'definitely-not-a-real-binary-xyz', args: [] };
  const specHash = checkSpecDigest(args, workspaceContext());
  const seeded = store.getOrCreateInvocation('iter:1:batch:0:call:seed', { specHash });
  assert.ok(seeded);
  store.recordResult(seeded.invocationId, processFacts(true));
  const messages = await runCheckThroughManager(store, { ...args, reuse: false }, 'o-new');
  assert.doesNotMatch(
    messages.join('\n'),
    /check-reused/,
    'reuse=false must bypass conclusion reuse',
  );
});

// ---- R03：uncertain 不复用、不绕过 ----
test('R03 uncertain 不产生可复用结论，也不被 reuse=false 绕过', () => {
  const store = createExecutionEvidenceStore();
  const specHash = checkSpecDigest(processArgs, workspaceContext());
  const handle = store.getOrCreateInvocation('o1', { specHash });
  assert.ok(handle);
  store.recordUncertain(handle.invocationId, 'check_timed_out');
  assert.equal(store.findReusable(specHash, null), null);
  const record = store.snapshot().records.at(0);
  assert.equal(record?.executionState, 'uncertain');
  assert.equal(record?.conclusion, null, 'uncertain must never carry a conclusion');
  assert.equal(store.hasUnresolved(), true);
  assert.equal(
    store.getOrCreateInvocation('new-origin', { specHash }),
    null,
    '换 origin 不能绕过相同检查的未决保护',
  );

  const guard = createSideEffectGuard([
    { key: `check::check:v2:invocation:${handle.invocationId}`, state: 'uncertain' },
  ]);
  const disposition = resolveOperation(
    guard,
    checkTool,
    processArgs,
    { ...workspaceContext(), invocationId: handle.invocationId },
    'non_idempotent',
  );
  assert.equal(disposition.kind, 'uncertain', 'uncertain protection must not be bypassed');
});

test('R03 端到端：新 origin + reuse=false 仍拦截同 spec 的 uncertain', async () => {
  const store = createExecutionEvidenceStore();
  const args = { profile: 'process', program: 'node', args: ['--version'] };
  const specHash = checkSpecDigest(args, workspaceContext());
  const handle = store.getOrCreateInvocation('old-origin', { specHash });
  assert.ok(handle);
  store.recordUncertain(handle.invocationId, 'interrupted');
  const messages = await runCheckThroughManager(store, { ...args, reuse: false }, 'new-origin');
  assert.match(messages.join('\n'), /check-uncertain/);
  assert.equal(store.snapshot().records.length, 1, '不得创建第二次执行身份');
  assert.equal(store.snapshot().records[0]?.executionState, 'uncertain');
});

// ---- R04：新 Run 清空 / 旧快照与未知版本按未知 ----
test('R04 新 Run 是空记录；快照往返保留结论；未知版本/坏字段一律清空', () => {
  const fresh = createExecutionEvidenceStore();
  assert.equal(fresh.snapshot().records.length, 0);
  assert.deepEqual(fresh.view().checks, []);

  const store = createExecutionEvidenceStore();
  const specHash = checkSpecDigest(processArgs, workspaceContext());
  const handle = store.getOrCreateInvocation('o1', { specHash });
  assert.ok(handle);
  store.recordResult(handle.invocationId, processFacts(true));
  const snapshot = JSON.parse(JSON.stringify(store.snapshot()));

  const resumed = createExecutionEvidenceStore();
  resumed.restore(snapshot);
  assert.equal(resumed.findReusable(specHash, null), null);
  assert.equal(resumed.view().checks[0]?.conclusion, 'passed', '保留历史结论用于追溯');
  assert.equal(resumed.view().checks[0]?.validity, 'version-unknown');

  const unknownVersion = createExecutionEvidenceStore();
  unknownVersion.restore({ ...snapshot, version: 999 });
  assert.equal(
    unknownVersion.snapshot().records.length,
    0,
    'unknown snapshot version must not restore',
  );

  // 伪造"没有来源的 passed"：缺 invocationId 的坏记录必须被丢弃
  const forged = normalizeEvidenceSnapshot({
    version: EVIDENCE_SNAPSHOT_VERSION,
    sequence: 3,
    records: [{ checkId: 'chk-x', conclusion: 'passed', executionState: 'settled' }],
    reads: [],
    mutations: [],
    pending: [],
  });
  assert.equal(forged.records.length, 0, 'record without provenance must be dropped');

  // 新 Run 不继承结论：即使会话历史被继承，事实存储是全新实例
  const nextRun = createExecutionEvidenceStore();
  nextRun.restore(undefined);
  assert.equal(nextRun.findReusable(specHash, null), null);
});

// ---- R05：变化即失效 ----
test('R05 输入闭包变化 → 复用失效；相同命令不等于相同检查', () => {
  const store = createExecutionEvidenceStore();
  const specHash = checkSpecDigest(processArgs, workspaceContext());
  const handle = store.getOrCreateInvocation('o1', { specHash, inputFingerprint: 'fp-a' });
  assert.ok(handle);
  store.recordResult(handle.invocationId, {
    ...processFacts(true),
    check: { profile: 'biome-lint', conclusion: 'passed', diagnostics: [], reportComplete: true },
  });

  assert.equal(store.findReusable(specHash, 'fp-a')?.conclusion, 'passed');
  assert.equal(store.findReusable(specHash, 'fp-b'), null, 'input closure change must invalidate');
  assert.equal(store.findReusable(specHash, null), null, 'unknown closure is not the same closure');
  assert.equal(store.findReusable(`${specHash}:adapter-v2`, 'fp-a'), null);
  store.invalidateCompleted('workspace_changed');
  assert.equal(store.findReusable(specHash, 'fp-a'), null);
  assert.equal(store.view().checks[0]?.validity, 'stale');
});

test('R02 真实进程：同参数脚本从 exit 0 改成 exit 1 必须重新执行', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'evidence-source-'));
  const previous = {
    attachment: process.env.PAYASO_ATTACHMENT_STORE,
    gate: process.env.PAYASO_SHELL_UNSANDBOXED,
    path: process.env.PATH,
  };
  process.env.PAYASO_ATTACHMENT_STORE = path.join(root, 'attachments');
  process.env.PAYASO_SHELL_UNSANDBOXED = '1';
  process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
  let executions = 0;
  registerCheckTool({
    ...checkTool,
    execute: (args, ctx) => {
      executions++;
      return executeCheck(args, ctx, { platform: 'linux' });
    },
  });
  try {
    const store = createExecutionEvidenceStore();
    const args = { profile: 'process', program: 'node', args: ['case.cjs'] };
    writeFileSync(path.join(root, 'case.cjs'), 'process.exit(0);');
    await runCheckThroughManager(store, args, 'first', root);
    assert.equal(store.view().checks[0]?.conclusion, 'passed');
    writeFileSync(path.join(root, 'case.cjs'), 'process.exit(1);');
    const output = await runCheckThroughManager(store, args, 'second', root);
    assert.equal(executions, 2);
    assert.doesNotMatch(output.join('\n'), /check-reused/);
    assert.equal(store.view().checks[0]?.conclusion, 'failed');
  } finally {
    registerCheckTool();
    if (previous.attachment === undefined) delete process.env.PAYASO_ATTACHMENT_STORE;
    else process.env.PAYASO_ATTACHMENT_STORE = previous.attachment;
    if (previous.gate === undefined) delete process.env.PAYASO_SHELL_UNSANDBOXED;
    else process.env.PAYASO_SHELL_UNSANDBOXED = previous.gate;
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    rmSync(root, { recursive: true, force: true });
  }
});

test('R05 已验证指纹：相同版本复用，执行期间变化或日志缺失则重跑', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'evidence-verified-'));
  const store = createExecutionEvidenceStore();
  let fingerprint = 'v1';
  let executions = 0;
  const args = { profile: 'biome-lint', paths: ['a.css'] };
  mkdirSync(path.join(root, 'input/spill'), { recursive: true });
  writeFileSync(path.join(root, 'input/spill/run.log'), 'complete report');
  registerCheckTool({
    ...checkTool,
    getEvidenceFingerprint: () => fingerprint,
    execute: async () => {
      executions++;
      if (executions === 3) fingerprint = 'changed-during-execution';
      return {
        content: 'fixture report',
        facts: {
          ...processFacts(true),
          version: 1,
          check: {
            profile: 'biome-lint',
            conclusion: 'passed',
            diagnostics: [],
            reportComplete: true,
          },
        },
      };
    },
  });
  try {
    await runCheckThroughManager(store, args, 'one', root);
    assert.equal(store.view().checks[0]?.validity, 'verified');
    const cached = await runCheckThroughManager(store, args, 'two', root);
    assert.match(cached.join('\n'), /check-reused/);
    assert.equal(executions, 1);
    rmSync(path.join(root, 'input/spill/run.log'));
    const noLog = await runCheckThroughManager(store, args, 'three', root);
    assert.doesNotMatch(noLog.join('\n'), /check-reused/);
    assert.equal(executions, 2, '日志不可访问时不得复用');
    fingerprint = 'v2';
    await runCheckThroughManager(store, args, 'four', root);
    assert.equal(executions, 3);
    assert.equal(store.view().checks[0]?.validity, 'stale', '前后指纹不同不得确认当前版本');
    writeFileSync(path.join(root, 'input/spill/run.log'), 'complete report');
    await runCheckThroughManager(store, args, 'five', root);
    const beforeDisabled = executions;
    await runCheckThroughManager(store, args, 'sdk-disabled', root, { checkReuse: false });
    assert.equal(executions, beforeDisabled + 1, 'SDK 开关关闭复用，但仍记录事实');
    const previousReuse = process.env.PAYASO_CHECK_REUSE;
    try {
      process.env.PAYASO_CHECK_REUSE = 'off';
      await runCheckThroughManager(store, args, 'env-disabled', root);
      assert.equal(executions, beforeDisabled + 2, '环境开关关闭复用');
    } finally {
      if (previousReuse === undefined) delete process.env.PAYASO_CHECK_REUSE;
      else process.env.PAYASO_CHECK_REUSE = previousReuse;
    }
  } finally {
    registerCheckTool();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 容量与不可淘汰规则 ----
test('容量：检查记录有界，未决/uncertain/当前迭代的记录不被淘汰', () => {
  const store = createExecutionEvidenceStore();
  store.setIteration(1);
  // 全部填成"uncertain"：不可淘汰 → 拒绝新检查
  for (let i = 0; i < MAX_CHECK_RECORDS; i += 1) {
    const handle = store.getOrCreateInvocation(`o${i}`, { specHash: `s${i}` });
    assert.ok(handle, `invocation ${i} must be allocated`);
    store.recordUncertain(handle.invocationId, 'check_failed');
  }
  const refused = store.getOrCreateInvocation('overflow', { specHash: 'overflow' });
  assert.equal(
    refused,
    null,
    'no evictable record → refuse new check instead of dropping evidence',
  );

  // 全部已结算且属于旧迭代 → 可 LRU 淘汰，容量不增长
  const settled = createExecutionEvidenceStore();
  settled.setIteration(1);
  for (let i = 0; i < MAX_CHECK_RECORDS; i += 1) {
    const handle = settled.getOrCreateInvocation(`o${i}`, { specHash: `s${i}` });
    assert.ok(handle);
    settled.recordResult(handle.invocationId, processFacts(true));
  }
  settled.setIteration(5);
  const extra = settled.getOrCreateInvocation('o-extra', { specHash: 's-extra' });
  assert.ok(extra, 'settled old-iteration records are evictable');
  assert.ok(settled.snapshot().records.length <= MAX_CHECK_RECORDS);
});

// ---- 身份：invocationId 为权威身份，参数摘要只作为检查对象 ----
test('身份：注入 invocationId 后操作身份随调用变化；无注入时退化为检查对象摘要', () => {
  const base = workspaceContext();
  const withA = checkOperationKeyOf(processArgs, { ...base, invocationId: 'inv-1' });
  const withB = checkOperationKeyOf(processArgs, { ...base, invocationId: 'inv-2' });
  assert.notEqual(withA, withB, 'distinct invocations must be distinct side-effect identities');
  const withoutInjection = checkOperationKeyOf(processArgs, base);
  assert.equal(withoutInjection, checkSpecDigest(processArgs, base), 'fallback keeps old behavior');
});

function checkOperationKeyOf(args: Record<string, unknown>, context: ToolContext): string {
  // 通过工具声明读取（避免测试重复实现），与 Runtime 使用同一条路径。
  return checkTool.getOperationKey?.(args, context) ?? '';
}

function workspaceContext(): ToolContext {
  return { runId: 'evidence-test', workspaceRoot: process.cwd() };
}

/** 端到端：通过 process-manager 处理一次 check 调用，返回 pushed 的 tool 消息文本。 */
async function runCheckThroughManager(
  store: ReturnType<typeof createExecutionEvidenceStore>,
  args: Record<string, unknown>,
  origin: string,
  workspaceRoot?: string,
  options: Pick<ToolContext, 'checkReuse'> = {},
): Promise<string[]> {
  const root = workspaceRoot ?? mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
  const messages: { role: string; tool_call_id?: string; content: string }[] = [];
  const state = createState('evidence', 'evidence-run');
  const emitted: TraceEventInput[] = [];
  try {
    await invokeToolCall(
      {
        runId: 'evidence-run',
        toolContext: {
          ...options,
          runId: 'evidence-run',
          workspaceRoot: root,
          permissionMode: 'workspace-write',
          networkMode: 'on',
        },
        messages: messages as never,
        state,
        scratchpad: createScratchpad('evidence'),
        sideEffectGuard: createSideEffectGuard(),
        contextHarness: {} as never,
        signal: undefined,
        approvalPort: undefined,
        toolchainPreparationPort: undefined,
        emit: (event) => emitted.push(event),
        save: () => {},
        observer: { log: () => {}, ...{} } as never,
        observeState: () => {},
        observeScratchpad: () => {},
        pushToolCallError: () => {},
        evidenceStore: store,
        toolCallOrigin: origin,
      },
      {
        id: `call-${origin}`,
        function: { name: 'check', arguments: JSON.stringify(args) },
      },
    );
  } finally {
    if (!workspaceRoot) rmSync(root, { recursive: true, force: true });
  }
  return messages.map((message) => message.content ?? '');
}

// ---- runner ----
test('行覆盖：真实 Run 的整文件读取后，换成五个切片重读均不是新增', () => {
  const store = createExecutionEvidenceStore();
  const read = (start: number, end: number, version = 'unchanged') =>
    store.recordReads(
      readFacts({
        kind: 'file',
        path: 'web/src/components/InputBar/index.tsx',
        versionKind: 'content',
        version,
        returnedRanges: [{ startLine: start, endLine: end }],
        returnedText: `same file lines ${start}-${end}`,
        complete: false,
      }).reads ?? [],
    );
  assert.equal(read(1, 334), 1);
  assert.equal(read(335, 644), 1);
  assert.equal(read(645, 812), 1);
  for (const [start, end] of [
    [1, 120],
    [121, 300],
    [301, 460],
    [460, 579],
    [580, 812],
    [57, 126],
  ]) {
    assert.equal(read(start, end), 0, `${start}-${end} 已被此前读取覆盖`);
  }
  assert.deepEqual(store.snapshot().reads[0]?.returnedRanges, [{ startLine: 1, endLine: 812 }]);
  const resumed = createExecutionEvidenceStore();
  resumed.restore(store.snapshot());
  assert.equal(
    resumed.recordReads(
      readFacts({
        kind: 'file',
        path: 'web/src/components/InputBar/index.tsx',
        versionKind: 'content',
        version: 'unchanged',
        returnedRanges: [{ startLine: 3, endLine: 5 }],
        returnedText: 'different slice',
        complete: false,
      }).reads ?? [],
    ),
    0,
    '恢复后仍保留覆盖区间',
  );
  assert.equal(read(3, 5, 'changed'), 1, '版本变化才重新记作新读取');
});

test('行覆盖：部分重叠、空洞、不同文件与旧版记录都保守处理', () => {
  const store = createExecutionEvidenceStore();
  const fact = (path: string, start: number, end: number) => ({
    kind: 'file',
    path,
    versionKind: 'content',
    version: 'v1',
    returnedHash: `${start}-${end}`,
    returnedRanges: [{ startLine: start, endLine: end }],
    complete: false,
  });
  assert.equal(store.recordReads([fact('a.ts', 1, 10), fact('a.ts', 20, 30)]), 2);
  assert.equal(store.recordReads([fact('a.ts', 8, 22)]), 1, '间隙中的新行不可丢失');
  assert.equal(store.recordReads([fact('a.ts', 4, 25)]), 0);
  assert.equal(store.recordReads([fact('b.ts', 4, 25)]), 1, '不同文件不共用覆盖');
  const snapshot = store.snapshot();
  const old = createExecutionEvidenceStore();
  old.restore({
    ...snapshot,
    reads: snapshot.reads.map(({ returnedRanges: _ranges, kind: _kind, ...read }) => read),
  });
  assert.equal(old.recordReads([fact('a.ts', 4, 25)]), 1, '旧快照没有行区间，不猜测覆盖');
});

for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${(error as Error).message}`);
  }
}

console.log(`\n${'='.repeat(56)}`);
console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exitCode = 1;
