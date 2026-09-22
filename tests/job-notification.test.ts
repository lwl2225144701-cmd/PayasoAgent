// 套件: Background Job 完成通知（Session 级，docs/plans/long-task-timeout-plan.md 步骤 5）
// 用法: npx tsx tests/job-notification.test.ts
// 覆盖:
//   1. 模型收尾竞态：LLM 调用期间作业完成 → 通知注入并继续，模型用 shellJob
//      output 读取结果后再收尾
//   2. 连续唤醒上限：作业逐个完成时最多连续唤醒 MAX 次；未被注入的通知留在
//      会话队列（不丢），注入 + 留守 = 全部完成数
// 说明：确定性，无真实 LLM/网络——fetch 打桩 + 直接操作后台作业注册表。
//   第 2 组用例按"已 settle 作业数"驱动轮次（事件驱动），不依赖挂钟时序，
//   在并发测试负载下同样稳定。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentExecutionContext } from '../src/bootstrap/runtime-bootstrap.js';
import type { ChatMessage } from '../src/llm/llm.js';
import { runAgent } from '../src/runtime/agent.js';
import { silentRuntimeObserver } from '../src/runtime/observer-port.js';
import {
  drainJobCompletionNotifications,
  listBackgroundJobs,
  startBackgroundJob,
} from '../src/sandbox/background-jobs.js';
import '../src/tools/runtime-tools.js'; // 注册 shellJob 工具

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-job-notify-'));
process.env.SANDBOX_ROOT = ROOT;

const MODEL_CONFIG = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'sk-job-notify',
  model: 'gpt-4o-mini',
};

interface ObservedEvent {
  type: string;
  jobs?: Array<{ jobId: string; status: string }>;
}

function response(message: ChatMessage): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toolCall(name: string, iteration: number, argsJson: string): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: `notify-call-${iteration}`,
        type: 'function',
        function: { name, arguments: argsJson },
      },
    ],
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(5);
  }
}

function runOptions(
  sessionId: string,
  runId: string,
  root: string,
  saves: Array<{ status: string; iteration: number }>,
  events: ObservedEvent[] = [],
) {
  return {
    executionContext: createAgentExecutionContext({ runId, sessionId, workspaceRoot: root }),
    checkpointWriter: {
      save: (snapshot: { status: string; iteration: number }) => {
        saves.push({ status: snapshot.status, iteration: snapshot.iteration });
        return `memory://${runId}/${saves.length}`;
      },
    },
    observer: {
      ...silentRuntimeObserver,
      traceEvent: (event: ObservedEvent) => events.push(event),
    },
    modelConfig: MODEL_CONFIG,
  };
}

const originalFetch = globalThis.fetch;
try {
  // 1. 模型收尾竞态：作业在"最后一条 LLM 调用"期间完成 → 注入通知 → 模型读取后收尾
  {
    const sessionId = 'notify-session-1';
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        // call 1 是"准备收尾"的 LLM 调用：让它慢 80ms，期间后台作业（60ms）完成。
        await sleep(80);
        return response({ role: 'assistant', content: 'looks done' });
      }
      if (calls === 2) {
        // 收到通知后，模型读取作业输出
        return response(
          toolCall('shellJob', calls, JSON.stringify({ action: 'output', jobId: 'job-1' })),
        );
      }
      return response({ role: 'assistant', content: 'done' });
    }) as typeof fetch;

    const saves: Array<{ status: string; iteration: number }> = [];
    const events: ObservedEvent[] = [];
    const root = path.join(ROOT, 'race');
    fs.mkdirSync(root);
    startBackgroundJob({
      sessionId,
      runId: 'notify-run',
      command: 'echo notify-output',
      executor: async () => {
        await sleep(60);
        return { exitCode: 0, stdout: 'notify-output', stderr: '', timedOut: false };
      },
    });

    const answer = await runAgent(
      'wait for the background job result',
      undefined,
      runOptions(sessionId, 'notify-run', root, saves, events),
    );

    assert.equal(answer, 'done');
    assert.equal(calls, 3, '通知注入 → shellJob 读取 → 最终答案');
    assert.equal(saves.at(-1)?.status, 'completed');
    assert.ok(
      events.some((e) => e.type === 'background_job_notified'),
      events.map((e) => e.type).join(','),
    );
    // 通知里携带了完成作业信息
    assert.equal(drainJobCompletionNotifications(sessionId).length, 0, '通知已被消费');
  }

  // 2. 连续唤醒上限：4 个作业逐个 settle；唤醒最多连续 3 次，未注入的通知留在队列。
  //    轮次由"已 settle 作业数"驱动：第 k 轮 LLM 调用等到第 k 个作业 settle 才返回，
  //    因此不受机器负载/挂钟漂移影响。
  {
    const sessionId = 'notify-session-2';
    const total = 4;
    let calls = 0;
    const settledCount = (): number =>
      listBackgroundJobs(sessionId).filter((job) => job.status !== 'running').length;

    globalThis.fetch = (async () => {
      calls++;
      // 第 k 轮等到 k 个作业 settle（k > total 时不再等待，保证 Run 一定收敛）
      if (calls <= total) await waitFor(() => settledCount() >= calls);
      return response({ role: 'assistant', content: `draft-${calls}` });
    }) as typeof fetch;

    const saves: Array<{ status: string; iteration: number }> = [];
    const events: ObservedEvent[] = [];
    const root = path.join(ROOT, 'cap');
    fs.mkdirSync(root);
    for (const delay of [0, 20, 40, 60]) {
      startBackgroundJob({
        sessionId,
        runId: 'cap-run',
        command: `job-${delay}`,
        executor: async () => {
          await sleep(delay);
          return { exitCode: 0, stdout: `out-${delay}`, stderr: '', timedOut: false };
        },
      });
    }

    const answer = await runAgent(
      'finish quickly',
      undefined,
      runOptions(sessionId, 'cap-run', root, saves, events),
    );

    assert.match(answer, /^draft-\d+$/, `Run 必须收敛到最终答案：${answer}`);
    assert.equal(saves.at(-1)?.status, 'completed');
    const notifications = events.filter((e) => e.type === 'background_job_notified');
    assert.ok(notifications.length >= 1, '至少注入一次完成通知');
    assert.ok(notifications.length <= 3, `连续唤醒最多 3 次，实际 ${notifications.length}`);
    // 注入 + 留守 = 全部完成的作业：未注入的通知留在会话队列，不丢
    const injectedJobs = notifications.reduce((sum, e) => sum + (e.jobs?.length ?? 0), 0);
    const leftover = drainJobCompletionNotifications(sessionId).length;
    assert.equal(
      injectedJobs + leftover,
      total,
      `注入 ${injectedJobs} + 留守 ${leftover} ≠ ${total}`,
    );
  }
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log('Job notification tests: PASS');
