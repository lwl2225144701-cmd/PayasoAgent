// 套件: Background Jobs — Session 级后台长任务注册表 + shellJob 工具（v2.3）
// 用法: npx tsx tests/background-jobs.test.ts
// 覆盖：
//   1. 注册表：Session 键启动/查询/列表/终止/回收，并发上限，输出裁剪，父信号联动
//   2. 增量输出：onOutput 滚动缓冲 + offset 增量读取 + 上限标记
//   3. 完成通知：settle 进入会话队列，drain 清空（有界）
//   4. 生命周期：Session 删除 / 全部回收不留孤儿；作业不因"Run 结束"被销毁
//   5. shellJob 工具：list/wait/status/output（运行中增量）/kill 的输出与错误语义
// 说明：执行器通过端口注入，本套件不依赖 macOS 沙箱（真机 E2E 见 shell-execution）。

import assert from 'node:assert/strict';
import {
  type BackgroundExecutor,
  backgroundJobCount,
  disposeAllBackgroundJobs,
  disposeSessionBackgroundJobs,
  drainJobCompletionNotifications,
  getBackgroundJob,
  killBackgroundJob,
  listBackgroundJobs,
  MAX_JOBS_PER_SESSION,
  readBackgroundJobOutput,
  startBackgroundJob,
  waitForBackgroundJob,
} from '../src/sandbox/background-jobs.js';
import {
  execute as executeRaw,
  normalizeToolResult,
  type ToolContext,
} from '../src/tools/tools.js';
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

function ctx(sessionId: string, runId = `${sessionId}-run`): ToolContext {
  return { runId, sessionId, workspaceRoot: process.cwd() };
}

async function callShellJob(sessionId: string, args: Record<string, unknown>): Promise<string> {
  return normalizeToolResult(await executeRaw('shellJob', args, ctx(sessionId))).text;
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

/** Executor that pushes chunks via onOutput, then resolves with final output. */
function streamingExecutor(
  chunks: { text: string; afterMs: number }[],
  final: { exitCode?: number | null; stdout?: string } = {},
  settleAfterMs = 0,
): BackgroundExecutor {
  return async (_signal, onOutput) => {
    for (const chunk of chunks) {
      await sleep(chunk.afterMs);
      onOutput?.(chunk.text);
    }
    if (settleAfterMs > 0) await sleep(settleAfterMs);
    return {
      exitCode: final.exitCode ?? 0,
      stdout: final.stdout ?? chunks.map((c) => c.text).join(''),
      stderr: '',
      timedOut: false,
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
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
      once: true,
    });
  });

// ---- 1. 注册表（Session 键） ----

await test('启动即返回 running 视图，完成后转为 succeeded 并带输出', async () => {
  const sessionId = 'bg-basic';
  const view = startBackgroundJob({
    sessionId,
    command: 'echo done',
    executor: delayedExecutor(10, { stdout: 'done' }),
  });
  assert.equal(view.status, 'running');
  assert.equal(view.jobId, 'job-1');
  await sleep(30);
  const after = getBackgroundJob(sessionId, 'job-1');
  assert.equal(after?.status, 'succeeded');
  assert.ok(after?.output?.includes('done'));
  assert.ok(after?.finishedAt);
  disposeSessionBackgroundJobs(sessionId);
});

await test('非零退出码 → failed，并保留 stderr', async () => {
  const sessionId = 'bg-fail';
  startBackgroundJob({
    sessionId,
    command: 'false',
    executor: delayedExecutor(5, { exitCode: 2, stdout: '', stderr: 'boom' }),
  });
  await sleep(20);
  const job = getBackgroundJob(sessionId, 'job-1');
  assert.equal(job?.status, 'failed');
  assert.ok(job?.output?.includes('boom'));
  disposeSessionBackgroundJobs(sessionId);
});

await test('超时 → failed 且带超时说明', async () => {
  const sessionId = 'bg-timeout';
  startBackgroundJob({
    sessionId,
    command: 'sleep 999',
    executor: delayedExecutor(5, { timedOut: true, exitCode: null }),
  });
  await sleep(20);
  const job = getBackgroundJob(sessionId, 'job-1');
  assert.equal(job?.status, 'failed');
  assert.ok(job?.error?.includes('超时'));
  disposeSessionBackgroundJobs(sessionId);
});

await test('输出超过预算被裁剪（不会撑爆上下文）', async () => {
  const sessionId = 'bg-output-cap';
  startBackgroundJob({
    sessionId,
    command: 'huge',
    executor: delayedExecutor(5, { stdout: 'A'.repeat(64 * 1024) }),
  });
  await sleep(30);
  const job = getBackgroundJob(sessionId, 'job-1');
  assert.ok(job?.output);
  assert.ok(Buffer.byteLength(job.output, 'utf8') <= 16 * 1024, `输出未裁剪: ${job.output.length}`);
  assert.ok(job.output.includes('[OUTPUT TRUNCATED]'));
  disposeSessionBackgroundJobs(sessionId);
});

await test('kill 终止运行中的作业 → killed', async () => {
  const sessionId = 'bg-kill';
  startBackgroundJob({ sessionId, command: 'sleep 999', executor: abortableExecutor });
  assert.equal(killBackgroundJob(sessionId, 'job-1'), true);
  await sleep(10);
  assert.equal(getBackgroundJob(sessionId, 'job-1')?.status, 'killed');
  disposeSessionBackgroundJobs(sessionId);
});

await test('kill 不存在的作业 → false', () => {
  assert.equal(killBackgroundJob('bg-missing', 'job-9'), false);
});

await test('并发上限：同一会话超过 MAX_JOBS_PER_SESSION 抛错', () => {
  const sessionId = 'bg-limit';
  for (let i = 0; i < MAX_JOBS_PER_SESSION; i++) {
    startBackgroundJob({ sessionId, command: `sleep ${i}`, executor: abortableExecutor });
  }
  assert.throws(
    () => startBackgroundJob({ sessionId, command: 'sleep 9', executor: abortableExecutor }),
    /上限/,
  );
  disposeSessionBackgroundJobs(sessionId);
});

await test('不同会话的作业相互隔离，会话内作业 id 递增', async () => {
  const a = startBackgroundJob({
    sessionId: 'bg-iso-a',
    command: 'x',
    executor: abortableExecutor,
  });
  const b = startBackgroundJob({
    sessionId: 'bg-iso-b',
    command: 'y',
    executor: abortableExecutor,
  });
  assert.equal(a.jobId, 'job-1');
  assert.equal(b.jobId, 'job-1', '每个会话独立计数');
  assert.equal(listBackgroundJobs('bg-iso-a').length, 1);
  assert.equal(listBackgroundJobs('bg-iso-b').length, 1);
  // 未传 sessionId 时回退 runId 派生键（CLI/旧测试兼容路径）
  const legacy = startBackgroundJob({
    runId: 'legacy-run-1',
    command: 'z',
    executor: abortableExecutor,
  });
  assert.equal(legacy.jobId, 'job-1');
  assert.equal(listBackgroundJobs('run-legacy-run-1').length, 1);
  disposeSessionBackgroundJobs('bg-iso-a');
  disposeSessionBackgroundJobs('bg-iso-b');
  disposeSessionBackgroundJobs('run-legacy-run-1');
});

await test('wait：完成时立即返回终态，超时则返回 running', async () => {
  const doneSession = 'bg-wait-done';
  startBackgroundJob({ sessionId: doneSession, command: 'quick', executor: delayedExecutor(10) });
  const done = await waitForBackgroundJob(doneSession, 'job-1', 100);
  assert.equal(done?.status, 'succeeded');
  disposeSessionBackgroundJobs(doneSession);

  const runningSession = 'bg-wait-timeout';
  startBackgroundJob({
    sessionId: runningSession,
    command: 'slow',
    executor: delayedExecutor(100),
  });
  const running = await waitForBackgroundJob(runningSession, 'job-1', 5);
  assert.equal(running?.status, 'running');
  disposeSessionBackgroundJobs(runningSession);
});

await test('wait：调用方取消时立即中断等待', async () => {
  const sessionId = 'bg-wait-abort';
  const signal = new AbortController();
  startBackgroundJob({ sessionId, command: 'slow', executor: abortableExecutor });
  const waiting = waitForBackgroundJob(sessionId, 'job-1', 30_000, signal.signal);
  signal.abort();
  await assert.rejects(waiting, /Aborted/);
  disposeSessionBackgroundJobs(sessionId);
});

await test('父信号（Run 停止）联动终止该 Run 启动的作业', async () => {
  const sessionId = 'bg-parent-signal';
  const parent = new AbortController();
  startBackgroundJob({
    sessionId,
    command: 'sleep 999',
    executor: abortableExecutor,
    parentSignal: parent.signal,
  });
  parent.abort();
  await sleep(10);
  assert.equal(getBackgroundJob(sessionId, 'job-1')?.status, 'killed');
  disposeSessionBackgroundJobs(sessionId);
});

await test('作业不因 Run 结束被销毁：注册表没有 Run 级 dispose 路径（Session 所有权）', async () => {
  const sessionId = 'bg-survives-run';
  startBackgroundJob({
    sessionId,
    runId: 'run-a',
    command: 'long',
    executor: delayedExecutor(20, { stdout: 'finished' }),
  });
  // Run 终态不再回收作业：模拟 Run A 结束、Run B 继续读取同一会话作业。
  await sleep(40);
  const fromLaterRun = listBackgroundJobs(sessionId);
  assert.equal(fromLaterRun.length, 1);
  assert.equal(fromLaterRun[0].status, 'succeeded');
  disposeSessionBackgroundJobs(sessionId);
});

// ---- 2. 增量输出 ----

await test('onOutput 进入滚动缓冲，offset 增量读取不重读全文', async () => {
  const sessionId = 'bg-incremental';
  startBackgroundJob({
    sessionId,
    command: 'stream',
    executor: streamingExecutor([
      { text: '第一步输出\n', afterMs: 5 },
      { text: '第二步输出\n', afterMs: 20 },
    ]),
  });
  await sleep(10);
  const first = readBackgroundJobOutput(sessionId, 'job-1', 0);
  assert.ok(first, '首次读取应有结果');
  assert.ok(first.text.includes('第一步输出'), `${first.text}`);
  assert.ok(!first.text.includes('第二步'), '尚未产生的内容不应出现');
  const firstLen = first.text.length;
  assert.equal(first.nextOffset, firstLen);
  await sleep(30);
  const second = readBackgroundJobOutput(sessionId, 'job-1', first.nextOffset);
  assert.ok(second, '第二次读取应有结果');
  assert.ok(second.text.includes('第二步输出'), `${second.text}`);
  assert.ok(!second.text.includes('第一步'), '增量读取不应重读已读内容');
  assert.equal(second.nextOffset, firstLen + second.text.length, 'nextOffset 单调递增');
  disposeSessionBackgroundJobs(sessionId);
});

await test('滚动缓冲超过上限后标记 truncated', async () => {
  const sessionId = 'bg-buffer-cap';
  const chunk = 'x'.repeat(32 * 1024);
  startBackgroundJob({
    sessionId,
    command: 'flood',
    executor: streamingExecutor([
      { text: chunk, afterMs: 1 },
      { text: chunk, afterMs: 2 },
    ]),
  });
  await sleep(30);
  const read = readBackgroundJobOutput(sessionId, 'job-1', 0);
  assert.ok(read, '应有缓冲读取结果');
  assert.ok(read.truncated, '缓冲超过滚动上限应标记');
  disposeSessionBackgroundJobs(sessionId);
});

// ---- 3. 完成通知 ----

await test('作业 settle 后进入会话通知队列，drain 清空（FIFO）', async () => {
  const sessionId = 'bg-notify';
  startBackgroundJob({ sessionId, command: 'a', executor: delayedExecutor(5) });
  startBackgroundJob({ sessionId, command: 'b', executor: delayedExecutor(15) });
  await sleep(40);
  const drained = drainJobCompletionNotifications(sessionId);
  assert.deepEqual(
    drained.map((n) => n.jobId),
    ['job-1', 'job-2'],
  );
  assert.deepEqual(
    drained.map((n) => n.status),
    ['succeeded', 'succeeded'],
  );
  assert.deepEqual(drainJobCompletionNotifications(sessionId), [], 'drain 后清空');
  disposeSessionBackgroundJobs(sessionId);
});

await test('通知队列有界（防失控：完成通知风暴不撑爆内存）', async () => {
  const sessionId = 'bg-notify-cap';
  // 依次启动 130 个瞬时作业：并发上限 4，等最旧的完成再启下一个。
  for (let i = 0; i < 130; i++) {
    startBackgroundJob({ sessionId, command: `job-${i}`, executor: delayedExecutor(1) });
    while (
      listBackgroundJobs(sessionId).filter((j) => j.status === 'running').length >=
      MAX_JOBS_PER_SESSION
    ) {
      await sleep(5);
    }
  }
  await sleep(50);
  const drained = drainJobCompletionNotifications(sessionId);
  assert.ok(drained.length <= 64 + MAX_JOBS_PER_SESSION, `队列未封顶: ${drained.length}`);
  disposeSessionBackgroundJobs(sessionId);
});

// ---- 4. 生命周期回收 ----

await test('disposeSessionBackgroundJobs 幂等且清空作业与通知（不留孤儿）', async () => {
  const sessionId = 'bg-dispose';
  startBackgroundJob({ sessionId, command: 'sleep 999', executor: abortableExecutor });
  assert.equal(backgroundJobCount(sessionId), 1);
  disposeSessionBackgroundJobs(sessionId);
  assert.equal(backgroundJobCount(sessionId), 0);
  assert.deepEqual(drainJobCompletionNotifications(sessionId), [], '通知随会话一并清空');
  disposeSessionBackgroundJobs(sessionId); // 幂等
  await sleep(10);
});

await test('disposeAllBackgroundJobs 清空全部会话', () => {
  startBackgroundJob({ sessionId: 'bg-all-a', command: 'x', executor: abortableExecutor });
  startBackgroundJob({ sessionId: 'bg-all-b', command: 'y', executor: abortableExecutor });
  assert.equal(backgroundJobCount('bg-all-a'), 1);
  disposeAllBackgroundJobs();
  assert.equal(backgroundJobCount('bg-all-a'), 0);
  assert.equal(backgroundJobCount('bg-all-b'), 0);
});

// ---- 5. shellJob 工具 ----

await test('shellJob list：无作业与有作业（会话视图）', async () => {
  assert.ok((await callShellJob('tool-list-empty', { action: 'list' })).includes('没有后台作业'));
  startBackgroundJob({
    sessionId: 'tool-list',
    command: 'npm test',
    executor: delayedExecutor(5),
  });
  await sleep(20);
  const res = await callShellJob('tool-list', { action: 'list' });
  assert.ok(res.includes('job-1'), res);
  assert.ok(res.includes('npm test'), res);
  disposeSessionBackgroundJobs('tool-list');
});

await test('shellJob status：运行中提示与完成后状态', async () => {
  startBackgroundJob({ sessionId: 'tool-status', command: 'sleep', executor: delayedExecutor(30) });
  const running = await callShellJob('tool-status', { action: 'status', jobId: 'job-1' });
  assert.ok(running.includes('[running]'), running);
  assert.ok(running.includes('仍在运行'), running);
  await sleep(50);
  const done = await callShellJob('tool-status', { action: 'status', jobId: 'job-1' });
  assert.ok(done.includes('[succeeded]'), done);
  disposeSessionBackgroundJobs('tool-status');
});

await test('shellJob output：运行中增量读取 + 完成后完整输出', async () => {
  startBackgroundJob({
    sessionId: 'tool-output',
    command: 'echo hi',
    executor: streamingExecutor(
      [{ text: 'hello-from-job\n', afterMs: 5 }],
      { stdout: 'hello-from-job\n' },
      60, // 第一批输出推完后保持 running 一段时间，保证能测到"运行中增量读取"
    ),
  });
  await sleep(15);
  const partial = await callShellJob('tool-output', { action: 'output', jobId: 'job-1' });
  assert.ok(partial.includes('[running]'), partial);
  assert.ok(partial.includes('hello-from-job'), partial);
  assert.ok(partial.includes('部分输出'), partial);
  // offset 增量：明确读到 nextOffset 提示
  const offsetMatch = partial.match(/offset=(\d+)/);
  assert.ok(offsetMatch, `应提示 nextOffset: ${partial}`);
  await sleep(90);
  const done = await callShellJob('tool-output', { action: 'output', jobId: 'job-1' });
  assert.ok(done.includes('hello-from-job'), done);
  assert.ok(done.includes('[job-1 succeeded]'), done);
  // 完成后带 offset 也可读（返回完整输出，忽略增量语义）
  const withOffset = await callShellJob('tool-output', {
    action: 'output',
    jobId: 'job-1',
    offset: 3,
  });
  assert.ok(withOffset.includes('hello-from-job'), withOffset);
  disposeSessionBackgroundJobs('tool-output');
});

await test('shellJob wait：一次等待并返回完成输出，短等待可返回 running', async () => {
  startBackgroundJob({
    sessionId: 'tool-wait-done',
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
  disposeSessionBackgroundJobs('tool-wait-done');

  startBackgroundJob({
    sessionId: 'tool-wait-running',
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
  disposeSessionBackgroundJobs('tool-wait-running');
});

await test('shellJob kill：终止并报告状态', async () => {
  startBackgroundJob({ sessionId: 'tool-kill', command: 'sleep 999', executor: abortableExecutor });
  const res = await callShellJob('tool-kill', { action: 'kill', jobId: 'job-1' });
  assert.ok(res.includes('已请求终止 job-1'), res);
  disposeSessionBackgroundJobs('tool-kill');
});

await test('shellJob 参数错误：缺 jobId / 未知作业 / 未知 action', async () => {
  await assert.rejects(() => callShellJob('tool-errors', { action: 'status' }), /需要参数 jobId/);
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

await test('shellJob 跨 Run 可见：同会话新 Run 可列出并读取旧 Run 启动的作业', async () => {
  const sessionId = 'tool-cross-run';
  startBackgroundJob({
    sessionId,
    runId: 'old-run',
    command: 'cross-run build',
    executor: delayedExecutor(10, { stdout: 'cross-run-output' }),
  });
  await sleep(30);
  // 模拟同会话的后一个 Run（不同 runId、相同 sessionId）读取
  const listRes = normalizeToolResult(
    await executeRaw('shellJob', { action: 'list' }, ctx(sessionId, 'new-run')),
  ).text;
  assert.ok(listRes.includes('cross-run build'), listRes);
  const outRes = normalizeToolResult(
    await executeRaw('shellJob', { action: 'output', jobId: 'job-1' }, ctx(sessionId, 'new-run')),
  ).text;
  assert.ok(outRes.includes('cross-run-output'), outRes);
  disposeSessionBackgroundJobs(sessionId);
});

// ---- 6. Host 生命周期联动：Session 删除 / Host 关闭统一回收（不留孤儿）----

await test('Session 删除回收该会话作业；Host 关闭清空其余作业', async () => {
  const { RunManager } = await import('../src/host/run-manager.js');
  const { SqliteRunStore } = await import('../src/host/persistence/sqlite-store.js');
  const { MemorySecretStore } = await import('../src/host/secrets/secret-store.js');

  const store = new SqliteRunStore(':memory:', new MemorySecretStore());
  const now = new Date().toISOString();
  const sessionId = 'session-jobs-a';
  store.createSession({
    sessionId,
    title: 'jobs',
    workspaceRoot: process.cwd(),
    workspaceName: 'workspace-jobs',
    createdAt: now,
    updatedAt: now,
  });

  const manager = new RunManager(store);
  try {
    startBackgroundJob({ sessionId, command: 'sleep 999', executor: abortableExecutor });
    assert.equal(backgroundJobCount(sessionId), 1);

    // Session 删除（归档 → 删除）→ 作业被统一回收，注册表清空
    manager.archiveSession(sessionId);
    const result = manager.deleteSession(sessionId);
    assert.equal(result.deleted, 1);
    assert.equal(backgroundJobCount(sessionId), 0, 'Session 删除后不得残留作业');
    await sleep(10);

    // Host 关闭 → 其余会话的作业全部清空（幂等）
    const otherSession = 'session-jobs-b';
    startBackgroundJob({
      sessionId: otherSession,
      command: 'sleep 999',
      executor: abortableExecutor,
    });
    assert.equal(backgroundJobCount(otherSession), 1);
    await manager.close();
    assert.equal(backgroundJobCount(otherSession), 0, 'Host 关闭后不得残留作业');
  } catch (err) {
    await manager.close();
    throw err;
  }
});

console.log(`\nbackground-jobs 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
