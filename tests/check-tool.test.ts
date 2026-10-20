// 套件: check 工具（批次 B · 计划 §5 / §11.2 用例 C01-C06）
// 用法: npx tsx tests/check-tool.test.ts
//
// 验收（确定性、无网络、只用 node 子进程 fixture + mkdtemp 临时工作区）：
//   C01 24 PASS/1 FAIL 且 exit 1 → check=failed；展示截断不改变状态；结果不由 tail 决定
//   C02 argv 含空格/引号/分号/管道/$ → 原样到子进程，不产生额外命令或文件
//   C03 缺程序 / 沙箱拒绝 / 超时 / 取消 → 分类正确、无通过记录、进程树停止、uncertain 保持
//   C04 输出 >旧底层预算(64KiB) 且 <8MiB → 完整日志可读、JSON 可解析、模型文本符合统一预算
//   C05 超采集上限 / 日志发布失败 / JSON 缺字段 → inconclusive 或不可复用，绝不零诊断
//   C06 旧字符串 / 图片 ToolResult 兼容，不凭空 passed
//
// 执行载体：本套件用 platform 注入走「受控无沙箱门控」路径（PAYASO_SHELL_UNSANDBOXED=1），
// 真实跑子进程与整树终止；darwin 的 Seatbelt 分支只验证 fail-closed 拒绝（本机 sandbox-exec
// 若可用则跳过）。Windows ACL 只做 argv 分发断言 —— 本机 mock 只证明参数与分发。
//
// 注意：本批次按 §11.1 不把 check 暴露给真实模型（工具声明 hidden=true），
// 所以这里用 executeCheck(args, context, deps) 直接驱动同一套执行路径。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXECUTION_EVIDENCE_VERSION,
  isStableDiagnosticFingerprint,
  isWorkspaceRelativePath,
  MAX_DIAGNOSTICS_PER_RECORD,
  MAX_MUTATION_FACTS_PER_RECORD,
  MAX_READ_FACTS_PER_RECORD,
  readCheckConclusion,
  type ToolFacts,
  validateToolFacts,
} from '../src/execution-evidence.js';
import { probeSandboxAvailability } from '../src/sandbox/macos-sandbox.js';
import { buildWindowsAclRunnerArgv } from '../src/sandbox/windows-acl-sandbox.js';
import { resolveToolOutputBudget, utf8ByteLength } from '../src/tool-output-budget.js';
import {
  checkOperationKey,
  checkTool,
  executeCheck,
  normalizeCheckArgs,
  registerCheckTool,
} from '../src/tools/check.js';
import {
  CHECK_LOG_CAPTURE_MAX_BYTES,
  CHECK_REPORT_KIND,
  parseCheckReport,
} from '../src/tools/check-runner.js';
import {
  execute as executeTool,
  getSchemas,
  getTool,
  normalizeToolResult,
  register,
  type ToolContext,
  type ToolResult,
} from '../src/tools/tools.js';

// ---- 临时工作区与 fixture ----

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-check-'));
const WORKSPACE = path.join(TEST_ROOT, 'ws');
fs.mkdirSync(WORKSPACE, { recursive: true });
process.env.SANDBOX_ROOT = path.join(TEST_ROOT, 'sandbox-root');
process.env.PAYASO_ATTACHMENT_STORE = path.join(TEST_ROOT, 'attachment-store');
// 受控无沙箱门控：本套件的平台注入路径需要它（真实 Seatbelt 分支单独验证拒绝）。
process.env.PAYASO_SHELL_UNSANDBOXED = '1';
// 让 fixture 里的 `node` 解析到当前跑测的同一颗 node，不依赖跑测机 PATH 顺序。
process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;

const RUNNER_DEPS = { platform: 'linux' as NodeJS.Platform };

function fixture(fileName: string, source: string): string {
  const abs = path.join(WORKSPACE, 'fixtures', fileName);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `#!/usr/bin/env node\n${source}`);
  return `fixtures/${fileName}`;
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: `check-run-${process.pid}`,
    workspaceRoot: WORKSPACE,
    permissionMode: 'workspace-write',
    ...overrides,
  };
}

function requireFacts(result: ToolResult): ToolFacts {
  const facts = normalizeToolResult(result).facts;
  assert.ok(facts, 'check 结果必须带 facts');
  return facts;
}

function readPublishedLog(ref: string | undefined, label = 'stdout'): string {
  assert.ok(ref, `必须发布 ${label} 完整日志引用`);
  assert.ok(isWorkspaceRelativePath(ref), `${label} 引用必须是工作区相对路径`);
  const file = path.join(WORKSPACE, ref);
  assert.ok(fs.existsSync(file), `日志文件必须存在: ${ref}`);
  return fs.readFileSync(file, 'utf8');
}

/** 解析模型可见文本首行的 JSON 摘要。 */
function summaryOf(text: string): Record<string, unknown> {
  const first = text.split('\n')[0];
  return JSON.parse(first) as Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/** 心跳文件必须停止增长（证明整树终止，而不只是直接子进程）。 */
async function assertStopsGrowing(file: string, withinMs = 6_000): Promise<void> {
  let last = -1;
  let stable = 0;
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    await sleep(200);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size === last) {
      stable++;
      if (stable >= 3) return;
    } else {
      stable = 0;
      last = size;
    }
  }
  throw new Error(`进程树未停止：${file} 仍在增长`);
}

// ---- 套件 runner ----

interface Case {
  name: string;
  fn: () => void | Promise<void>;
}
const cases: Case[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  cases.push({ name, fn });
}

// ============================ C01 ============================

const FAIL_MARKER = 'FAIL the-real-one';

const manyPassOneFail = fixture(
  'many-pass-one-fail.js',
  `
  const fs = require('node:fs');
  fs.appendFileSync('runs.count', 'x');
  for (let i = 1; i <= 24; i++) console.log('PASS case-' + i);
  // 把唯一失败行推到 20KB 之后：模型可见切片（head+tail）必然看不到它，
  // 但结论必须仍然是 failed —— 展示截断不改变状态。
  console.log('PAD ' + 'p'.repeat(1024));
  for (let i = 0; i < 18; i++) console.log('PAD ' + 'p'.repeat(1024));
  console.log('${FAIL_MARKER} expected 1 got 0');
  for (let i = 0; i < 12; i++) console.log('PAD ' + 'p'.repeat(1024));
  console.error('stderr line for stream separation');
  process.exit(1);
  `,
);

test('C01 24 PASS / 1 FAIL 且 exit 1 → check=failed（工具本身成功）', async () => {
  const result = await executeCheck(
    { profile: 'process', program: 'node', args: [manyPassOneFail], cwd: '.' },
    context(),
    RUNNER_DEPS,
  );
  const normalized = normalizeToolResult(result);
  const facts = requireFacts(result);
  assert.equal(facts.version, EXECUTION_EVIDENCE_VERSION);
  assert.equal(facts.check?.profile, 'process');
  assert.equal(facts.check?.conclusion, 'failed');
  assert.equal(facts.process?.exitCode, 1);
  assert.equal(facts.process?.timedOut, false);
  assert.equal(facts.process?.logsComplete, true, '未超 8MiB → 完整日志');
  // 没有结构化报告 ≠ 零诊断：未取得的诊断必须是 null（§5.3）
  assert.equal(facts.check?.diagnostics, null);
  assert.equal(readCheckConclusion(facts), 'failed');
  assert.equal(summaryOf(normalized.text).conclusion, 'failed');
});

test('C01 展示截断不改变状态：中间 FAIL 行不在模型文本里，结论仍 failed', async () => {
  const budget = resolveToolOutputBudget();
  const result = await executeCheck(
    { profile: 'process', program: 'node', args: [manyPassOneFail], cwd: '.' },
    context(),
    RUNNER_DEPS,
  );
  const normalized = normalizeToolResult(result);
  assert.ok(
    utf8ByteLength(normalized.text) <= budget.maxBytes,
    `模型文本必须落在统一预算内（${utf8ByteLength(normalized.text)} > ${budget.maxBytes}）`,
  );
  assert.ok(normalized.text.includes('[OUTPUT TRUNCATED]'), '超预算必须显式标记截断');
  assert.ok(!normalized.text.includes(FAIL_MARKER), '该用例的前提：中间那行 FAIL 被切片丢掉');
  assert.equal(normalized.facts?.check?.conclusion, 'failed', '截断不得改变检查状态');
});

test('C01 结果不由 tail 决定：一次调用只跑一个进程，完整日志各自可回读', async () => {
  const before = fs.existsSync(path.join(WORKSPACE, 'runs.count'))
    ? fs.statSync(path.join(WORKSPACE, 'runs.count')).size
    : 0;
  const result = await executeCheck(
    { profile: 'process', program: 'node', args: [manyPassOneFail], cwd: '.' },
    context(),
    RUNNER_DEPS,
  );
  const after = fs.statSync(path.join(WORKSPACE, 'runs.count')).size;
  assert.equal(after - before, 1, '不得为换 tail 切片重跑进程（单次执行）');
  const normalized = normalizeToolResult(result);
  const facts = requireFacts(result);
  const stdoutRef = facts.process?.stdoutRef;
  const stderrRef = facts.process?.stderrRef;
  assert.notEqual(stdoutRef, stderrRef, '两条流各自一份引用');
  const stdoutLog = readPublishedLog(stdoutRef, 'stdout');
  const stderrLog = readPublishedLog(stderrRef, 'stderr');
  assert.ok(stdoutLog.includes(FAIL_MARKER), '完整日志里失败行必须读得回来');
  assert.equal(stdoutLog.includes('stderr line for stream separation'), false, '两条流不得混合');
  assert.ok(stderrLog.includes('stderr line for stream separation'));
  assert.equal(normalized.facts?.check?.conclusion, 'failed');
});

// ============================ C02 ============================

const argvEcho = fixture(
  'argv-echo.js',
  `
  console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
  `,
);

test('C02 字面 argv：空格/引号/分号/管道/$ 原样到达子进程', async () => {
  const args = [
    argvEcho,
    'a b',
    'c"d',
    "e'f",
    'g;h',
    'i|j',
    '$HOME',
    '`backtick`',
    '&&',
    'x\ny',
    '中文 ✅',
    '*',
  ];
  const result = await executeCheck(
    { profile: 'process', program: 'node', args, cwd: '.' },
    context(),
    RUNNER_DEPS,
  );
  const facts = requireFacts(result);
  assert.equal(facts.check?.conclusion, 'passed');
  const stdoutLog = readPublishedLog(facts.process?.stdoutRef);
  const echoed = JSON.parse(stdoutLog.trim()) as { argv: string[]; cwd: string };
  assert.deepEqual(echoed.argv, args.slice(1), 'argv 必须逐项字面到达');
  assert.equal(fs.realpathSync(echoed.cwd), fs.realpathSync(WORKSPACE));
});

test('C02 不产生额外命令或文件（无 shell 参与）', async () => {
  const before = listFiles(WORKSPACE);
  await executeCheck(
    {
      profile: 'process',
      program: 'node',
      args: [argvEcho, 'evil;touch pwn-c02.txt', 'a|b touch pwn2.txt', '$(touch pwn3.txt)'],
      cwd: '.',
    },
    context(),
    RUNNER_DEPS,
  );
  const created = listFiles(WORKSPACE).filter(
    (file) => !before.includes(file) && !file.startsWith('input/spill/'),
  );
  assert.deepEqual(created, [], `不该出现额外文件：${created.join(', ')}`);
});

test('C02 解释器承载一律拒绝并回到 shell（sh/bash/zsh/cmd/powershell/pwsh）', () => {
  for (const program of [
    'sh',
    'bash',
    'zsh',
    '/bin/sh',
    'cmd',
    'cmd.exe',
    'powershell',
    'pwsh.exe',
    'BASH',
  ]) {
    const parsed = normalizeCheckArgs({ profile: 'process', program, args: ['-c', 'echo hi'] });
    assert.equal(parsed.ok, false, `应拒绝解释器承载: ${program}`);
    if (parsed.ok) continue;
    const codes = parsed.issues.map((issue) => issue.code);
    assert.ok(codes.includes('interpreter_carrier'), `${program} 应报 interpreter_carrier`);
    assert.match(parsed.issues[0].message, /shell 工具/);
  }
  // node 明确允许（计划 §5.1：支持通过 node 显式运行的 JS 入口）
  assert.equal(
    normalizeCheckArgs({ profile: 'process', program: 'node', args: ['x.js'] }).ok,
    true,
  );
  // .cmd/.bat 不是原生进程
  const bat = normalizeCheckArgs({ profile: 'process', program: 'run-tests.cmd', args: [] });
  assert.equal(bat.ok, false);
  if (!bat.ok) assert.ok(bat.issues.some((issue) => issue.code === 'unsupported_executable'));
});

// ============================ C03 ============================

const heartbeatRel = 'heartbeat.log';

const sleepyWithGrandchild = fixture(
  'sleepy-grandchild.js',
  `
  const { spawn } = require('node:child_process');
  console.log('started');
  const child = spawn(process.execPath, ['-e',
    'const fs=require("node:fs");setInterval(()=>fs.appendFileSync("${heartbeatRel}","tick"),100);'
  ], { stdio: 'inherit' });
  setTimeout(() => process.exit(0), 30000);
  `,
);

test('C03 缺程序 → 依赖缺失分类正确，不产生任何通过记录', async () => {
  const before = listFiles(WORKSPACE);
  await assert.rejects(
    () =>
      executeCheck(
        { profile: 'process', program: 'definitely-not-installed-check-xyz', args: [] },
        context(),
        RUNNER_DEPS,
      ),
    (err: unknown) => (err as Error).name === 'RequiredRuntimeToolUnavailableError',
  );
  assert.deepEqual(
    listFiles(WORKSPACE).filter((file) => !before.includes(file)),
    [],
    '缺程序不得留下任何执行痕迹',
  );
});

test('C03 受控无沙箱路径未开门 → 明确拒绝（fail-closed，无通过记录）', async () => {
  const previous = process.env.PAYASO_SHELL_UNSANDBOXED;
  delete process.env.PAYASO_SHELL_UNSANDBOXED;
  try {
    await assert.rejects(
      () =>
        executeCheck(
          { profile: 'process', program: 'node', args: [manyPassOneFail] },
          context(),
          RUNNER_DEPS,
        ),
      /PAYASO_SHELL_UNSANDBOXED/,
    );
  } finally {
    if (previous !== undefined) process.env.PAYASO_SHELL_UNSANDBOXED = previous;
  }
});

test('C03 darwin 默认路径：Seatbelt 不可用时拒绝跑无沙箱进程', async () => {
  if (process.platform !== 'darwin') {
    console.log('  [SKIP] 仅 darwin 验证 Seatbelt fail-closed 分支');
    return;
  }
  if (await probeSandboxAvailability()) {
    console.log('  [SKIP] 本机 Seatbelt 可用，拒绝路径由 os-sandbox 套件覆盖');
    return;
  }
  await assert.rejects(
    () => executeCheck({ profile: 'process', program: 'node', args: [argvEcho, 'x'] }, context()),
    /sandbox-exec|cannot be applied/,
  );
});

test('C03 超时 → inconclusive + timedOut，保留退出协议未知，整树停止', async () => {
  const heartbeat = path.join(WORKSPACE, heartbeatRel);
  if (fs.existsSync(heartbeat)) fs.rmSync(heartbeat);
  const result = await executeCheck(
    {
      profile: 'process',
      program: 'node',
      args: [sleepyWithGrandchild],
      cwd: '.',
      timeoutMs: 2_000,
    },
    context(),
    RUNNER_DEPS,
  );
  const facts = requireFacts(result);
  assert.equal(facts.check?.conclusion, 'inconclusive', '超时绝不是 passed/failed');
  assert.equal(facts.process?.timedOut, true);
  assert.equal(facts.process?.exitCode, null);
  assert.equal(facts.check?.diagnostics, null);
  const validation = validateToolFacts(facts);
  assert.equal(validation.reusable, false, 'uncertain 结果不能被复用');
  assert.equal(validation.mayClaimPassed, false);
  const stdoutLog = readPublishedLog(facts.process?.stdoutRef);
  assert.ok(stdoutLog.includes('started'), '超时前的输出仍必须完整可读');
  assert.ok(fs.existsSync(heartbeat), '孙进程应已写心跳，否则本用例没测到进程树');
  await assertStopsGrowing(heartbeat);
});

test('C03 取消 → 沿原取消路径 reject，不计失败也不生成通过记录', async () => {
  const heartbeat = path.join(WORKSPACE, heartbeatRel);
  if (fs.existsSync(heartbeat)) fs.rmSync(heartbeat);
  const spillDir = path.join(WORKSPACE, 'input', 'spill');
  const spillBefore = fs.existsSync(spillDir) ? fs.readdirSync(spillDir).sort() : [];
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);
  await assert.rejects(
    () =>
      executeCheck(
        { profile: 'process', program: 'node', args: [sleepyWithGrandchild], cwd: '.' },
        context({ signal: controller.signal }),
        RUNNER_DEPS,
      ),
    (err: unknown) => (err as DOMException).name === 'AbortError',
  );
  await assertStopsGrowing(heartbeat);
  const spillAfter = fs.existsSync(spillDir) ? fs.readdirSync(spillDir).sort() : [];
  assert.deepEqual(spillAfter, spillBefore, '取消路径不发布任何检查证据');
  const probe = normalizeToolResult(
    await executeCheck(
      { profile: 'process', program: 'node', args: [argvEcho, 'after-cancel'], cwd: '.' },
      context(),
      RUNNER_DEPS,
    ),
  );
  assert.equal(probe.facts?.check?.conclusion, 'passed', '取消不污染后续检查的结论');
});

// ============================ C04 ============================

const BIG_JSON_BYTES = 200_000;

const bigJson = fixture(
  'big-json.js',
  `
  const payload = { kind: 'tool-log', items: [] };
  const unit = { text: '中文与 emoji ✅ 也要按字节而非 UTF-16 单元保全'.repeat(4) };
  let bytes = 0;
  while (bytes < ${BIG_JSON_BYTES}) { payload.items.push(unit); bytes += unit.text.length; }
  const text = JSON.stringify(payload);
  console.log(text);
  `,
);

test('C04 输出 >旧底层预算(64KiB) 且 <8MiB → 完整日志可读且 JSON 可解析', async () => {
  const result = await executeCheck(
    { profile: 'process', program: 'node', args: [bigJson], cwd: '.' },
    context(),
    RUNNER_DEPS,
  );
  const facts = requireFacts(result);
  assert.equal(facts.process?.logsComplete, true);
  assert.equal(facts.check?.conclusion, 'passed');
  const log = readPublishedLog(facts.process?.stdoutRef);
  assert.ok(
    utf8ByteLength(log) > 64 * 1024,
    `日志必须超过旧底层 64KiB 预算（实际 ${utf8ByteLength(log)}）`,
  );
  const parsed = JSON.parse(log.trim()) as { items: Array<{ text: string }> };
  assert.ok(parsed.items.length > 100, 'JSON 完整可解析（没有被中间截断）');
  assert.ok(log.includes('✅'), 'UTF-8 多字节内容不得被切坏');
});

test('C04 模型可见文本仍符合统一 tool-output-budget', async () => {
  const budget = resolveToolOutputBudget();
  const result = await executeCheck(
    { profile: 'process', program: 'node', args: [bigJson], cwd: '.' },
    context(),
    RUNNER_DEPS,
  );
  const normalized = normalizeToolResult(result);
  assert.ok(
    utf8ByteLength(normalized.text) <= budget.maxBytes,
    `${utf8ByteLength(normalized.text)} > ${budget.maxBytes}`,
  );
  assert.ok(normalized.text.includes('[OUTPUT TRUNCATED]'));
  assert.ok(normalized.text.includes('input/spill/'), '文本必须给出完整日志的可读回地址');
});

// ============================ C05 ============================

const hugeOutput = fixture(
  'huge-output.js',
  `
  const line = 'L'.repeat(1024) + '\\n';
  // 超过 8MiB 采集上限：保留已采集内容，标记不完整，绝不伪装完整报告
  for (let i = 0; i < ${Math.ceil((CHECK_LOG_CAPTURE_MAX_BYTES * 1.3) / 1025)}; i++) process.stdout.write(line);
  console.error('tail-marker-after-overflow');
  `,
);

test('C05 超过采集上限 → logsComplete=false → inconclusive（不重跑换 tail）', async () => {
  const result = await executeCheck(
    { profile: 'process', program: 'node', args: [hugeOutput], cwd: '.' },
    context(),
    RUNNER_DEPS,
  );
  const normalized = normalizeToolResult(result);
  const facts = requireFacts(result);
  assert.equal(facts.process?.logsComplete, false, '采集超限必须如实标注');
  assert.equal(facts.check?.conclusion, 'inconclusive', '超限不伪装完整报告');
  assert.equal(facts.check?.diagnostics, null, '不得写成零诊断');
  const validation = validateToolFacts(facts);
  assert.equal(validation.reportComplete, false);
  assert.equal(validation.comparable, false);
  assert.equal(validation.reusable, false);
  assert.equal(validation.mayClaimPassed, false);
  const summary = summaryOf(normalized.text);
  assert.deepEqual(summary.reasons, ['capture-limit']);
  assert.equal(summary.processRuns, 1, '只跑一个进程');
  assert.equal(summary.exitCode, 0, '采集超限不丢退出码');
  const log = readPublishedLog(facts.process?.stdoutRef);
  assert.ok(utf8ByteLength(log) >= CHECK_LOG_CAPTURE_MAX_BYTES - 4096, '已采集部分仍需保留');
});

test('C05 日志发布失败 → 保留退出码但结论 inconclusive 且禁止复用', async () => {
  const result = await executeCheck(
    { profile: 'process', program: 'node', args: [argvEcho, 'publish-fail'], cwd: '.' },
    context(),
    { ...RUNNER_DEPS, publishLog: () => null },
  );
  const facts = requireFacts(result);
  assert.equal(facts.process?.exitCode, 0, '发布失败不丢退出码');
  assert.equal(facts.process?.logsComplete, false);
  assert.equal(facts.check?.conclusion, 'inconclusive');
  assert.equal(facts.process?.stdoutRef, undefined);
  const validation = validateToolFacts(facts);
  assert.equal(validation.reusable, false, '缺少完整证据时禁止复用');
});

const reportMissingField = fixture(
  'report-missing-field.js',
  `
  console.log(JSON.stringify({ kind: '${CHECK_REPORT_KIND}', version: 1, profile: 'process' }));
  `,
);

test('C05 JSON 缺字段 → inconclusive + diagnostics=null（绝不零诊断/通过）', async () => {
  const result = await executeCheck(
    { profile: 'process', program: 'node', args: [reportMissingField], cwd: '.' },
    context(),
    RUNNER_DEPS,
  );
  const facts = requireFacts(result);
  assert.equal(facts.check?.conclusion, 'inconclusive');
  assert.equal(facts.check?.diagnostics, null);
  assert.equal(facts.check?.reportComplete, false);
  assert.equal(validateToolFacts(facts).mayClaimPassed, false);
  assert.equal(facts.process?.exitCode, 0, '退出码仍如实保留');
});

test('C05 报告自称通过但进程非 0 退出 → 矛盾即 inconclusive', async () => {
  const contradict = fixture(
    'report-passed-exit-1.js',
    `
    console.log(JSON.stringify({
      kind: '${CHECK_REPORT_KIND}', version: 1, profile: 'process',
      conclusion: 'passed', diagnostics: [], reportComplete: true,
    }));
    process.exit(1);
    `,
  );
  const result = await executeCheck(
    { profile: 'process', program: 'node', args: [contradict], cwd: '.' },
    context(),
    RUNNER_DEPS,
  );
  const facts = requireFacts(result);
  assert.equal(facts.check?.conclusion, 'inconclusive');
  assert.equal(validateToolFacts(facts).mayClaimPassed, false);
});

test('C05 parseCheckReport 纯函数：缺字段/非法诊断/超容量都 fail-closed', () => {
  assert.deepEqual(parseCheckReport('PASS case-1\nFAIL x\n'), { state: 'absent' });
  assert.equal(
    parseCheckReport(JSON.stringify({ kind: CHECK_REPORT_KIND, version: 2 })).state,
    'invalid',
  );
  assert.equal(
    parseCheckReport(JSON.stringify({ kind: CHECK_REPORT_KIND, version: 1, profile: 'process' }))
      .state,
    'invalid',
  );
  const withDiagnostic = parseCheckReport(
    JSON.stringify({
      kind: CHECK_REPORT_KIND,
      version: 1,
      profile: 'biome-lint',
      conclusion: 'failed',
      reportComplete: true,
      diagnostics: [
        {
          path: 'src/a.css',
          rule: 'css/useGlobal',
          severity: 'error',
          message: 'm',
          primarySnippet: 'a{}',
          relatedSnippets: [],
          fingerprint: 'f'.repeat(16),
        },
      ],
    }),
  );
  assert.equal(withDiagnostic.state, 'valid');
  // 行号式 fingerprint 不合格（逻辑路径 + 规则 + 片段摘要，不含临时绝对路径/行号）
  const volatile = parseCheckReport(
    JSON.stringify({
      kind: CHECK_REPORT_KIND,
      version: 1,
      profile: 'biome-lint',
      conclusion: 'failed',
      reportComplete: true,
      diagnostics: [
        {
          path: '/private/tmp/x/src/a.css',
          rule: 'css/useGlobal',
          severity: 'error',
          message: 'm',
          primarySnippet: 'a{}',
          relatedSnippets: [],
          fingerprint: 'src/a.css:12:7',
        },
      ],
    }),
  );
  assert.equal(volatile.state, 'invalid');
  // 超容量：保留有界切片 + reportComplete=false
  const many = Array.from({ length: MAX_DIAGNOSTICS_PER_RECORD + 5 }, (_unused, index) => ({
    path: `src/f${index}.css`,
    rule: 'r',
    severity: 'error',
    message: 'm',
    primarySnippet: 'x',
    relatedSnippets: [],
    fingerprint: `fp${index}`,
  }));
  const over = parseCheckReport(
    JSON.stringify({
      kind: CHECK_REPORT_KIND,
      version: 1,
      profile: 'biome-lint',
      conclusion: 'failed',
      reportComplete: true,
      diagnostics: many,
    }),
  );
  assert.equal(over.state, 'valid');
  if (over.state === 'valid') {
    assert.equal(over.diagnostics?.length, MAX_DIAGNOSTICS_PER_RECORD);
    assert.equal(over.overCapacity, true);
    assert.equal(over.reportComplete, false);
  }
});

test('C05 有效报告零诊断可以成立：[] 与 null 不互换', async () => {
  const cleanReport = fixture(
    'report-clean.js',
    `
    console.log(JSON.stringify({
      kind: '${CHECK_REPORT_KIND}', version: 1, profile: 'process',
      conclusion: 'passed', diagnostics: [], reportComplete: true,
    }));
    `,
  );
  const result = await executeCheck(
    { profile: 'process', program: 'node', args: [cleanReport], cwd: '.' },
    context(),
    RUNNER_DEPS,
  );
  const facts = requireFacts(result);
  assert.deepEqual(facts.check?.diagnostics, []);
  assert.equal(facts.check?.conclusion, 'passed');
  assert.equal(validateToolFacts(facts).mayClaimPassed, true);
});

test('C05 静默失败（无输出 + 非 0 退出）→ failed 且没有日志引用', async () => {
  const quietFail = fixture('quiet-fail.js', 'process.exit(3);');
  const result = await executeCheck(
    { profile: 'process', program: 'node', args: [quietFail], cwd: '.' },
    context(),
    RUNNER_DEPS,
  );
  const facts = requireFacts(result);
  assert.equal(facts.process?.exitCode, 3);
  assert.equal(facts.check?.conclusion, 'failed');
  assert.equal(facts.process?.stdoutRef, undefined);
  assert.ok(normalizeToolResult(result).text.includes('[进程无输出]'));
});

// ============================ C06 + 参数契约 + 消费规则 ============================

test('C06 旧字符串 ToolResult 完全兼容（normalize 不带 facts）', () => {
  const normalized = normalizeToolResult('plain legacy text');
  assert.deepEqual(normalized, { text: 'plain legacy text' });
  assert.equal('facts' in normalized, false);
  assert.equal(readCheckConclusion(undefined), null, '没有 facts = 未知');
  assert.equal(readCheckConclusion('[shell-exit-0]'), null);
  assert.equal(validateToolFacts(undefined).mayClaimPassed, false);
});

test('C06 旧文本+图片 ToolResult 兼容（不凭空新增 passed）', async () => {
  register({
    name: 'legacyVisionProbe',
    description: '测试用：返回文本+图片的旧形状结果',
    effect: 'read',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({
      content: 'read image ok',
      images: [{ mimeType: 'image/png', path: 'a.png' }],
    }),
  });
  const result = await executeTool('legacyVisionProbe', {}, context());
  const normalized = normalizeToolResult(result);
  assert.equal(normalized.text, 'read image ok');
  assert.deepEqual(normalized.images, [{ mimeType: 'image/png', path: 'a.png' }]);
  assert.equal(normalized.facts, undefined);
  assert.equal(readCheckConclusion(normalized.facts), null);
});

test('C06 对象结果带 facts 时透传，不带时保持未知', () => {
  const withFacts = normalizeToolResult({
    content: 'x',
    facts: {
      version: EXECUTION_EVIDENCE_VERSION,
      check: {
        profile: 'process',
        conclusion: 'passed',
        diagnostics: [],
        reportComplete: true,
      },
    },
  });
  assert.equal(withFacts.facts?.check?.conclusion, 'passed');
  const withoutFacts = normalizeToolResult({ content: 'x' });
  assert.equal(withoutFacts.facts, undefined);
});

test('消费规则：容量与不完整报告（128/32/16）', () => {
  const diagnostics = Array.from({ length: MAX_DIAGNOSTICS_PER_RECORD + 3 }, (_u, i) => ({
    path: `src/f${i}.css`,
    rule: 'r',
    severity: 'error',
    message: 'm',
    primarySnippet: 'x',
    relatedSnippets: [],
    fingerprint: `fp${i}`,
  }));
  const reads = Array.from({ length: MAX_READ_FACTS_PER_RECORD + 2 }, (_u, i) => ({
    kind: 'file',
    path: `src/r${i}.ts`,
    versionKind: 'content',
    version: 'v',
    returnedRanges: [{ startLine: 1, endLine: 2 }],
    returnedHash: 'h',
    complete: true,
  }));
  const mutations = Array.from({ length: MAX_MUTATION_FACTS_PER_RECORD + 1 }, (_u, i) => ({
    path: `src/m${i}.ts`,
    beforeHash: null,
    afterHash: 'h',
  }));
  const validation = validateToolFacts({
    version: EXECUTION_EVIDENCE_VERSION,
    check: { profile: 'process', conclusion: 'failed', diagnostics, reportComplete: true },
    reads,
    mutations,
  });
  assert.equal(validation.valid, true);
  assert.equal(validation.reportComplete, false, '超容量 → 报告不完整');
  assert.equal(validation.comparable, false, '超容量 → 禁止比较');
  assert.equal(validation.reusable, false, '超容量 → 禁止复用');
  assert.equal(validation.facts?.check?.diagnostics?.length, MAX_DIAGNOSTICS_PER_RECORD);
  assert.equal(validation.facts?.reads?.length, MAX_READ_FACTS_PER_RECORD);
  assert.equal(validation.facts?.mutations?.length, MAX_MUTATION_FACTS_PER_RECORD);
});

test('消费规则：未知版本/宿主绝对路径/行号指纹都不产生通过事实', () => {
  assert.equal(validateToolFacts({ version: 2, check: {} }).valid, false);
  assert.equal(validateToolFacts('passed').valid, false);
  assert.equal(
    validateToolFacts({
      version: EXECUTION_EVIDENCE_VERSION,
      check: { profile: 'process', conclusion: 'passed', diagnostics: [], reportComplete: true },
      process: {
        exitCode: 0,
        timedOut: false,
        logsComplete: true,
        stdoutRef: '/etc/passwd',
      },
    }).valid,
    false,
  );
  assert.equal(isWorkspaceRelativePath('../escape.ts'), false);
  assert.equal(isWorkspaceRelativePath('C:\\work\\a.ts'), false);
  assert.equal(isStableDiagnosticFingerprint('src/a.css:12:7'), false);
  assert.equal(isStableDiagnosticFingerprint('/private/tmp/a'), false);
  assert.equal(isStableDiagnosticFingerprint('8f14e45fceea167a'), true);
});

test('参数契约：profile 互斥与必填（process 禁 paths/baseline，biome-lint 仅 CSS）', () => {
  const missing = normalizeCheckArgs({ profile: 'process' });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    const codes = missing.issues.map((issue) => issue.code);
    assert.ok(codes.includes('missing_argument'));
  }
  const mutex = normalizeCheckArgs({
    profile: 'process',
    program: 'node',
    args: [],
    paths: ['a.css'],
    baseline: 'HEAD',
  });
  assert.equal(mutex.ok, false);
  if (!mutex.ok) {
    const codes = mutex.issues.map((issue) => issue.code);
    assert.ok(codes.includes('mutually_exclusive'));
  }
  const lintMutex = normalizeCheckArgs({
    profile: 'biome-lint',
    paths: ['a.css'],
    program: 'node',
    args: ['x'],
  });
  assert.equal(lintMutex.ok, false);
  if (!lintMutex.ok) {
    const codes = lintMutex.issues.map((issue) => issue.code);
    assert.equal(codes.filter((code) => code === 'mutually_exclusive').length, 2);
  }
  const notCss = normalizeCheckArgs({ profile: 'biome-lint', paths: ['src/a.ts'] });
  assert.equal(notCss.ok, false);
  if (!notCss.ok) assert.ok(notCss.issues.some((issue) => issue.code === 'unsupported_file_type'));
  const lintOk = normalizeCheckArgs({ profile: 'biome-lint', paths: ['src/a.css'] });
  assert.equal(lintOk.ok, true);
  const unknownKey = normalizeCheckArgs({
    profile: 'process',
    program: 'node',
    args: [],
    shell: 'x',
  });
  assert.equal(unknownKey.ok, false);
  if (!unknownKey.ok) {
    assert.ok(unknownKey.issues.some((issue) => issue.code === 'unknown_argument'));
  }
  const absoluteProgram = normalizeCheckArgs({
    profile: 'process',
    program: '/bin/echo',
    args: ['hi'],
  });
  assert.equal(absoluteProgram.ok, false);
  const absoluteCwd = normalizeCheckArgs({
    profile: 'process',
    program: 'node',
    args: [],
    cwd: '/etc',
  });
  assert.equal(absoluteCwd.ok, false);
});

test('超时沿用 Shell 解析与上限（越界被收敛，非法值回落默认）', () => {
  const huge = normalizeCheckArgs({
    profile: 'process',
    program: 'node',
    args: [],
    timeoutMs: 999_999_999,
  });
  assert.equal(huge.ok, true);
  if (huge.ok && huge.profile === 'process') {
    assert.equal(huge.timeoutMs, 600_000, 'Shell 上限 600s');
    assert.ok(huge.timeoutMs >= 1_000);
  }
  const tiny = normalizeCheckArgs({ profile: 'process', program: 'node', args: [], timeoutMs: 1 });
  assert.equal(tiny.ok, true);
  if (tiny.ok && tiny.profile === 'process') assert.equal(tiny.timeoutMs, 1_000);
  const defaultish = normalizeCheckArgs({ profile: 'process', program: 'node', args: [] });
  assert.equal(defaultish.ok, true);
  if (defaultish.ok && defaultish.profile === 'process')
    assert.equal(defaultish.timeoutMs, 120_000);
});

test('biome-lint 分支返回未实现结论，不静默降级', async () => {
  const result = await executeCheck(
    { profile: 'biome-lint', paths: ['src/a.css'], baseline: 'HEAD' },
    context(),
    RUNNER_DEPS,
  );
  const normalized = normalizeToolResult(result);
  const summary = summaryOf(normalized.text);
  // 批次 D 已实现 biome-lint：临时工作区没有安装受支持的 Biome → 明确 unsupported，
  // 仍然绝不产生通过事实（B03：不能把"没跑"当成"零告警"）。
  assert.equal(summary.conclusion, 'inconclusive');
  assert.equal(summary.comparison, 'unknown');
  assert.equal(summary.reason, 'biome_not_installed');
  assert.equal(normalized.facts?.check?.diagnostics, null);
  assert.equal(normalized.facts?.check?.reportComplete, false);
  assert.equal(validateToolFacts(normalized.facts).mayClaimPassed, false);
});

test('批次 B 不暴露给真实模型：check 已注册但 hidden，且声明非幂等 + 网络同 shell', () => {
  registerCheckTool();
  assert.equal(getTool('check')?.name, 'check');
  assert.equal(checkTool.effect, 'non_idempotent');
  assert.equal(checkTool.capabilities?.network, true);
  assert.equal(typeof checkTool.getOperationKey, 'function');
  assert.equal(
    getSchemas().some((schema) => schema.function.name === 'check'),
    false,
    '§11.1：接入期间不暴露给真实模型',
  );
});

test('过渡版 getOperationKey：规范化 profile/program/args/cwd/paths，不含宿主绝对路径', () => {
  const ctx = context();
  const base = checkOperationKey(
    { profile: 'process', program: 'node', args: ['x.js'], cwd: '.' },
    ctx,
  );
  const withDotSlash = checkOperationKey(
    { profile: 'process', program: 'node', args: ['x.js'], cwd: './' },
    ctx,
  );
  assert.equal(base, withDotSlash, 'cwd 归一化后同一操作');
  const otherArgs = checkOperationKey(
    { profile: 'process', program: 'node', args: ['y.js'], cwd: '.' },
    ctx,
  );
  assert.notEqual(base, otherArgs);
  const otherTimeout = checkOperationKey(
    { profile: 'process', program: 'node', args: ['x.js'], cwd: '.', timeoutMs: 5_000 },
    ctx,
  );
  assert.equal(base, otherTimeout, '换超时仍是同一次检查');
  assert.ok(!base.includes(WORKSPACE), 'key 不得泄漏宿主绝对路径');
  const lint = checkOperationKey(
    { profile: 'biome-lint', paths: ['src/b.css', 'src/a.css', 'src/a.css'] },
    ctx,
  );
  const lintSorted = checkOperationKey(
    { profile: 'biome-lint', paths: ['src/a.css', 'src/b.css'] },
    ctx,
  );
  assert.equal(lint, lintSorted, 'paths 排序去重后同一操作');
});

test('Windows ACL：argv 目标按字面分发（本机 mock 只证明参数分发）', () => {
  const argv = buildWindowsAclRunnerArgv({
    nodeExecutable: 'node',
    runnerPath: 'runner.mjs',
    workspaceRoot: 'W',
    scratchPath: 'S',
    permissionMode: 'workspace-write',
    invocation: ['node', 'fixtures/argv-echo.js', 'a b', 'c;d', 'e|f', '$HOME'],
  });
  assert.deepEqual(argv, [
    'node',
    'runner.mjs',
    '--workspace',
    'W',
    '--scratch',
    'S',
    '--mode',
    'workspace-write',
    '--',
    'node',
    'fixtures/argv-echo.js',
    'a b',
    'c;d',
    'e|f',
    '$HOME',
  ]);
  const tail = argv.slice(argv.indexOf('--') + 1);
  assert.deepEqual(tail, ['node', 'fixtures/argv-echo.js', 'a b', 'c;d', 'e|f', '$HOME']);
  assert.equal(tail.includes('-c'), false, 'argv 目标不得出现 shell -c 承载');
});

// ---- 汇总 ----

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const item of cases) {
    try {
      await item.fn();
      passed++;
      console.log(`  [PASS] ${item.name}`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${item.name} — ${message}`);
      console.log(`  [FAIL] ${item.name} — ${message}`);
    }
  }
  console.log(`\n${'='.repeat(56)}`);
  console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) {
    for (const line of failures) console.log(`  FAIL ${line}`);
    process.exit(1);
  }
  console.log('验收：C01-C06 行为与不变量成立 ✓');
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    /* 临时目录由系统回收 */
  }
}

void main();
