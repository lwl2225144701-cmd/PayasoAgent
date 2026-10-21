// 事实型进度闭环（计划 §8 / P01–P06）：
// - 纯策略：连续 4 回合无新增有效事实且累计活跃 ≥120s 才提醒；同周期最多 2 次；
//   新增必要证据 / 真实修改 / 新版本检查结论立即关闭周期。
// - Harness：提醒只投影到尾部 [Context]，不污染 canonical transcript；
//   resume 后不重复投递，投影有界。
// - 事实边界：失败/拒绝/无修改/updatePlan 不算成果；无结构化事实的工具停止
//   机械停滞推断（避免把正常业务动作误判为停滞）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentExecutionContext } from '../src/bootstrap/runtime-bootstrap.js';
import { DefaultContextHarness } from '../src/harness/context-harness.js';
import {
  advanceProgressWatch,
  createProgressWatchState,
  hasNewEvidence,
  normalizeProgressWatchState,
  PROGRESS_WATCH_MAX_REMINDERS,
  PROGRESS_WATCH_MIN_ACTIVE_MS,
  PROGRESS_WATCH_TURNS,
  renderProgressWatchReminder,
  type ToolTurnFacts,
} from '../src/harness/progress-watch.js';
import { resolveTaskFocus } from '../src/harness/task-focus.js';
import type { ChatMessage } from '../src/llm/llm.js';
import { runAgent } from '../src/runtime/agent.js';
import type { CheckpointSnapshot } from '../src/runtime/checkpoint-port.js';
import { createExecutionEvidenceStore } from '../src/runtime/execution-evidence-store.js';
import { silentRuntimeObserver } from '../src/runtime/observer-port.js';
import { checkTool, registerCheckTool } from '../src/tools/check.js';

let failures = 0;
let passes = 0;
// 用例串行执行（含异步 Harness 投影）：同步函数立即跑，Promise 入队后统一 await，
// 避免异步断言失败被吞掉而错误地打印 PASS。
const queue: Array<() => Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  queue.push(async () => {
    try {
      await fn();
      passes++;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      failures++;
      console.log(`  [FAIL] ${name}`);
      console.log(`         ${(err as Error).message}`);
    }
  });
}

const facts = (patch: Partial<ToolTurnFacts> = {}): ToolTurnFacts => ({
  coverage: 'complete',
  newReadCount: 0,
  changedFileCount: 0,
  newCheckCount: 0,
  repeatCount: 0,
  failedCount: 0,
  neutralOnly: false,
  evidenceIds: [],
  ...patch,
});
const turnMs = PROGRESS_WATCH_MIN_ACTIVE_MS / PROGRESS_WATCH_TURNS;
const noProgress = facts({ repeatCount: 1, evidenceIds: ['work/index.html'] });
const newRead = facts({ newReadCount: 1, evidenceIds: ['work/index.html'] });

/** 连续推进 n 回合，返回最终状态与每回合的提醒等级。 */
function run(
  state = createProgressWatchState(),
  n = PROGRESS_WATCH_TURNS,
  input = noProgress,
): { state: ReturnType<typeof createProgressWatchState>; reminds: string[] } {
  const reminds: string[] = [];
  let current = state;
  for (let i = 0; i < n; i++) {
    const decision = advanceProgressWatch(current, input, turnMs);
    current = decision.state;
    if (decision.remind !== 'none') reminds.push(decision.remind);
  }
  return { state: current, reminds };
}

console.log('\n== P01 阈值：4 回合无新增 + 120s 才提醒 ==');
test('P01 三回合（90s）不提醒，第四回合达到 120s 触发一次 warn', () => {
  const three = run(createProgressWatchState(), PROGRESS_WATCH_TURNS - 1);
  assert.deepEqual(three.reminds, [], '时长与回合都未达阈值时不能提醒');
  assert.equal(three.state.cycleOpen, true, '已进入观察周期');
  const four = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  assert.deepEqual(four.reminds, ['warn'], '阈值命中只提醒一次');
  assert.equal(four.state.reminders, 1);
  assert.equal(four.state.level, 'warn');
});
test('P01 交付只更新投递状态：继续计量，不当成已推进', () => {
  const first = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const after = advanceProgressWatch(first.state, noProgress, turnMs);
  assert.equal(after.remind, 'none', '同周期第二次不立即重发');
  assert.equal(after.state.noProgressTurns, PROGRESS_WATCH_TURNS + 1, '送达后继续累计回合');
  assert.equal(after.state.cycleOpen, true, '送达不关闭周期');
});

console.log('\n== P02 升级与关闭：同周期最多 2 次 ==');
test('P02 提醒后再 4 回合无新增 → 升级一次，且不再有第三次', () => {
  const warned = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const escalated = run(warned.state, PROGRESS_WATCH_TURNS);
  assert.deepEqual(escalated.reminds, ['escalate'], '第 8 回合升级一次');
  assert.equal(escalated.state.reminders, PROGRESS_WATCH_MAX_REMINDERS);
  const beyond = run(escalated.state, PROGRESS_WATCH_TURNS * 3);
  assert.deepEqual(beyond.reminds, [], '同周期不再产生第三次提醒');
});
test('P02 出现新增必要证据 → 立即关闭周期（epoch+1、计数清零）', () => {
  const warned = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const closed = advanceProgressWatch(warned.state, newRead, turnMs);
  assert.equal(closed.remind, 'none');
  assert.equal(closed.state.cycleOpen, false);
  assert.equal(closed.state.noProgressTurns, 0);
  assert.equal(closed.state.activeMs, 0);
  assert.equal(closed.state.reminders, 0);
  assert.ok(closed.state.epoch > warned.state.epoch, '事实纪元前移');
});

console.log('\n== P03 什么算新增证据 ==');
test('P03 新范围读取 / 真实修改 / 新检查结论都算新增', () => {
  assert.equal(hasNewEvidence(facts({ newReadCount: 1 })), true);
  assert.equal(hasNewEvidence(facts({ changedFileCount: 1 })), true);
  assert.equal(hasNewEvidence(facts({ newCheckCount: 1 })), true);
  assert.equal(hasNewEvidence(facts({ repeatCount: 3, evidenceIds: ['a'] })), false);
});
test('P03 同版本重复读取与重复检查不关闭周期（不算新成果）', () => {
  const warned = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const repeated = advanceProgressWatch(warned.state, facts({ repeatCount: 2 }), turnMs);
  assert.equal(repeated.state.cycleOpen, true, '重复不是推进');
  assert.equal(repeated.state.reminders, 1, '周期仍在同一提醒预算内');
});

console.log('\n== P04 不冒充成果的回合 ==');
test('P04 失败/拒绝/无修改不计成果，也不清零未推进计数', () => {
  const warned = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const failed = advanceProgressWatch(
    warned.state,
    facts({ coverage: 'partial', failedCount: 2, repeatCount: 1 }),
    turnMs,
  );
  assert.equal(failed.state.noProgressTurns, PROGRESS_WATCH_TURNS + 1, '失败回合继续累计');
  assert.equal(failed.remind, 'none');
});
test('P04 updatePlan（neutralOnly）保留计数，但不累积回合与时长', () => {
  const two = run(createProgressWatchState(), 2);
  const neutral = advanceProgressWatch(
    two.state,
    facts({ neutralOnly: true, coverage: 'complete' }),
    turnMs * 10,
  );
  assert.deepEqual(neutral.state, two.state, '中性回合不改变停滞状态');
  assert.equal(neutral.remind, 'none');
});
test('P04 无结构化事实（unknown）停止机械停滞推断', () => {
  const two = run(createProgressWatchState(), 2);
  const unknown = advanceProgressWatch(
    two.state,
    facts({ coverage: 'unknown', repeatCount: 1 }),
    turnMs,
  );
  assert.equal(unknown.state.noProgressTurns, 0, '未知活动重置连续性');
  assert.equal(unknown.state.activeMs, 0);
  assert.equal(unknown.remind, 'none');
});

console.log('\n== P05 正常深入阅读不误触发 ==');
test('P05 每回合都有新增读取 → 任意多回合都不提醒', () => {
  const deep = run(createProgressWatchState(), 20, newRead);
  assert.deepEqual(deep.reminds, []);
  assert.equal(deep.state.reminders, 0);
});
test('P05 状态恢复对非法输入 fail-closed', () => {
  assert.deepEqual(normalizeProgressWatchState(undefined), createProgressWatchState());
  const clamped = normalizeProgressWatchState({
    noProgressTurns: -3,
    activeMs: Number.NaN,
    reminders: 99,
  });
  assert.equal(clamped.noProgressTurns, 0, '非法回合数归零');
  assert.equal(clamped.activeMs, 0, '非法时长归零');
  assert.equal(
    clamped.reminders,
    PROGRESS_WATCH_MAX_REMINDERS,
    '提醒次数被夹到上限（不因旧快照多花提醒）',
  );
  const restored = normalizeProgressWatchState({
    noProgressTurns: 2,
    activeMs: 60_000,
    reminders: 1,
  });
  assert.equal(restored.noProgressTurns, 2);
  assert.equal(restored.reminders, 1);
});

console.log('\n== P06 投影：合并、有界、resume 不重复 ==');
test('P06 提醒文案有界：证据引用最多 6 条，含事实依据', () => {
  const { state } = run(createProgressWatchState(), PROGRESS_WATCH_TURNS);
  const text = renderProgressWatchReminder(
    {
      state,
      remind: 'warn',
      reason: '连续 4 个已完成工具回合没有新增有效事实（累计活跃 120s）',
    },
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  );
  assert.match(text, /\[Progress watch · review\]/);
  assert.match(text, /累计活跃 120s/);
  const listed = text.split('Known evidence: ')[1] ?? '';
  assert.equal(listed.trim().split(',').length, 6, '证据引用有界（6 条）');
  assert.equal(renderProgressWatchReminder({ state, remind: 'none' }), '');
});

const MODEL = { baseUrl: 'https://provider.example/v1', apiKey: 'test-key', model: 'test-model' };
const pad = {
  task: 'inspect',
  completedSteps: [],
  failedSteps: [],
  invalidSteps: [],
  nextStep: null,
  lastResult: '',
};
const contextText = (messages: Array<{ role: string; content: unknown }>): string =>
  String(messages.find((m) => String(m.content).includes('[Context]'))?.content ?? '');

function harness(): DefaultContextHarness {
  return new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelConfig: MODEL,
    progressReminder: false,
    goalReview: false,
    progressWatch: true,
  });
}

test('P06 Harness 只把进度审查放进尾部 [Context]，不变量测试', async () => {
  const h = harness();
  for (let i = 0; i < PROGRESS_WATCH_TURNS - 1; i++) {
    assert.equal(
      h.observeToolTurn({ activity: 'read', durationMs: turnMs, facts: noProgress }),
      undefined,
      '未达阈值的回合不产生观察',
    );
  }
  const observations = h.observeToolTurn({
    activity: 'read',
    durationMs: turnMs,
    facts: { ...noProgress, evidenceIds: ['work/index.html', 'work/app.css'] },
  });
  assert.equal(observations?.progressWatch?.remind, 'warn');
  const transcript: ChatMessage[] = h.createTranscript('检查页面');
  const original = structuredClone(transcript);
  const view = await h.prepareTurn(transcript, pad, []);
  const text = contextText(view.messages);
  assert.match(text, /\[Progress watch · review\]/);
  assert.match(text, /Known evidence: work\/index\.html, work\/app\.css/);
  assert.deepEqual(transcript, original, '提醒不污染 canonical transcript');
  assert.equal(
    view.messages.filter((m) => String(m.content).startsWith('[Context]')).length,
    1,
    '提醒合并进唯一一条尾部 [Context]，不新增第二条同义消息',
  );
});
test('P06 resume：投递状态随 checkpoint 恢复，不重复投递', async () => {
  const h = harness();
  h.observeToolTurn({ activity: 'read', durationMs: turnMs, facts: noProgress });
  for (let i = 1; i < PROGRESS_WATCH_TURNS; i++) {
    h.observeToolTurn({ activity: 'read', durationMs: turnMs, facts: noProgress });
  }
  const saved = h.snapshotState();
  const restored = harness();
  restored.restoreState(saved);
  const transcript: ChatMessage[] = restored.createTranscript('检查页面');
  const first = await restored.prepareTurn(transcript, pad, []);
  assert.match(contextText(first.messages), /\[Progress watch · review\]/);
  restored.acknowledgeConvergenceReminders();
  const second = await restored.prepareTurn(transcript, pad, []);
  assert.doesNotMatch(
    contextText(second.messages),
    /\[Progress watch · review\]/,
    '提醒只投递一次',
  );
  // 恢复后继续推进：升级预算不被重置。
  const next = restored.observeToolTurn({
    activity: 'read',
    durationMs: turnMs,
    facts: noProgress,
  });
  assert.equal(next, undefined, '同一周期内不重复提醒');
});
test('P06 与目标审查同时命中时合并投影，不叠加同类提示', async () => {
  const h = new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelConfig: MODEL,
    progressReminder: false,
    goalReview: { everyTurns: 1, everyMs: 1_000_000 },
    progressWatch: true,
  });
  // 第 1 回合目标审查命中（everyTurns=1）后进入 pending；进度审查在第 4 回合命中。
  const firstTurn = h.observeToolTurn({
    activity: 'read',
    durationMs: turnMs,
    goal: '检查页面',
    recentResult: 'ok',
    facts: noProgress,
  });
  assert.ok(firstTurn?.goalReview, '目标审查命中');
  let observations: ReturnType<typeof h.observeToolTurn> | undefined;
  for (let i = 1; i < PROGRESS_WATCH_TURNS; i++) {
    observations = h.observeToolTurn({
      activity: 'read',
      durationMs: turnMs,
      goal: '检查页面',
      recentResult: 'ok',
      facts: noProgress,
    });
  }
  assert.ok(observations?.progressWatch, '进度审查同时命中');
  const text = contextText((await h.prepareTurn(h.createTranscript('检查页面'), pad, [])).messages);
  assert.match(text, /\[Periodic goal review\]/);
  assert.match(text, /\[Progress watch · review\]/);
});
test('P06 环境开关关闭进度审查（PAYASO_PROGRESS_WATCH=off）', () => {
  const previous = process.env.PAYASO_PROGRESS_WATCH;
  try {
    process.env.PAYASO_PROGRESS_WATCH = 'off';
    const h = harness();
    for (let i = 0; i < PROGRESS_WATCH_TURNS * 2; i++) {
      assert.equal(
        h.observeToolTurn({ activity: 'read', durationMs: turnMs, facts: noProgress }),
        undefined,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.PAYASO_PROGRESS_WATCH;
    else process.env.PAYASO_PROGRESS_WATCH = previous;
  }
});

test('P07 Loop 集成：连续 4 次真实 read 失败也进入停滞审查', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-loop-'));
  const originalFetch = globalThis.fetch;
  const h = new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelConfig: MODEL,
    executionBudget: false,
    goalReview: false,
    progressReminder: false,
  });
  const turns: ToolTurnFacts[] = [];
  const reminders: string[] = [];
  const observe = h.observeToolTurn.bind(h);
  h.observeToolTurn = (turn) => {
    if (turn.facts) turns.push(turn.facts);
    // 不等待真实 120s；只替换策略时钟，事实来自真实 Loop/read 工具。
    const result = observe({ ...turn, durationMs: turnMs });
    if (result?.progressWatch) reminders.push(result.progressWatch.remind);
    return result;
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const message: ChatMessage =
      calls <= 4
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: `missing-${calls}`,
                type: 'function',
                function: { name: 'read', arguments: JSON.stringify({ path: 'missing.txt' }) },
              },
            ],
          }
        : { role: 'assistant', content: 'done' };
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await runAgent('读取文件并检查失败处理', undefined, {
      executionContext: createAgentExecutionContext({
        runId: 'progress-loop',
        workspaceRoot: root,
      }),
      checkpointWriter: { save: () => 'memory://progress-loop' },
      observer: silentRuntimeObserver,
      modelConfig: MODEL,
      contextHarness: h,
    });
    assert.equal(turns.length, 4);
    assert.ok(turns.every((turn) => turn.coverage === 'complete' && turn.failedCount === 1));
    assert.deepEqual(reminders, ['warn']);
    assert.equal(h.snapshotState().progressWatch?.noProgressTurns, 4);
    const previousHarnessState = h.snapshotState();
    const next = harness();
    await runAgent('新的独立任务', undefined, {
      executionContext: createAgentExecutionContext({
        runId: 'progress-new-run',
        workspaceRoot: root,
      }),
      checkpointWriter: { save: () => 'memory://progress-new-run' },
      observer: silentRuntimeObserver,
      modelConfig: MODEL,
      contextHarness: next,
      previousHarnessState,
    });
    assert.equal(
      next.snapshotState().progressWatch?.noProgressTurns ?? 0,
      0,
      '新 Run 继承会话上下文时不继承停滞计数',
    );
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P08 Loop 集成：检查事实进入下一请求 Context，canonical 历史保持干净', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-loop-'));
  const originalFetch = globalThis.fetch;
  const requests: ChatMessage[][] = [];
  const snapshots: CheckpointSnapshot[] = [];
  registerCheckTool({
    ...checkTool,
    getEvidenceFingerprint: () => null,
    execute: async () => ({
      content: 'fixture process passed',
      facts: {
        version: 1,
        process: {
          exitCode: 0,
          timedOut: false,
          logsComplete: true,
          stdoutRef: 'input/spill/report.log',
        },
        check: {
          profile: 'process',
          conclusion: 'passed',
          diagnostics: null,
          reportComplete: true,
        },
      },
    }),
  });
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)).messages);
    const message: ChatMessage =
      requests.length === 1
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'check-one',
                type: 'function',
                function: {
                  name: 'check',
                  arguments: JSON.stringify({ profile: 'process', program: 'fixture', args: [] }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'done' };
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await runAgent('运行检查并依据结果交付', undefined, {
      executionContext: createAgentExecutionContext({
        runId: 'evidence-loop',
        workspaceRoot: root,
      }),
      checkpointWriter: {
        save: (snapshot) => {
          snapshots.push(structuredClone(snapshot));
          return 'memory://evidence-loop';
        },
      },
      observer: silentRuntimeObserver,
      modelConfig: MODEL,
      contextHarness: new DefaultContextHarness({
        permissionMode: 'workspace-write',
        modelConfig: MODEL,
        executionBudget: false,
        goalReview: false,
        progressReminder: false,
      }),
    });
    const projected = contextText(requests[1]);
    assert.match(projected, /\[Execution evidence\]/);
    assert.match(projected, /"result":"passed"/);
    assert.match(projected, /"validity":"version-unknown"/);
    assert.match(projected, /input\/spill\/report\.log/);
    assert.ok(
      snapshots.every(
        (s) => !s.messages.some((m) => String(m.content).includes('[Execution evidence]')),
      ),
    );
    assert.equal(snapshots.at(-1)?.executionEvidence?.records.length, 1);
  } finally {
    registerCheckTool();
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P08 投影有界：过期结论明确标注，超长日志引用不占满上下文', async () => {
  const h = harness();
  const transcript = h.createTranscript('检查');
  const view = await h.prepareTurn(transcript, pad, [], undefined, {
    checks: Array.from({ length: 32 }, (_, n) => ({
      checkId: `chk-${n}`,
      profile: 'biome-lint',
      conclusion: 'passed',
      source: 'executed',
      reusable: false,
      validity: 'stale',
      finishedAt: null,
      logRefs: { stdoutRef: `input/spill/${'x'.repeat(500)}.log` },
    })),
  });
  const evidenceText = contextText(view.messages).split('[Execution evidence]')[1] ?? '';
  assert.match(evidenceText, /"validity":"stale"/);
  assert.ok(Buffer.byteLength(evidenceText) <= 2048);
  assert.ok((evidenceText.match(/"id":/g) ?? []).length <= 8);
});

test('P09 新增读取与检查都是事实进展，不要求先修改文件', () => {
  let current = createProgressWatchState();
  for (let n = 0; n < 20; n++) {
    const result = advanceProgressWatch(current, facts({ newReadCount: 1 }), 90_000);
    current = result.state;
    assert.equal(result.remind, 'none');
    assert.equal(current.noProgressTurns, 0);
  }
  const checked = advanceProgressWatch(current, facts({ newCheckCount: 1 }), 90_000);
  assert.equal(checked.remind, 'none');
});

test('P09 真实 da983164 轨迹：保留读取去重与事实提示，不生成实施阶段', async () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve('tests/fixtures/historical-run-da983164.json'), 'utf8'),
  );
  const store = createExecutionEvidenceStore();
  const h = harness();
  h.beginTask(fixture.goal, [], '/fixture');
  for (const turn of fixture.turns) {
    let novel = 0;
    for (const call of turn.calls) {
      if (!call.args.path) continue;
      novel += store.recordReads([
        {
          kind: call.tool === 'read' ? 'file' : call.tool === 'ls' ? 'ls' : 'grep',
          path: call.args.path,
          versionKind: 'content',
          version: `stable:${call.args.path}`,
          queryHash: call.args.pattern,
          returnedHash: call.resultHash,
          complete: false,
          returnedRanges: call.range ? [{ startLine: call.range[0], endLine: call.range[1] }] : [],
        },
      ]);
    }
    const observed = h.observeToolTurn({
      activity: 'read',
      durationMs: turn.durationMs,
      goal: fixture.goal,
      facts: facts({ newReadCount: novel }),
    });
    if (novel > 0) assert.equal(observed?.progressWatch, undefined);
    h.acknowledgeConvergenceReminders();
  }
  const view = await h.prepareTurn(
    h.createTranscript(fixture.goal),
    pad,
    [],
    undefined,
    store.view(),
  );
  assert.doesNotMatch(
    contextText(view.messages),
    /Implementation focus|Broad directory discovery.*paused/,
  );
  assert.ok(!('intent' in (h.snapshotState().taskFocus ?? {})));
  assert.ok(store.snapshot().reads.length > 0);
});

test('P10 用户原话与历史只作为上下文，不以关键词决定任务类型或目标替换', () => {
  const original = '给消息输入框增加草稿自动保存与恢复';
  for (const task of [
    '继续',
    '现在是什么情况',
    '继续分析另一个问题',
    '先给我调研出个计划，计划对话框给我就行',
  ]) {
    const focus = resolveTaskFocus(
      task,
      undefined,
      [{ role: 'user', content: original }],
      '/fixture',
    );
    assert.equal(focus.goal, task);
    assert.deepEqual(focus.previousRequests, [original]);
    assert.ok(!('intent' in focus));
    assert.ok(!('progress' in focus));
  }
  const legacy: ChatMessage[] = [{ role: 'user', content: original }];
  for (const [index, file] of [
    'InputBar.tsx',
    ...Array.from({ length: 20 }, (_, n) => `other${n}.ts`),
    'InputBar.tsx',
  ].entries()) {
    legacy.push(
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `read-${index}`,
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: file }) },
          },
        ],
      },
      { role: 'tool', tool_call_id: `read-${index}`, content: '1→source code' },
    );
  }
  const inherited = resolveTaskFocus('接着处理刚才的问题', undefined, legacy, '/fixture');
  assert.ok(inherited.reads.some((r) => r.path === 'InputBar.tsx' && r.version === 'unknown'));
});

test('P10 Loop：多轮调研后工具仍完整可用，模型自行选择目录查看和修改', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'implementation-loop-'));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ messages: ChatMessage[]; tools: Array<{ function: { name: string } }> }> =
    [];
  const h = new DefaultContextHarness({
    permissionMode: 'workspace-write',
    modelConfig: MODEL,
    executionBudget: false,
    goalReview: false,
    progressReminder: false,
  });
  for (let n = 1; n <= 12; n++)
    fs.writeFileSync(path.join(root, `file${n}.ts`), `const value${n} = 0;\n`);
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const n = requests.length;
    const tool =
      n <= 12
        ? { name: 'read', args: { path: `file${n}.ts` } }
        : n === 13
          ? { name: 'ls', args: { path: '.' } }
          : {
              name: 'edit',
              args: {
                path: 'file1.ts',
                edits: [{ oldText: 'const value1 = 0;', newText: 'const value1 = 1;' }],
              },
            };
    const message: ChatMessage =
      n <= 14
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: `impl-${n}`,
                type: 'function',
                function: { name: tool.name, arguments: JSON.stringify(tool.args) },
              },
            ],
          }
        : { role: 'assistant', content: 'done' };
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await runAgent('实现代码修改并验证', undefined, {
      executionContext: createAgentExecutionContext({ runId: 'impl-loop', workspaceRoot: root }),
      checkpointWriter: { save: () => 'memory://impl-loop' },
      observer: silentRuntimeObserver,
      modelConfig: MODEL,
      contextHarness: h,
    });
    for (const request of requests) {
      assert.ok(request.tools.some((tool) => tool.function.name === 'ls'));
      assert.ok(request.tools.some((tool) => tool.function.name === 'glob'));
    }
    assert.doesNotMatch(JSON.stringify(requests), /implementation-focus|Implementation focus/);
    assert.match(fs.readFileSync(path.join(root, 'file1.ts'), 'utf8'), /value1 = 1/);
    assert.equal(h.snapshotState().progressWatch?.noProgressTurns, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P10 跟进问题承接原话和读取观察，不继承或指定实施阶段', async () => {
  const h = harness();
  h.beginTask('实现草稿保存', [], '/fixture');
  await h.prepareTurn(h.createTranscript('实现草稿保存'), pad, [], undefined, {
    checks: [],
    reads: [
      {
        path: 'InputBar.tsx',
        versionKind: 'content',
        version: 'v1',
        returnedRanges: [{ startLine: 1, endLine: 812 }],
        complete: true,
      },
    ],
  });
  const status = harness();
  status.restoreState(h.snapshotState());
  status.beginTask('现在是什么情况', [], '/fixture');
  const continued = harness();
  continued.restoreState(status.snapshotState());
  assert.equal(continued.beginTask('接着处理刚才的问题', [], '/fixture'), '接着处理刚才的问题');
  const view = await continued.prepareTurn(
    continued.createTranscript('接着处理刚才的问题'),
    pad,
    [],
  );
  assert.match(contextText(view.messages), /实现草稿保存/);
  assert.match(contextText(view.messages), /现在是什么情况/);
  assert.match(contextText(view.messages), /InputBar.tsx/);
  assert.doesNotMatch(
    contextText(view.messages),
    /Implementation focus|make the smallest supported change/,
  );
  const fresh = harness();
  fresh.restoreState(continued.snapshotState());
  fresh.beginTask('分析另一个问题', [], '/another-workspace');
  assert.deepEqual(fresh.snapshotState().taskFocus?.reads, []);
});

test('P11 Loop 继续：首个请求承接原目标与已读范围，首轮可直接编辑', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'continue-loop-')));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ messages: ChatMessage[]; tools: Array<{ function: { name: string } }> }> =
    [];
  const snapshots: CheckpointSnapshot[] = [];
  const previous = harness();
  previous.beginTask('实现草稿保存', [], root);
  for (let n = 0; n < 12; n++)
    previous.observeToolTurn({ activity: 'read', durationMs: 1000, facts: newRead });
  await previous.prepareTurn(previous.createTranscript('实现草稿保存'), pad, [], undefined, {
    checks: [],
    reads: [
      {
        path: 'file.ts',
        versionKind: 'content',
        version: 'old-version',
        returnedRanges: [{ startLine: 1, endLine: 1 }],
        complete: true,
      },
    ],
  });
  fs.writeFileSync(path.join(root, 'file.ts'), 'let value = 0;\n');
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const message: ChatMessage =
      requests.length === 1
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'continue-edit',
                type: 'function',
                function: {
                  name: 'edit',
                  arguments: JSON.stringify({
                    path: 'file.ts',
                    edits: [{ oldText: 'let value = 0;', newText: 'let value = 1;' }],
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'done' };
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const h = harness();
    await runAgent('继续', undefined, {
      executionContext: createAgentExecutionContext({
        runId: 'continue-loop',
        workspaceRoot: root,
      }),
      checkpointWriter: {
        save: (s) => {
          snapshots.push(structuredClone(s));
          return 'memory://continue-loop';
        },
      },
      observer: silentRuntimeObserver,
      modelConfig: MODEL,
      contextHarness: h,
      previousHarnessState: previous.snapshotState(),
      conversationHistory: [
        { role: 'user', content: '实现草稿保存' },
        { role: 'assistant', content: '已经读过 file.ts，还未实现' },
      ],
    });
    assert.match(contextText(requests[0].messages), /Latest request.*继续/);
    assert.match(contextText(requests[0].messages), /实现草稿保存/);
    assert.match(contextText(requests[0].messages), /file.ts/);
    assert.equal(
      requests[0].tools.some((t) => t.function.name === 'ls'),
      true,
    );
    assert.equal(snapshots.at(-1)?.executionEvidence?.records.length, 0, '不继承旧检查结论');
    assert.equal(h.snapshotState().executionBudget?.usage.modelCalls, 2, '预算仍按新 Run 计量');
    assert.equal(h.snapshotState().progressWatch?.noProgressTurns, 0);
    assert.match(fs.readFileSync(path.join(root, 'file.ts'), 'utf8'), /value = 1/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P12 真实 33e2faa8 请求：完整原话保留，不投影由代码推导的实施或计划指令', async () => {
  const goal = '给消息输入框增加草稿，补充测试与构建。先给我调研出个计划，计划对话框给我就行';
  const h = harness();
  h.beginTask(goal, [], '/fixture');
  for (let n = 0; n < 13; n++) {
    const observed = h.observeToolTurn({
      activity: 'read',
      durationMs: 30_000,
      goal,
      facts: newRead,
    });
    assert.equal(observed?.progressWatch, undefined);
    h.acknowledgeConvergenceReminders();
  }
  const view = await h.prepareTurn(h.createTranscript(goal), pad, []);
  assert.match(contextText(view.messages), /计划对话框给我就行/);
  assert.match(view.messages[0].content, /Choose your own workflow and next action/);
  assert.doesNotMatch(
    contextText(view.messages),
    /Implementation focus|Use updatePlan to deliver|A successful submission completes/,
  );
});

test('P12 旧 checkpoint 的实施催促、任务分类和阶段计数不再影响恢复', async () => {
  const h = harness();
  const legacy = {
    ...h.snapshotState(),
    taskFocus: {
      goal: '先给计划，计划面板给我就行',
      intent: 'implementation',
      workspaceRoot: '/fixture',
      reads: [],
      progress: { ...createProgressWatchState(), mode: 'implementation', level: 'escalate' },
    },
    progressWatch: {
      ...createProgressWatchState(),
      mode: 'implementation',
      level: 'escalate',
      reminders: 2,
    },
    pending: {
      progressWatch: { level: 'escalate', reason: 'old implementation reminder', evidenceIds: [] },
    },
  };
  h.restoreState(legacy as unknown as ReturnType<typeof h.snapshotState>);
  h.beginTask(legacy.taskFocus.goal, [], '/fixture', true);
  assert.equal(h.snapshotState().progressWatch, undefined);
  assert.ok(!('intent' in (h.snapshotState().taskFocus ?? {})));
  assert.ok(!('progress' in (h.snapshotState().taskFocus ?? {})));
  const view = await h.prepareTurn(h.createTranscript(legacy.taskFocus.goal), pad, []);
  assert.doesNotMatch(
    contextText(view.messages),
    /old implementation reminder|Implementation focus/,
  );
});

for (const runCase of queue) await runCase();

console.log('========================================================');
console.log(`汇总: ${passes} PASS / ${failures} FAIL`);
if (failures > 0) {
  console.log('验收：事实型进度闭环存在失败用例 ✗');
  process.exit(1);
}
console.log('验收：阈值、升级上限、事实边界、投影与 resume 均成立 ✓');
