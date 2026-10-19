// 执行治理功能验收：以用户可见行为、真实 checkpoint 和 Host 终态为断言。
// 全部用例继续执行并汇总；已知缺陷照常报 FAIL，不用跳过或放宽断言掩盖。
// 模型完全模拟；工作区、SQLite、凭证和副作用均隔离在临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DefaultContextHarness } from '../src/harness/context-harness.js';
import { LlmConversationSummarizer } from '../src/harness/conversation-summarizer.js';
import { resolveExecutionBudgetPolicy } from '../src/harness/execution-policy.js';
import { resolveModelContextConfig } from '../src/harness/model-context.js';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import { RunManager } from '../src/host/run-manager.js';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { clearWorkspace, setWorkspace } from '../src/host/workspace.js';
import { AgentStopRequestedError } from '../src/runtime/agent.js';
import type { CheckpointSnapshot } from '../src/runtime/checkpoint-port.js';
import {
  call,
  done,
  GovernanceFixture,
  MODEL,
  tools,
  turn,
  WRITE_PROBE,
  type Outcome,
} from './helpers/governance-acceptance.js';

const fixture = new GovernanceFixture();
const ratios = { warnRatio: 0.7, convergeRatio: 0.9 };
const results: Array<{
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  error?: string;
  evidence: Record<string, unknown>;
}> = [];
let evidence: Record<string, unknown> = {};
function note(facts: Record<string, unknown>) {
  Object.assign(evidence, facts);
}
async function check(id: string, name: string, action: () => Promise<void> | void) {
  fixture.resetEnvironment();
  evidence = {};
  const started = performance.now();
  try {
    await action();
    results.push({
      id,
      name,
      status: 'PASS',
      durationMs: Math.round(performance.now() - started),
      evidence,
    });
    console.log('[PASS] ' + id + ' ' + name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({
      id,
      name,
      status: 'FAIL',
      durationMs: Math.round(performance.now() - started),
      error: message,
      evidence,
    });
    console.error('[FAIL] ' + id + ' ' + name + '\n' + message);
  } finally {
    fixture.closeStreams();
  }
}
function stopped(outcome: Outcome) {
  assert.ok(
    outcome.error instanceof AgentStopRequestedError,
    '应按治理策略停止，而非失败或正常完成',
  );
  assert.equal(outcome.error.stop?.code, 'budget_exhausted');
}
function completed(outcome: Outcome) {
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.answer, done().content);
}
function checkpoint(run: { snapshots: CheckpointSnapshot[] }) {
  const snapshot = run.snapshots.at(-1);
  assert.ok(snapshot, '必须存在可恢复的 checkpoint');
  return snapshot;
}
function context(messages: Array<{ content: unknown }>) {
  return messages.map((message) => String(message.content)).join('\n');
}
function budgetFacts(run: { snapshots: CheckpointSnapshot[] }, outcome?: Outcome) {
  const budget = checkpoint(run).harnessState?.executionBudget;
  note({
    elapsedMs: outcome && Math.round(outcome.elapsedMs),
    savedUsage: budget?.usage,
    exhausted: budget?.exhausted,
  });
  return budget;
}

type RuntimeRun = ReturnType<GovernanceFixture['run']>;
let toolStop: { run: RuntimeRun; outcome: Outcome } | undefined;
async function stoppedToolBatch() {
  if (toolStop) return toolStop;
  const run = fixture.run('tool-stop', { executionBudget: { maxActiveMs: 1000, ...ratios } });
  fixture.script([
    turn(
      tools(call('first', { durationMs: 650 }), call('second', { durationMs: 650 }), call('third')),
    ),
    turn(done()),
  ]);
  toolStop = { run, outcome: await run.execute() };
  return toolStop;
}
let summaryStop:
  | { run: RuntimeRun; outcome: Outcome; summaryCalls: number; streamAborts: number }
  | undefined;
async function stoppedSummary() {
  if (summaryStop) return summaryStop;
  let summaryCalls = 0;
  const delegate = new LlmConversationSummarizer(MODEL);
  const run = fixture.run(
    'summary-stop',
    {
      executionBudget: { maxActiveMs: 900, ...ratios },
      modelContext: resolveModelContextConfig({
        model: MODEL.model,
        contextWindowTokens: 16_384,
        maxOutputTokens: 1024,
        safetyTokens: 512,
      }),
      summarizer: {
        summarize: (request) => {
          summaryCalls++;
          return delegate.summarize(request);
        },
      },
    },
    {
      conversationHistory: [
        { role: 'user', content: '旧任务资料。'.repeat(14_000) },
        { role: 'assistant', content: '旧任务结果。'.repeat(14_000) },
        { role: 'user', content: '第二轮资料。'.repeat(14_000) },
        { role: 'assistant', content: '第二轮结果。'.repeat(14_000) },
      ],
    },
  );
  const transport = fixture.script([{ live: true }]);
  const outcome = await run.execute();
  summaryStop = { run, outcome, summaryCalls, streamAborts: transport.abortedStreams };
  return summaryStop;
}

async function withHost(
  id: string,
  action: (manager: RunManager, store: SqliteRunStore, db: string) => Promise<void>,
) {
  const root = path.join(fixture.root, id);
  fs.mkdirSync(root, { recursive: true });
  setWorkspace(root);
  const db = path.join(root, 'host.db');
  const store = new SqliteRunStore(db, new MemorySecretStore());
  const manager = new RunManager(store);
  const provider = manager.addModelProvider({
    name: '验收模拟模型',
    baseUrl: MODEL.baseUrl!,
    apiKey: MODEL.apiKey!,
    models: [MODEL.model!],
  });
  manager.setDefaultModel(provider.id, MODEL.model);
  try {
    await action(manager, store, db);
  } finally {
    await manager.close();
    clearWorkspace();
  }
}
async function waitHost(manager: RunManager, id: string) {
  const timeout = setTimeout(() => manager.stop(id), 7_000);
  try {
    await manager.runExecution(id);
  } finally {
    clearTimeout(timeout);
  }
}

try {
  await check('CFG-01', '默认入口三维有限且真实入账', async () => {
    const policy = resolveExecutionBudgetPolicy({});
    assert.ok(policy);
    for (const key of ['maxModelCalls', 'maxOutputTokens', 'maxActiveMs'] as const) {
      assert.ok(Number.isFinite(policy[key]) && policy[key]! > 0, key + ' 必须有限');
    }
    const run = fixture.run('default');
    fixture.script([turn(tools(call('read'))), turn(done())]);
    completed(await run.execute());
    assert.equal(budgetFacts(run)?.usage.modelCalls, 2);
  });
  await check('CFG-02', 'SDK 只配一个上限，收尾采用默认小额额度', async () => {
    const run = fixture.run('partial-policy', { executionBudget: { maxModelCalls: 2, ...ratios } });
    const transport = fixture.script([
      turn(tools(call('one'))),
      turn(tools(call('two'))),
      turn(done()),
    ]);
    completed(await run.execute());
    assert.equal(transport.bodies[2]?.max_tokens, 1024);
    assert.deepEqual(fixture.starts.get(run.id), ['one']);
  });
  await check('CFG-03', '显式关闭预算时仍可完成正常任务', async () => {
    const run = fixture.run('off', { executionBudget: false });
    fixture.script([turn(tools(call('one'), call('two'))), turn(done())]);
    completed(await run.execute());
    assert.equal(checkpoint(run).harnessState?.executionBudget, undefined);
    assert.equal(run.events.filter((event) => event.type === 'budget_decision').length, 0);
    assert.deepEqual(fixture.starts.get(run.id), ['one', 'two']);
  });
  await check('CFG-04', 'SDK 非法上限不能静默取消该维度约束', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      assert.throws(
        () =>
          fixture.run('invalid-' + String(bad), {
            executionBudget: { maxActiveMs: bad, ...ratios },
          }),
        /budget|预算/i,
        'SDK 必须拒绝非法上限 ' + String(bad),
      );
    }
  });
  await check('LIMIT-01', '70/90/100 档位各一次且提醒到达下一次模型请求', async () => {
    const run = fixture.run('levels', { executionBudget: { maxModelCalls: 10, ...ratios } });
    const transport = fixture.script([
      ...Array.from({ length: 10 }, (_, i) => turn(tools(call('step-' + i)))),
      turn(done()),
    ]);
    completed(await run.execute());
    assert.deepEqual(
      run.events.filter((event) => event.type === 'budget_decision').map((event) => event.level),
      ['warn', 'converge', 'exhausted'],
    );
    assert.match(context(transport.bodies[7].messages), /Execution budget warning/);
    assert.match(context(transport.bodies[9].messages), /Execution budget nearly exhausted/);
    assert.equal(fixture.starts.get(run.id)?.length, 9, '耗尽当轮的工具不得执行');
  });
  await check('LIMIT-02', '输出 token 耗尽后阻止新工具工作', async () => {
    const run = fixture.run('tokens', { executionBudget: { maxOutputTokens: 40, ...ratios } });
    fixture.script([turn(tools(call('one')), 25), turn(tools(call('two')), 25), turn(done(), 5)]);
    completed(await run.execute());
    assert.equal(budgetFacts(run)?.usage.outputTokens, 55);
    assert.ok(budgetFacts(run)?.exhausted.includes('outputTokens'));
    assert.deepEqual(fixture.starts.get(run.id), ['one']);
  });
  await check('METER-01', 'HTTP 内部重试也按真实尝试数计量', async () => {
    const run = fixture.run('retry');
    const transport = fixture.script([{ status: 500 }, turn(tools(call('read'))), turn(done())]);
    completed(await run.execute());
    assert.equal(budgetFacts(run)?.usage.modelCalls, transport.bodies.length);
    assert.equal(transport.bodies.length, 3);
  });
  await check('METER-02', '全部请求失败后的尝试次数仍进入断点', async () => {
    const run = fixture.run('failure');
    const transport = fixture.script([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const outcome = await run.execute();
    assert.ok(outcome.error && !(outcome.error instanceof AgentStopRequestedError));
    assert.equal(budgetFacts(run)?.usage.modelCalls, transport.bodies.length);
    assert.equal(checkpoint(run).status, 'failed');
  });
  await check('STREAM-01', '持续收到真实 SSE 片段时仍在累计时限中止', async () => {
    const run = fixture.run('stream', { executionBudget: { maxActiveMs: 900, ...ratios } });
    const transport = fixture.script([{ live: true }]);
    const outcome = await run.execute();
    stopped(outcome);
    note({ chunks: transport.chunks, abortedStreams: transport.abortedStreams });
    assert.ok(transport.chunks >= 3, '不是只拖慢首包，必须持续收到片段');
    assert.equal(transport.abortedStreams, 1);
    assert.ok(outcome.elapsedMs < 4000, '不得等到测试兜底的 8 秒取消');
    assert.ok(budgetFacts(run, outcome)?.usage.activeMs! >= 900);
    assert.ok(budgetFacts(run)?.exhausted.includes('activeMs'));
  });
  await check('RESUME-01', '模型超限后的恢复只收尾，不再执行新工具', async () => {
    const run = fixture.run('model-resume', { executionBudget: { maxActiveMs: 800, ...ratios } });
    fixture.script([{ live: true }]);
    stopped(await run.execute());
    const resumed = fixture.run(run.id, { executionBudget: { maxActiveMs: 800, ...ratios } });
    fixture.script([turn(tools(call('forbidden-new-work'))), turn(done())]);
    completed(await resumed.execute(checkpoint(run)));
    assert.equal(fixture.starts.get(run.id)?.length ?? 0, 0);
    assert.ok(budgetFacts(resumed)?.exhausted.includes('activeMs'));
  });
  await check('CANCEL-01', '流式生成中用户取消与预算耗尽区分', async () => {
    const controller = new AbortController();
    const run = fixture.run(
      'cancel-model',
      { executionBudget: { maxActiveMs: 5000, ...ratios } },
      { signal: controller.signal },
    );
    let timer: ReturnType<typeof setTimeout>;
    fixture.script([
      {
        live: true,
        onFetch: () => {
          timer = setTimeout(() => controller.abort(), 150);
        },
      },
    ]);
    let outcome: Outcome;
    try {
      outcome = await run.execute();
    } finally {
      clearTimeout(timer!);
    }
    assert.ok(outcome.error && !(outcome.error instanceof AgentStopRequestedError));
    assert.equal((outcome.error as Error).name, 'AbortError');
    assert.equal(budgetFacts(run)?.usage.modelCalls, 1);
    assert.deepEqual(budgetFacts(run)?.exhausted, []);
  });
  await check('SUMMARY-01', '通过真实 runAgent 预算中止摘要，不只是手动传入信号', async () => {
    const result = await stoppedSummary();
    note({ summaryCalls: result.summaryCalls, abortedStreams: result.streamAborts });
    stopped(result.outcome);
    assert.equal(result.summaryCalls, 1, '必须确实进入压缩摘要');
    assert.equal(result.streamAborts, 1, '摘要在途收到取消');
    assert.equal(
      result.run.harness.snapshotState().executionBudget?.usage.modelCalls,
      1,
      '摘要失败尝试仍计量',
    );
    note({ checkpointCount: result.run.snapshots.length });
  });
  await check('SUMMARY-02', '摘要超限退出后，断点保存耗尽时间和档位', async () => {
    const { run, outcome } = await stoppedSummary();
    const budget = budgetFacts(run, outcome);
    assert.ok(budget?.usage.activeMs! >= 900, '摘要已耗尽 900ms，checkpoint 必须保存该消耗');
    assert.ok(budget?.exhausted.includes('activeMs'));
  });
  await check('TOOL-01', '同批前一工具完成、在途工具中止、后续工具不启动', async () => {
    const { run, outcome } = await stoppedToolBatch();
    stopped(outcome);
    note({ started: fixture.starts.get(run.id), completed: fixture.completions.get(run.id) });
    assert.deepEqual(fixture.starts.get(run.id), ['first', 'second']);
    assert.deepEqual(fixture.completions.get(run.id), ['first']);
    assert.equal(run.events.filter((event) => event.type === 'error').length, 0);
  });
  await check('TOOL-02', '工具超限停止后，断点保存耗尽时间和档位', async () => {
    const { run, outcome } = await stoppedToolBatch();
    const budget = budgetFacts(run, outcome);
    assert.ok(
      budget?.usage.activeMs! >= 1000,
      '工具已经耗尽 1000ms，checkpoint 不能只保存模型耗时',
    );
    assert.ok(budget?.exhausted.includes('activeMs'));
  });
  await check('RESUME-02', '工具超限后的恢复不得重新放行新工作', async () => {
    const { run } = await stoppedToolBatch();
    const before = fixture.starts.get(run.id)?.length ?? 0;
    const resumed = fixture.run(run.id, { executionBudget: { maxActiveMs: 1000, ...ratios } });
    fixture.script([turn(tools(call('must-not-start'))), turn(done())]);
    const outcome = await resumed.execute(checkpoint(run));
    note({
      before,
      after: fixture.starts.get(run.id)?.length,
      error: outcome.error instanceof Error ? outcome.error.name : undefined,
    });
    assert.equal(
      fixture.starts.get(run.id)?.length ?? 0,
      before,
      '恢复后只能收尾，不能再启动新工具',
    );
    assert.ok(budgetFacts(resumed)?.exhausted.includes('activeMs'));
  });
  await check('CANCEL-02', '工具途中用户取消后，也结算已经消耗的活动时长', async () => {
    const controller = new AbortController();
    const run = fixture.run('cancel-tool', {}, { signal: controller.signal });
    fixture.script([turn(tools(call('slow-cancelled', { durationMs: 2000 })))]);
    const timer = setTimeout(() => controller.abort(), 400);
    let outcome: Outcome;
    try {
      outcome = await run.execute();
    } finally {
      clearTimeout(timer);
    }
    assert.equal((outcome.error as Error)?.name, 'AbortError');
    const budget = budgetFacts(run, outcome);
    assert.ok(budget?.usage.activeMs! >= 300, '用户取消也不能丢掉工具阶段的耗时');
    assert.deepEqual(budget?.exhausted, []);
  });
  await check('NORMAL-01', '正常长任务完成，周期审查只提醒且目标保持可见', async () => {
    const run = fixture.run('normal-long', { goalReview: { everyTurns: 5, everyMs: 10_000_000 } });
    const transport = fixture.script([
      ...Array.from({ length: 15 }, (_, i) => turn(tools(call('legitimate-' + i)))),
      turn(done()),
    ]);
    completed(await run.execute());
    assert.equal(fixture.completions.get(run.id)?.length, 15);
    assert.equal(run.events.filter((event) => event.type === 'goal_review_reminder').length, 3);
    assert.match(
      context(transport.bodies[5].messages),
      /Original user goal: 完成隔离的治理验收任务/,
    );
    assert.equal(run.events.filter((event) => event.type === 'repeat_call_reminder').length, 0);
  });
  await check('WIRE-01', 'JSON 兼容响应与 SSE 一样保留同批全部工具调用', async () => {
    const run = fixture.run('json-batch');
    fixture.script([
      { message: tools(call('json-one'), call('json-two')), json: true },
      turn(done()),
    ]);
    completed(await run.execute());
    note({ started: fixture.starts.get(run.id), completed: fixture.completions.get(run.id) });
    assert.deepEqual(fixture.starts.get(run.id), ['json-one', 'json-two']);
  });
  await check('EFFECT-01', '成功副作用跨恢复只回放，真实临时文件只写一次', async () => {
    const run = fixture.run('effect-success');
    Object.assign(run.harness, { shouldStopAfterTurn: () => true });
    fixture.script([turn(tools(call('write-once', {}, WRITE_PROBE)))]);
    assert.ok((await run.execute()).error instanceof AgentStopRequestedError);
    const resumed = fixture.run(run.id);
    fixture.script([turn(tools(call('write-once', {}, WRITE_PROBE))), turn(done())]);
    completed(await resumed.execute(checkpoint(run)));
    assert.equal(
      fs.readFileSync(path.join(run.workspace, 'probe-writes.txt'), 'utf8'),
      'write-once\n',
    );
    assert.equal(resumed.events.filter((event) => event.type === 'side_effect_skip').length, 1);
  });
  await check('EFFECT-02', '结果不确定的副作用跨恢复不盲目重做', async () => {
    const run = fixture.run('effect-uncertain');
    Object.assign(run.harness, { shouldStopAfterTurn: () => true });
    fixture.script([turn(tools(call('uncertain-write', { fail: 'unknown' }, WRITE_PROBE)))]);
    assert.ok((await run.execute()).error instanceof AgentStopRequestedError);
    assert.equal(checkpoint(run).sideEffects?.[0]?.state, 'uncertain');
    const resumed = fixture.run(run.id);
    fixture.script([
      turn(tools(call('uncertain-write', { fail: 'unknown' }, WRITE_PROBE))),
      turn(done()),
    ]);
    completed(await resumed.execute(checkpoint(run)));
    assert.equal(
      fs.readFileSync(path.join(run.workspace, 'probe-writes.txt'), 'utf8'),
      'uncertain-write\n',
    );
    assert.equal(
      resumed.events.filter((event) => event.type === 'side_effect_uncertain').length,
      1,
    );
  });
  await check('ISOLATION-01', '新的用户任务继承摘要，但不继承上一 Run 的耗尽预算', async () => {
    const seed = new DefaultContextHarness({
      permissionMode: 'workspace-write',
      modelConfig: MODEL,
      executionBudget: { maxModelCalls: 10, ...ratios },
    });
    seed.observeExecution({ modelCalls: 10, outputTokens: 0, activeMs: 100 });
    const previous = seed.snapshotState();
    previous.conversationSummary = '上一任务已经确认的资料';
    const run = fixture.run(
      'new-user-task',
      { executionBudget: { maxModelCalls: 10, ...ratios } },
      { previousHarnessState: previous },
    );
    const transport = fixture.script([turn(tools(call('fresh-work'))), turn(done())]);
    completed(await run.execute());
    note({
      started: fixture.starts.get(run.id),
      usage: checkpoint(run).harnessState?.executionBudget?.usage,
    });
    assert.deepEqual(fixture.starts.get(run.id), ['fresh-work'], '新 Run 必须有自己的预算');
    assert.match(context(transport.bodies[0].messages), /上一任务已经确认的资料/);
    assert.equal(budgetFacts(run)?.usage.modelCalls, 2);
  });
  await check('COMPAT-01', '旧 checkpoint 缺少新增治理字段也能恢复', async () => {
    const first = fixture.run('legacy', { executionBudget: false });
    Object.assign(first.harness, { shouldStopAfterTurn: () => true });
    fixture.script([turn(tools(call('before-restart')))]);
    assert.ok((await first.execute()).error instanceof AgentStopRequestedError);
    const old = structuredClone(checkpoint(first));
    if (old.harnessState) {
      delete old.harnessState.executionBudget;
      delete old.harnessState.repeatCall;
      delete old.harnessState.goalReview;
      delete old.harnessState.pending;
    }
    const resumed = fixture.run(first.id);
    fixture.script([turn(tools(call('after-restart'))), turn(done())]);
    completed(await resumed.execute(old));
    assert.equal(budgetFacts(resumed)?.usage.modelCalls, 2);
  });
  await check('HOST-01', '预算停止只发布一个终态，SQLite 重开后原因与结果一致', async () => {
    process.env.PAYASO_MAX_MODEL_CALLS = '2';
    await withHost('host-stop', async (manager, store, db) => {
      fixture.script([
        turn(tools(call('one'))),
        turn(tools(call('two'))),
        turn(tools(call('three'))),
      ]);
      const chunks: string[] = [];
      const id = manager.create('预算耗尽时停止');
      manager.subscribe(id, {
        write: (chunk) => {
          chunks.push(chunk);
        },
        end() {},
        closed: () => false,
      });
      await waitHost(manager, id);
      const row = store.getRun(id);
      note({
        status: row?.status,
        stopReason: row?.stopReason,
        deliveryOutcome: row?.deliveryOutcome,
      });
      assert.equal(row?.status, 'stopped');
      assert.equal(row?.stopReason, 'budget_exhausted');
      assert.equal(row?.deliveryOutcome, 'partial');
      assert.equal(chunks.filter((chunk) => chunk.includes('event: run_stopped')).length, 1);
      assert.equal(
        chunks.filter((chunk) => /event: run_(?:completed|failed)/.test(chunk)).length,
        0,
      );
      await manager.close();
      const reopened = new SqliteRunStore(db, new MemorySecretStore());
      try {
        assert.equal(reopened.getRun(id)?.stopReason, row.stopReason);
        assert.equal(reopened.getRun(id)?.deliveryOutcome, row.deliveryOutcome);
      } finally {
        reopened.close();
      }
    });
  });
  await check('HOST-02', '预算耗尽后模型配合收尾，完成回答仍标部分交付', async () => {
    process.env.PAYASO_MAX_MODEL_CALLS = '2';
    await withHost('host-partial', async (manager, store) => {
      fixture.script([turn(tools(call('one'))), turn(tools(call('two'))), turn(done())]);
      const id = manager.create('预算后给出已有结果');
      await waitHost(manager, id);
      const row = store.getRun(id);
      assert.equal(row?.status, 'completed');
      assert.equal(row?.stopReason, 'budget_exhausted');
      assert.equal(row?.deliveryOutcome, 'partial');
      const terminal = store.listEvents(id).filter((event) => event.event.type === 'run_completed');
      assert.equal(terminal.length, 1);
      assert.equal((terminal[0].event as { deliveryOutcome?: string }).deliveryOutcome, 'partial');
    });
  });
  await check('HOST-03', '用户主动停止保存 user_cancelled，不误报预算耗尽', async () => {
    await withHost('host-user-stop', async (manager, store) => {
      fixture.script([{ live: true }]);
      const id = manager.create('用户主动取消');
      const timer = setTimeout(() => manager.stop(id), 150);
      try {
        await waitHost(manager, id);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(store.getRun(id)?.status, 'stopped');
      assert.equal(store.getRun(id)?.stopReason, 'user_cancelled');
      assert.equal(store.getRun(id)?.deliveryOutcome, 'unknown');
    });
  });
} finally {
  fixture.dispose();
}

const passed = results.filter((result) => result.status === 'PASS').length;
const failed = results.length - passed;
const logDir = path.resolve('.payaso', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const reportPath = path.join(
  logDir,
  'governance-acceptance-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json',
);
fs.writeFileSync(
  reportPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      mode: 'mock-provider-real-runtime-and-host',
      passed,
      failed,
      scenarios: results,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  '治理功能验收：' + passed + ' PASS / ' + failed + ' FAIL / ' + results.length + ' 场景',
);
console.log('机器结果：' + reportPath);
if (failed) process.exitCode = 1;
