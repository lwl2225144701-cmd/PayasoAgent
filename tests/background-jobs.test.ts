// 套件: Background Jobs — 后台长任务注册表 + shellJob 工具
// 用法: npx tsx tests/background-jobs.test.ts
// 覆盖：
//   1. 注册表：启动/查询/列表/终止/回收，并发上限，输出裁剪，父信号联动
//   2. shellJob 工具：list/wait/status/output/kill 的输出与错误语义
//   3. 生命周期：Run 终态回收后不再有作业（不留孤儿）
// 说明：执行器通过端口注入，本套件不依赖 macOS 沙箱（真机 E2E 见 shell-execution）。

import assert from 'node:assert/strict';
import {
  backgroundJobCount,
  disposeRunBackgroundJobs,
  getBackgroundJob,
  killBackgroundJob,
  listBackgroundJobs,
  MAX_JOBS_PER_RUN,
  startBackgroundJob,
  waitForBackgroundJob,
  type BackgroundExecutor,
} from '../src/sandbox/background-jobs.js';
import { execute as executeRaw, normalizeToolResult, type ToolContext } from '../src/tools/tools.js';
import '../src/tools/runtime-tools.js';

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ctx(runId: string): ToolContext {
  return { runId, workspaceRoot: process.cwd() };
}

async function callShellJob(
  runId: string,
  args: Record<string, unknown>,
): Promise<string> {
  return normalizeToolResult(await executeRaw('shellJob', args, ctx(runId))).text;
}

/** Executor that resolves after `delayMs` with the given output. */
function delayedExecutor(
  delayMs: number,
  result: { exitCode?: number | null; stdout?: string; stderr?: string; timedOut?: boolean } = {},
): BackgroundExecutor {
  return async () => {
    await sleep(delayMs);
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? 'ok',
      stderr: result.stderr ?? '',
      timedOut: result.timedOut ?? false,
    };
  };
}

/** Executor that never resolves on its own; only an abort ends it. */
const abortableExecutor: BackgroundExecutor = (signal) =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true },
    );
  });

// ---- 1. 注册表 ----

await test('启动即返回 running 视图，完成后转为 succeeded 并带输出', async () => {
  const runId = 'bg-basic';
  const view = startBackgroundJob({
    runId,
    command: 'echo done',
    executor: delayedExecutor(10, { stdout: 'done' }),
  });
  assert.equal(view.status, 'running');
  assert.equal(view.jobId, 'job-1');
  await sleep(30);
  const after = getBackgroundJob(runId, 'job-1');
  assert.equal(after?.status, 'succeeded');
  assert.ok(after?.output?.includes('done'));
  assert.ok(after?.finishedAt);
  disposeRunBackgroundJobs(runId);
});

await test('非零退出码 → failed，并保留 stderr', async () => {
  const runId = 'bg-fail';
  startBackgroundJob({
    runId,
    command: 'false',
    executor: delayedExecutor(5, { exitCode: 2, stdout: '', stderr: 'boom' }),
  });
  await sleep(20);
  const job = getBackgroundJob(runId, 'job-1');
  assert.equal(job?.status, 'failed');
  assert.ok(job?.output?.includes('boom'));
  disposeRunBackgroundJobs(runId);
});

await test('超时 → failed 且带超时说明', async () => {
  const runId = 'bg-timeout';
  startBackgroundJob({
    runId,
    command: 'sleep 999',
    executor: delayedExecutor(5, { timedOut: true, exitCode: null }),
  });
  await sleep(20);
  const job = getBackgroundJob(runId, 'job-1');
  assert.equal(job?.status, 'failed');
  assert.ok(job?.error?.includes('超时'));
  disposeRunBackgroundJobs(runId);
});

await test('输出超过预算被裁剪（不会撑爆上下文）', async () => {
  const runId = 'bg-output-cap';
  startBackgroundJob({
    runId,
    command: 'huge',
    executor: delayedExecutor(5, { stdout: 'A'.repeat(64 * 1024) }),
  });
  await sleep(30);
  const job = getBackgroundJob(runId, 'job-1');
  assert.ok(job?.output);
  assert.ok(Buffer.byteLength(job.output, 'utf8') <= 16 * 1024, `输出未裁剪: ${job.output.length}`);
  assert.ok(job.output.includes('[OUTPUT TRUNCATED]'));
  disposeRunBackgroundJobs(runId);
});

await test('kill 终止运行中的作业 → killed', async () => {
  const runId = 'bg-kill';
  startBackgroundJob({ runId, command: 'sleep 999', executor: abortableExecutor });
  assert.equal(killBackgroundJob(runId, 'job-1'), true);
  await sleep(10);
  assert.equal(getBackgroundJob(runId, 'job-1')?.status, 'killed');
  disposeRunBackgroundJobs(runId);
});

await test('kill 不存在的作业 → false', () => {
  assert.equal(killBackgroundJob('bg-missing', 'job-9'), false);
});

await test('并发上限：超过 MAX_JOBS_PER_RUN 抛错', () => {
  const runId = 'bg-limit';
  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    startBackgroundJob({ runId, command: `sleep ${i}`, executor: abortableExecutor });
  }
  assert.throws(
    () => startBackgroundJob({ runId, command: 'sleep 9', executor: abortableExecutor }),
    /上限/,
  );
  disposeRunBackgroundJobs(runId);
});

await test('list 返回本 Run 的作业，作业 id 递增', async () => {
  const runId = 'bg-list';
  startBackgroundJob({ runId, command: 'a', executor: delayedExecutor(5) });
  startBackgroundJob({ runId, command: 'b', executor: delayedExecutor(5) });
  await sleep(20);
  const jobs = listBackgroundJobs(runId);
  assert.deepEqual(jobs.map((job) => job.jobId), ['job-1', 'job-2']);
  disposeRunBackgroundJobs(runId);
});

await test('wait：完成时立即返回终态，超时则返回 running', async () => {
  const doneRun = 'bg-wait-done';
  startBackgroundJob({ runId: doneRun, command: 'quick', executor: delayedExecutor(10) });
  const done = await waitForBackgroundJob(doneRun, 'job-1', 100);
  assert.equal(done?.status, 'succeeded');
  disposeRunBackgroundJobs(doneRun);

  const runningRun = 'bg-wait-timeout';
  startBackgroundJob({ runId: runningRun, command: 'slow', executor: delayedExecutor(100) });
  const running = await waitForBackgroundJob(runningRun, 'job-1', 5);
  assert.equal(running?.status, 'running');
  disposeRunBackgroundJobs(runningRun);
});

await test('wait：Run 取消时立即中断等待', async () => {
  const runId = 'bg-wait-abort';
  const signal = new AbortController();
  startBackgroundJob({ runId, command: 'slow', executor: abortableExecutor });
  const waiting = waitForBackgroundJob(runId, 'job-1', 30_000, signal.signal);
  signal.abort();
  await assert.rejects(waiting, /Aborted/);
  disposeRunBackgroundJobs(runId);
});

await test('父信号（Run 取消）联动终止作业', async () => {
  const runId = 'bg-parent-signal';
  const parent = new AbortController();
  startBackgroundJob({
    runId,
    command: 'sleep 999',
    executor: abortableExecutor,
    parentSignal: parent.signal,
  });
  parent.abort();
  await sleep(10);
  assert.equal(getBackgroundJob(runId, 'job-1')?.status, 'killed');
  disposeRunBackgroundJobs(runId);
});

await test('dispose 幂等且清空作业（Run 终态不留孤儿）', async () => {
  const runId = 'bg-dispose';
  startBackgroundJob({ runId, command: 'sleep 999', executor: abortableExecutor });
  assert.equal(backgroundJobCount(runId), 1);
  disposeRunBackgroundJobs(runId);
  assert.equal(backgroundJobCount(runId), 0);
  disposeRunBackgroundJobs(runId); // 幂等
  await sleep(10);
});

await test('不同 Run 的作业相互隔离', () => {
  const a = startBackgroundJob({ runId: 'bg-iso-a', command: 'x', executor: abortableExecutor });
  const b = startBackgroundJob({ runId: 'bg-iso-b', command: 'y', executor: abortableExecutor });
  assert.equal(a.jobId, 'job-1');
  assert.equal(b.jobId, 'job-1', '每个 Run 独立计数');
  assert.equal(listBackgroundJobs('bg-iso-a').length, 1);
  assert.equal(listBackgroundJobs('bg-iso-b').length, 1);
  disposeRunBackgroundJobs('bg-iso-a');
  disposeRunBackgroundJobs('bg-iso-b');
});

// ---- 2. shellJob 工具 ----

await test('shellJob list：无作业与有作业', async () => {
  assert.ok((await callShellJob('tool-list-empty', { action: 'list' })).includes('没有后台作业'));
  startBackgroundJob({
    runId: 'tool-list',
    command: 'npm test',
    executor: delayedExecutor(5),
  });
  await sleep(20);
  const res = await callShellJob('tool-list', { action: 'list' });
  assert.ok(res.includes('job-1'), res);
  assert.ok(res.includes('npm test'), res);
  disposeRunBackgroundJobs('tool-list');
});

await test('shellJob status：运行中提示与完成后状态', async () => {
  startBackgroundJob({ runId: 'tool-status', command: 'sleep', executor: delayedExecutor(30) });
  const running = await callShellJob('tool-status', { action: 'status', jobId: 'job-1' });
  assert.ok(running.includes('[running]'), running);
  assert.ok(running.includes('仍在运行'), running);
  await sleep(50);
  const done = await callShellJob('tool-status', { action: 'status', jobId: 'job-1' });
  assert.ok(done.includes('[succeeded]'), done);
  disposeRunBackgroundJobs('tool-status');
});

await test('shellJob output：运行中提示、完成后返回输出', async () => {
  startBackgroundJob({
    runId: 'tool-output',
    command: 'echo hi',
    executor: delayedExecutor(300, { stdout: 'hello-from-job' }),
  });
  const running = await callShellJob('tool-output', { action: 'output', jobId: 'job-1' });
  assert.ok(running.includes('仍在运行'), running);
  await sleep(400);
  const done = await callShellJob('tool-output', { action: 'output', jobId: 'job-1' });
  assert.ok(done.includes('hello-from-job'), done);
  assert.ok(done.includes('[job-1 succeeded]'), done);
  disposeRunBackgroundJobs('tool-output');
});

await test('shellJob wait：一次等待并返回完成输出，短等待可返回 running', async () => {
  startBackgroundJob({
    runId: 'tool-wait-done',
    command: 'echo waited',
    executor: delayedExecutor(10, { stdout: 'waited-output' }),
  });
  const done = await callShellJob('tool-wait-done', {
    action: 'wait',
    jobId: 'job-1',
    waitMs: 100,
  });
  assert.ok(done.includes('[job-1 succeeded]'), done);
  assert.ok(done.includes('waited-output'), done);
  disposeRunBackgroundJobs('tool-wait-done');

  startBackgroundJob({
    runId: 'tool-wait-running',
    command: 'slow',
    executor: delayedExecutor(500),
  });
  const running = await callShellJob('tool-wait-running', {
    action: 'wait',
    jobId: 'job-1',
    waitMs: 100,
  });
  assert.ok(running.includes('[running]'), running);
  assert.ok(running.includes('再次 wait'), running);
  disposeRunBackgroundJobs('tool-wait-running');
});

await test('shellJob kill：终止并报告状态', async () => {
  startBackgroundJob({ runId: 'tool-kill', command: 'sleep 999', executor: abortableExecutor });
  const res = await callShellJob('tool-kill', { action: 'kill', jobId: 'job-1' });
  assert.ok(res.includes('已请求终止 job-1'), res);
  disposeRunBackgroundJobs('tool-kill');
});

await test('shellJob 参数错误：缺 jobId / 未知作业 / 未知 action', async () => {
  await assert.rejects(
    () => callShellJob('tool-errors', { action: 'status' }),
    /需要参数 jobId/,
  );
  await assert.rejects(
    () => callShellJob('tool-errors', { action: 'output', jobId: 'job-404' }),
    /后台作业不存在/,
  );
  await assert.rejects(
    () => callShellJob('tool-errors', { action: 'explode', jobId: 'job-1' }),
    /未知 action/,
    '未知 action 必须先于"作业不存在"报出',
  );
});

console.log(`\nbackground-jobs 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
