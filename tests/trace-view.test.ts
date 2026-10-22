// 执行轨迹页组件交互回归（真实 React + jsdom）：
//   - 工具栏：时长（时间轴）/ 轮次 / 调用 三视图切换 + 搜索
//   - 时间轴视图：三泳道（输入/模型/工具）刻度只画有记录依据的时间戳
//   - 轮次视图：轮次行 + 步骤/工具计数 + 展开完整调用列表
//   - 调用视图：模型/工具调用、展开收起、参数/结果/错误、耗时与「未记录」
//   - 搜索：命中过滤调用行 / 无匹配空态
//   - 失败状态：tool_error 失败行 + 失败 Run 的错误头
//   - 运行中实时更新（SSE mock）：调用逐条出现、流式增量合并为一个块
//   - 会话切换：key 重挂后数据正确切换，不串会话
// 运行：node --import tsx tests/trace-view.test.ts
import assert from 'node:assert/strict';
import { createComponentDom } from './helpers/component-dom.js';

// ---- 事件 fixture：一条完成的 Run（含失败工具与「无 started 的 llm_call」）----

const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const at = (ms: number): string => new Date(BASE + ms).toISOString();

const RUN1_EVENTS = [
  { type: 'run_started', runId: 'run-1', timestamp: at(0) },
  { type: 'llm_call_started', step: 1, timestamp: at(100), iteration: 1, messageCount: 5 },
  {
    type: 'assistant_delta',
    runId: 'run-1',
    messageId: 'm1',
    timestamp: at(300),
    delta: '正在分析',
  },
  {
    type: 'assistant_delta',
    runId: 'run-1',
    messageId: 'm1',
    timestamp: at(400),
    delta: '代码结构',
  },
  {
    type: 'llm_call',
    step: 1,
    timestamp: at(1600), // started=100 → 1500ms，有记录依据
    iteration: 1,
    messageCount: 5,
    response: '正在分析代码结构',
    hasToolCalls: true,
    stopReason: 'toolUse',
    usage: { inputTokens: 100, outputTokens: 20 },
  },
  { type: 'tool_call', step: 2, timestamp: at(1700), tool: 'shell', args: { command: 'npm test' } },
  {
    type: 'tool_result',
    step: 2,
    timestamp: at(2500),
    tool: 'shell',
    result: 'all tests passed',
    durationMs: 800,
  },
  {
    type: 'tool_call',
    step: 3,
    timestamp: at(2600),
    tool: 'read',
    args: { path: 'input/big.txt' },
  },
  { type: 'tool_error', step: 3, timestamp: at(3000), tool: 'read', error: 'file not found' },
  {
    // 旧历史 Run 形态：没有 llm_call_started，耗时必须显示「未记录」
    type: 'llm_call',
    step: 4,
    timestamp: at(3200),
    iteration: 2,
    messageCount: 9,
    response: '已修复',
    hasToolCalls: false,
    stopReason: 'stop',
  },
  { type: 'final_answer', step: 5, timestamp: at(3300), content: 'done', totalSteps: 5 },
  { type: 'run_completed', runId: 'run-1', timestamp: at(3400), result: 'done' },
];

// 失败的 Run：run_failed 携带错误信息
const RUN2_EVENTS = [
  { type: 'run_started', runId: 'run-2', timestamp: at(0) },
  { type: 'llm_call_started', step: 1, timestamp: at(50), iteration: 1, messageCount: 3 },
  { type: 'tool_call', step: 2, timestamp: at(200), tool: 'write', args: { path: 'a.txt' } },
  { type: 'run_failed', runId: 'run-2', timestamp: at(500), error: 'provider timeout' },
];

function makeRun(
  runId: string,
  sessionId: string,
  task: string,
  status: string,
): Record<string, unknown> {
  return {
    runId,
    sessionId,
    turnIndex: 0,
    task,
    status,
    createdAt: at(0),
    updatedAt: at(60_000),
    permissionMode: 'workspace-write',
  };
}

const run1 = makeRun('run-1', 'session-A', '修复登录 bug', 'completed');
const run2 = makeRun('run-2', 'session-B', '部署服务', 'failed');

// ---- 环境替身：fetch（快照接口）与 EventSource（SSE）----

const SNAPSHOT_ROUTES: Record<string, unknown> = {
  'run-1': { events: RUN1_EVENTS },
  'run-2': { events: RUN2_EVENTS },
};

const FIXTURE = `
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TraceView } from './components/Trace';
const root = createRoot(document.getElementById('root'));
window.fixture = {
  async render(runs, sessionKey) {
    await act(async () => { root.render(<TraceView key={sessionKey} runs={runs} />); });
  },
  async unmount() { await act(async () => root.unmount()); },
  async tick(ms) {
    await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  },
  async click(el) {
    await act(async () => { el.click(); await new Promise((r) => setTimeout(r, 0)); });
  },
  async setSearch(value) {
    const input = document.querySelector('input[type="search"]');
    if (!input) throw new Error('search input not found');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
  },
  async sseEmit(type, data, seq) {
    // 对最新建立的 EventSource 发射事件，并等待 rAF flush（connectSSE 的批量上屏）
    const instances = window.EventSource.instances;
    const es = instances[instances.length - 1];
    await act(async () => {
      es.emit(type, data, seq);
      await new Promise((r) => setTimeout(r, 40));
    });
  },
};
`;

const dom = await createComponentDom(FIXTURE, {
  beforeEvaluate(window) {
    const routes = SNAPSHOT_ROUTES;
    // fetch 替身：只伺服 /runs/:id/events/snapshot
    Reflect.set(window, 'fetch', async (url: string) => {
      const match = String(url).match(/^\/runs\/([^/]+)\/events\/snapshot$/);
      if (match) {
        const body = routes[match[1]] ?? { events: [] };
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => 'not found',
      };
    });
    // EventSource 替身：记录实例，测试里直接 emit 事件
    class MockEventSource {
      static instances: unknown[] = [];
      url: string;
      listeners: Map<string, Array<(ev: unknown) => void>>;
      closed: boolean;
      constructor(url: string) {
        this.url = url;
        this.listeners = new Map();
        this.closed = false;
        MockEventSource.instances.push(this);
      }
      addEventListener(type: string, fn: (ev: unknown) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
      }
      removeEventListener() {}
      close() {
        this.closed = true;
      }
      emit(type: string, data: unknown, seq: number) {
        // connectSSE 的 handler 只读 e.data / e.lastEventId
        const event = { data: JSON.stringify(data), lastEventId: String(seq) };
        for (const fn of this.listeners.get(type) ?? []) fn(event);
      }
    }
    Reflect.set(MockEventSource, 'instances', []);
    Reflect.set(window, 'EventSource', MockEventSource);
  },
});

type Fixture = {
  render(runs: unknown[], sessionKey: string): Promise<void>;
  unmount(): Promise<void>;
  tick(ms: number): Promise<void>;
  click(el: HTMLElement): Promise<void>;
  setSearch(value: string): Promise<void>;
  sseEmit(type: string, data: unknown, seq: number): Promise<void>;
};
const fixture = Reflect.get(dom.window, 'fixture') as Fixture;

type MockEventSource = {
  url: string;
  closed: boolean;
  emit(type: string, data: unknown, seq: number): void;
};

const doc = dom.window.document;
const $text = (): string => doc.body.textContent ?? '';

/** 点击工具栏视图按钮（按精确文本匹配：时长 / 轮次 / 调用） */
async function clickView(label: string): Promise<void> {
  const btn = [...doc.querySelectorAll('button')].find((b) => b.textContent === label);
  assert.ok(btn, `视图按钮「${label}」存在`);
  await fixture.tick(0);
  await fixture.click(btn);
  await fixture.tick(0);
}

try {
  // ---- 场景 1a：默认时间轴视图 + 工具栏 ----
  await fixture.render([run1], 'session-A');
  await fixture.tick(30);

  assert.ok($text().includes('时长'), '视图按钮：时长');
  assert.ok($text().includes('轮次'), '视图按钮：轮次');
  assert.ok($text().includes('调用'), '视图按钮：调用');
  assert.ok(doc.querySelector('input[type="search"]'), '搜索框存在');

  // 时间轴：三泳道标签 + 刻度只画有记录依据的时间戳
  await clickView('时长');
  assert.ok($text().includes('输入'), '泳道标签：输入');
  assert.ok($text().includes('模型'), '泳道标签：模型');
  assert.ok($text().includes('工具'), '泳道标签：工具');
  const timeline = doc.querySelector('[role="img"]');
  assert.ok(timeline, '时间轴容器（role=img）');
  // 刻度：输入 1（run_started）+ 模型 2（有 started 的 + 无 started 回退 endedAt）+ 工具 2
  const ticks = [...doc.querySelectorAll('span[title]')];
  assert.equal(ticks.length, 5, '时间轴刻度数量（无时间戳的调用不画）');
  assert.ok(
    ticks.some((t) => (t.getAttribute('title') ?? '').includes('800毫秒')),
    '工具刻度 tooltip 含有记录的耗时',
  );
  assert.ok(
    ticks.some((t) => t.getAttribute('title') === '修复登录 bug'),
    '输入刻度 tooltip 为任务文本',
  );

  // ---- 场景 1b：调用视图 —— 快照展示 + 展开/收起 + 失败状态 + 未记录耗时 ----
  await clickView('调用');
  assert.ok($text().includes('修复登录 bug'), 'Run 任务标题应出现在分组头');
  assert.ok($text().includes('模型调用 · 第 1 轮'), '带 iteration 的模型调用名称');
  assert.ok($text().includes('第 1 轮'), '分组头的轮次标签');
  assert.ok($text().includes('Shell'), '工具调用 Shell 行');
  assert.ok($text().includes('Read'), '工具调用 Read 行');
  assert.ok($text().includes('1.5秒'), '模型调用耗时（两端时间戳之差，有记录依据）');
  assert.ok($text().includes('800毫秒'), '工具实测耗时（tool_result.durationMs）');
  assert.ok($text().includes('失败'), '失败工具调用的状态词');
  assert.ok($text().includes('未记录'), '无 llm_call_started 的调用显示未记录');

  // 展开 Shell 行：参数 + 结果；再点一次收起
  const buttons = [...doc.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')];
  const shellRow = buttons.find((b) => b.getAttribute('aria-label')?.includes('Shell'));
  assert.ok(shellRow, 'Shell 行可点击');
  await fixture.tick(0);
  await fixture.click(shellRow);
  await fixture.tick(0);
  assert.ok($text().includes('npm test'), '展开后可见参数');
  assert.ok($text().includes('all tests passed'), '展开后可见结果');
  assert.equal(shellRow.getAttribute('aria-expanded'), 'true', 'aria-expanded 翻转');
  await fixture.click(shellRow);
  await fixture.tick(0);
  assert.equal(shellRow.getAttribute('aria-expanded'), 'false', '再次点击收起');
  assert.ok(!$text().includes('all tests passed'), '收起后结果不可见');

  // 展开 Read 行：失败信息可见
  const readRow = [...doc.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) =>
    b.getAttribute('aria-label')?.includes('Read'),
  );
  assert.ok(readRow, 'Read 行可点击');
  await fixture.click(readRow);
  await fixture.tick(0);
  assert.ok($text().includes('file not found'), '失败工具展开后展示错误信息');

  // 流式增量合并：合并文本作为一整块出现（不逐 token 成行）
  const modelRow = [...doc.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) =>
    b.getAttribute('aria-label')?.includes('第 1 轮'),
  );
  assert.ok(modelRow, '模型行可点击');
  await fixture.click(modelRow);
  await fixture.tick(0);
  assert.ok($text().includes('正在分析代码结构'), '两条 delta 合并后的完整文本');
  assert.ok(!$text().includes('正在分析\n代码结构'), '增量之间不应被拆成多行');

  // ---- 场景 1c：搜索过滤调用行 / 无匹配空态 ----
  await fixture.setSearch('npm test');
  await fixture.tick(0);
  assert.ok($text().includes('npm test'), '搜索命中：Shell 行保留');
  assert.ok(!$text().includes('input/big.txt'), '搜索命中：未命中的 Read 行被过滤');

  await fixture.setSearch('zzz-no-match');
  await fixture.tick(0);
  assert.ok($text().includes('没有匹配'), '搜索无匹配显示空态');

  await fixture.setSearch('');
  await fixture.tick(0);
  // 过滤期间未命中的行被卸载（展开态不保留），恢复后以折叠态重新挂载
  assert.ok($text().includes('input/big.txt'), '清空搜索后调用行恢复');
  assert.ok($text().includes('npm test'), '清空搜索后 Shell 行仍在');

  // ---- 场景 1d：轮次视图 —— 轮次行 + 计数 + 展开调用列表 ----
  await clickView('轮次');
  assert.ok($text().includes('第 1 轮'), '轮次标签');
  assert.ok($text().includes('用户'), '用户徽标');
  assert.ok($text().includes('修复登录 bug'), '轮次行任务文本');
  assert.ok($text().includes('4 个步骤'), '步骤计数（模型 2 + 工具 2）');
  assert.ok($text().includes('2 个工具调用'), '工具调用计数');
  assert.ok(!$text().includes('all tests passed'), '折叠状态不显示调用明细');

  const turnRow = [...doc.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find(
    (b) => b.getAttribute('aria-expanded') === 'false',
  );
  assert.ok(turnRow, '轮次行可展开');
  await fixture.click(turnRow);
  await fixture.tick(0);
  assert.equal(turnRow.getAttribute('aria-expanded'), 'true', '轮次行展开');
  assert.ok($text().includes('Shell'), '展开后显示调用列表');
  assert.ok($text().includes('1.5秒'), '展开后显示调用耗时');
  await fixture.click(turnRow);
  await fixture.tick(0);
  assert.ok(!$text().includes('1.5秒'), '收起后调用明细隐藏');

  // ---- 场景 2：失败的 Run（快照）→ 错误头 + 状态 ----
  await fixture.render([run2], 'session-B');
  await fixture.tick(30);
  await clickView('调用');
  assert.ok($text().includes('部署服务'), '失败 Run 的标题');
  assert.ok($text().includes('provider timeout'), 'run_failed 的错误信息展示在分组头');
  assert.ok(!$text().includes('修复登录 bug'), '会话切换后不残留上一会话数据');

  // ---- 场景 3：切回会话 A（key 重挂）→ 数据正确恢复 ----
  await fixture.render([run1], 'session-A');
  await fixture.tick(30);
  await clickView('调用');
  assert.ok($text().includes('修复登录 bug'), '切回会话 A 后数据恢复');
  assert.ok(!$text().includes('provider timeout'), '不残留会话 B 数据');

  // ---- 场景 4：运行中的 Run 实时更新（SSE）----
  const liveRun = makeRun('run-live', 'session-A', '实时任务', 'running');
  await fixture.render([liveRun], 'session-live');
  await clickView('调用');

  const sources = Reflect.get(dom.window.EventSource, 'instances') as MockEventSource[];
  const live = sources[sources.length - 1];
  assert.ok(live, '运行中 Run 建立了 SSE 连接');
  assert.ok(live.url === '/runs/run-live/events', 'SSE 地址正确');

  // run_started 到达后 Run 分组头出现
  await fixture.sseEmit(
    'run_started',
    { type: 'run_started', runId: 'run-live', timestamp: at(0) },
    1,
  );
  assert.ok($text().includes('实时任务'), '运行中 Run 的标题');

  // llm_call_started → 流式增量（合并展示）
  await fixture.sseEmit(
    'llm_call_started',
    { type: 'llm_call_started', step: 1, timestamp: at(10), iteration: 1, messageCount: 2 },
    2,
  );
  await fixture.sseEmit(
    'assistant_delta',
    {
      type: 'assistant_delta',
      runId: 'run-live',
      messageId: 'lm',
      timestamp: at(20),
      delta: '第一段',
    },
    3,
  );
  await fixture.sseEmit(
    'assistant_delta',
    {
      type: 'assistant_delta',
      runId: 'run-live',
      messageId: 'lm',
      timestamp: at(30),
      delta: '第二段',
    },
    4,
  );
  assert.ok($text().includes('第一段第二段'), '流式增量合并为一个块实时更新');

  // 工具调用实时出现 → 结果到达后状态翻转为已完成
  await fixture.sseEmit(
    'tool_call',
    { type: 'tool_call', step: 2, timestamp: at(40), tool: 'shell', args: { command: 'ls' } },
    5,
  );
  assert.ok($text().includes('Shell'), '工具调用实时出现');
  const liveShell = [...doc.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find(
    (b) => b.getAttribute('aria-label')?.includes('Shell'),
  );
  assert.ok(liveShell?.getAttribute('aria-label')?.includes('执行中'), '工具调用初始为执行中');

  await fixture.sseEmit(
    'tool_result',
    {
      type: 'tool_result',
      step: 2,
      timestamp: at(90),
      tool: 'shell',
      result: 'ok',
      durationMs: 250,
    },
    6,
  );
  assert.ok(
    liveShell?.getAttribute('aria-label')?.includes('已完成'),
    'tool_result 到达后状态实时翻转为已完成',
  );
  assert.ok($text().includes('250毫秒'), '实时路径的耗时展示');

  // 终态事件 → SSE 关闭（不再占用连接），状态保持
  await fixture.sseEmit(
    'run_completed',
    { type: 'run_completed', runId: 'run-live', timestamp: at(120), result: 'ok' },
    7,
  );
  assert.equal(live.closed, true, '收到终态事件后关闭 EventSource');

  // ---- 场景 5：空会话 → 空态文案 ----
  await fixture.render([], 'session-empty');
  assert.ok($text().includes('本会话还没有执行记录'), '空会话显示空态文案');

  await fixture.unmount();
  console.log(
    'Trace view: timeline/turns/calls views, search, live update, session switch, failures PASS',
  );
} finally {
  dom.window.close();
}
