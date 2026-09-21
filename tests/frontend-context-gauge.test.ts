// 确定性测试：上下文预算环形指示器的纯函数（提取 / 分档 / 格式化 / tooltip）。
// 环形 SVG 渲染为 React 组件，由 tsc + build:web 保证；此处锁定数据逻辑。

import {
  applyCompactUsage,
  compactStatusText,
  contextGaugeTitle,
  deriveModelWaitState,
  deriveRunStreamMetrics,
  deriveRunTokenUsage,
  findLatestContextUsage,
  formatBudgetDerivation,
  formatContextTokens,
  formatTokenBreakdown,
  gaugeLevel,
  summarizeRunUsage,
} from '../web/src/components/Timeline/context-gauge.js';
import type { ContextUsageEvent, HostEvent, TokenUsage } from '../web/src/types.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const base = { runId: 'r', step: 1, timestamp: '2026-09-06T00:00:00.000Z' };
const usageEvent = (over: Partial<ContextUsageEvent> = {}): ContextUsageEvent => ({
  ...base,
  type: 'context_usage',
  model: 'step-3.7-flash',
  modelSource: 'run',
  configSource: 'fallback',
  contextWindowTokens: 32_768,
  maxOutputTokens: 4_096,
  safetyTokens: 2_048,
  inputBudgetTokens: 26_624,
  messageTokens: 5_000,
  toolSchemaTokens: 1_400,
  scratchpadTokens: 140,
  estimatedInputTokens: 8_549,
  usageRatio: 0.32,
  trimmedMessages: 0,
  overBudget: false,
  ...over,
});
const other = (type: string): HostEvent => ({ ...base, type }) as HostEvent;

// ---- findLatestContextUsage ----
check('空事件流 → null', findLatestContextUsage([]) === null);
check(
  '忽略非 context_usage 事件',
  (() => {
    const r = findLatestContextUsage([other('llm_call'), other('tool_call')]);
    return r === null;
  })(),
);
check(
  '取最后一条 context_usage',
  (() => {
    const r = findLatestContextUsage([
      other('llm_call'),
      usageEvent({ usageRatio: 0.3 }),
      other('tool_call'),
      usageEvent({ usageRatio: 0.8 }),
    ]);
    return r?.usageRatio === 0.8;
  })(),
);

// ---- gaugeLevel 分档 ----
check('分档: <70% → normal', gaugeLevel(0.32) === 'normal' && gaugeLevel(0.69) === 'normal');
check('分档: 70%~90% → warning', gaugeLevel(0.7) === 'warning' && gaugeLevel(0.89) === 'warning');
check(
  '分档: ≥90% → danger（含超限）',
  gaugeLevel(0.9) === 'danger' && gaugeLevel(1.07) === 'danger',
);

// ---- formatContextTokens ----
check('格式化: 8549 → "8.5K"', formatContextTokens(8_549) === '8.5K');
check('格式化: 26624 → "26.6K"', formatContextTokens(26_624) === '26.6K');
check('格式化: 512000 → "512K"', formatContextTokens(512_000) === '512K');
check('格式化: 小数值原样', formatContextTokens(512) === '512');

// ---- tooltip ----
const title = contextGaugeTitle(usageEvent());
check(
  'tooltip: 含模型 / 已用 / 预算 / 占比',
  title.includes('step-3.7-flash') &&
    title.includes('8.5K') &&
    title.includes('26.6K') &&
    title.includes('32%'),
);
check('tooltip: fallback 提示能力未知', title.includes('能力未知'));
check(
  'tooltip: emergencyTrim 提示紧急裁剪',
  contextGaugeTitle(usageEvent({ emergencyTrim: true })).includes('紧急裁剪'),
);

check('百万 token 保留一位小数', formatContextTokens(2_500_000) === '2.5M');
const calls = [100, 200].map((totalTokens, step) => ({
  ...base,
  step,
  type: 'llm_call',
  messageCount: 2,
  iteration: step + 1,
  response: '',
  hasToolCalls: false,
  // 旧持久化记录只有 totalTokens（无分桶）；类型上以 unknown 桥接（运行期合法）。
  usage: { totalTokens },
})) as unknown as HostEvent[];
check(
  '累计所有请求，不累计上下文或流式事件',
  summarizeRunUsage([...calls, usageEvent(), other('assistant_delta')]).tokens === 300,
);
check('完整记录不标部分', !summarizeRunUsage(calls).partial);
check('旧记录不伪造零用量', !summarizeRunUsage([other('llm_call')]).available);
check('混合记录标记部分', summarizeRunUsage([...calls, other('llm_call')]).partial);

// ---- 新分桶记录（v1.7）：分桶求和 / 校验 / last-wins ----
const bucketCall = (
  iteration: number,
  usage: TokenUsage,
  timestamp = '2026-09-06T00:00:00.000Z',
): HostEvent =>
  ({
    ...base,
    type: 'llm_call',
    messageCount: 2,
    iteration,
    response: '',
    hasToolCalls: false,
    usage,
    timestamp,
  }) as HostEvent;

check(
  '分桶记录按桶求和（input 未缓存 / output / cache / reasoning）',
  (() => {
    const r = deriveRunTokenUsage([
      bucketCall(1, { inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      bucketCall(2, {
        inputTokens: 300,
        outputTokens: 120,
        totalTokens: 620,
        cacheReadTokens: 200,
        reasoningTokens: 50,
      }),
    ]);
    return (
      r.inputTokens === 400 &&
      r.outputTokens === 170 &&
      r.cacheReadTokens === 200 &&
      r.reasoningTokens === 50 &&
      r.tokens === 770 &&
      r.hasBuckets &&
      !r.partial
    );
  })(),
);

check(
  '同一迭代 last-wins：重复 usage 替换而非累加',
  (() => {
    const r = deriveRunTokenUsage([
      bucketCall(1, { inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      bucketCall(1, { inputTokens: 200, outputTokens: 80, totalTokens: 280 }),
    ]);
    return r.tokens === 280 && r.inputTokens === 200 && r.outputTokens === 80;
  })(),
);

check(
  '校验失败的分桶视为缺失（宁缺勿错）→ 标部分',
  (() => {
    const r = deriveRunTokenUsage([
      bucketCall(1, { inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      bucketCall(2, { inputTokens: 10, outputTokens: 5, reasoningTokens: 999, totalTokens: 15 }),
    ]);
    return r.tokens === 150 && r.available && r.partial;
  })(),
);

check(
  '分桶展示：有 cache/推理时输出分项',
  formatTokenBreakdown(
    deriveRunTokenUsage([
      bucketCall(1, {
        inputTokens: 300,
        outputTokens: 120,
        totalTokens: 620,
        cacheReadTokens: 200,
        reasoningTokens: 50,
      }),
    ]),
  ).includes('输入 300') && formatTokenBreakdown(summarizeRunUsage([])) === '',
);

// ---- 流式指标：首 token 延迟 / 解码速度 ----
const streamEvents: HostEvent[] = [
  { ...base, type: 'run_started', runId: 'r', timestamp: '2026-09-06T00:00:00.000Z' },
  bucketCall(
    1,
    { inputTokens: 300, outputTokens: 200, totalTokens: 500 },
    '2026-09-06T00:00:01.000Z',
  ),
  {
    ...base,
    type: 'assistant_delta',
    runId: 'r',
    messageId: 'm',
    delta: 'a',
    timestamp: '2026-09-06T00:00:01.500Z',
  },
  {
    ...base,
    type: 'reasoning_delta',
    runId: 'r',
    messageId: 'm',
    delta: 'b',
    timestamp: '2026-09-06T00:00:02.000Z',
  },
  {
    ...base,
    type: 'assistant_delta',
    runId: 'r',
    messageId: 'm',
    delta: 'c',
    timestamp: '2026-09-06T00:00:02.500Z',
  },
];
check(
  '流式指标：ttft = 首 delta − run 开始；tps = 真实 output ÷ 首末差',
  (() => {
    const m = deriveRunStreamMetrics(streamEvents);
    return m.ttftMs === 1500 && m.tokensPerSecond === 200 && m.decodeMs === 1000;
  })(),
);
check(
  '无 run_started 时不产出 ttft',
  deriveRunStreamMetrics(streamEvents.slice(1)).ttftMs === undefined,
);

// ---- 锚点标题 ----
check(
  'tooltip: 有真实压力锚点时标注上次上报',
  contextGaugeTitle(usageEvent({ pressureTokens: 6_000 })).includes('上次上报真实 6K'),
);

// ---- 预算推导说明（解释分母为何小于窗口，如 1M 窗口 → 976K 预算）----
check(
  '预算推导: 1M 窗口 = 976K 预算 + 4.1K 输出 + 20K 安全',
  formatBudgetDerivation(
    usageEvent({
      contextWindowTokens: 1_000_000,
      inputBudgetTokens: 975_904,
      maxOutputTokens: 4_096,
      safetyTokens: 20_000,
    }),
  ) === '窗口 1M = 预算 976K + 输出预留 4.1K + 安全 20K',
);

// ---- /compact 状态行文案 ----
check('compact: 进行中文案', compactStatusText({ phase: 'running' }) === '正在压缩…');
check(
  'compact: 量化结果',
  compactStatusText({ phase: 'done', summarizedMessages: 70, compactedTokens: 67_825 }) ===
    '已压缩 70 条历史记录（约 67.8K tokens）',
);
check(
  'compact: 缺 checkpoint 提示',
  compactStatusText({
    phase: 'done',
    summarizedMessages: 0,
    compactedTokens: 0,
    reason: 'no_checkpoint',
  }) === '该会话没有可用的运行记录（checkpoint），无法压缩',
);
check(
  'compact: 无可压缩历史',
  compactStatusText({ phase: 'done', summarizedMessages: 0, compactedTokens: 0 }) ===
    '没有可压缩的历史记录',
);

// ---- /compact 后即时刷新占用环（合成 context_usage）----
check(
  'applyCompactUsage: 替换占用字段并清掉压力锚点/紧急裁剪',
  (() => {
    const prev = usageEvent({ pressureTokens: 100_000, emergencyTrim: true, usageRatio: 0.9 });
    const next = applyCompactUsage(prev, {
      messageTokens: 6_000,
      systemTokens: 1_300,
      toolSchemaTokens: 1_400,
      estimatedInputTokens: 7_400,
      inputBudgetTokens: 26_624,
      usageRatio: 0.28,
    });
    return (
      next !== null &&
      next.estimatedInputTokens === 7_400 &&
      next.messageTokens === 6_000 &&
      next.usageRatio === 0.28 &&
      next.pressureTokens === undefined &&
      next.emergencyTrim === false &&
      next.model === 'step-3.7-flash' &&
      next.configSource === 'fallback'
    );
  })(),
  '保留 model/config 等上一轮字段',
);
check(
  'applyCompactUsage: 无上一轮事件时返回 null',
  applyCompactUsage(null, {
    messageTokens: 1,
    toolSchemaTokens: 1,
    estimatedInputTokens: 2,
    inputBudgetTokens: 10,
    usageRatio: 0.2,
  }) === null,
);

// ---- deriveModelWaitState：首 token 等待期判定 ----
const llmStart = (over: Record<string, unknown> = {}): HostEvent =>
  ({
    ...base,
    type: 'llm_call_started',
    iteration: 2,
    messageCount: 150,
    estimatedInputTokens: 125_000,
    ...over,
  }) as HostEvent;
const nowAfter = Date.parse('2026-09-06T00:00:14.000Z');
check(
  '最后一条是 llm_call_started → 返回等待状态（轮次/消息数/估算 tokens）',
  (() => {
    const s = deriveModelWaitState([llmStart()], nowAfter);
    return (
      s !== null &&
      s.iteration === 2 &&
      s.messageCount === 150 &&
      s.estimatedInputTokens === 125_000
    );
  })(),
);
check(
  'llm_call_started 后跟 reasoning_delta → 等待结束（null）',
  deriveModelWaitState(
    [
      llmStart(),
      {
        type: 'reasoning_delta',
        runId: 'r',
        messageId: 'm1',
        timestamp: base.timestamp,
        delta: '思',
      },
    ],
    nowAfter,
  ) === null,
);
check(
  'llm_call_started 后跟 tool_result → 等待结束（null）',
  deriveModelWaitState(
    [llmStart(), { ...base, type: 'tool_result', tool: 'grep', result: 'x', durationMs: 1 }],
    nowAfter,
  ) === null,
);
check('事件流为空 → null', deriveModelWaitState([], nowAfter) === null);
check(
  '最后一条是其它事件（tool_result）→ null',
  deriveModelWaitState(
    [{ ...base, type: 'tool_result', tool: 'grep', result: 'x', durationMs: 1 }],
    nowAfter,
  ) === null,
);
check(
  'now 早于 startedAt（时钟回拨）→ null',
  deriveModelWaitState([llmStart({ timestamp: '2026-09-06T00:00:20.000Z' })], nowAfter) === null,
);
check(
  'estimatedInputTokens 缺省 → 字段省略',
  (() => {
    const s = deriveModelWaitState([llmStart({ estimatedInputTokens: undefined })], nowAfter);
    return s !== null && s.estimatedInputTokens === undefined;
  })(),
);

// llm_request_sent：请求真正发出后的等待状态（秒数锚点前移到 requestSentAt）
const requestSent = (over: Record<string, unknown> = {}): HostEvent =>
  ({
    ...base,
    type: 'llm_request_sent',
    iteration: 2,
    attempt: 1,
    ...over,
  }) as HostEvent;
check(
  '最后一条是 llm_request_sent → 返回等待状态（requestSentAt/attempt + 回退 llm_call_started 字段）',
  (() => {
    const s = deriveModelWaitState(
      [llmStart({ timestamp: '2026-09-06T00:00:10.000Z' }), requestSent()],
      nowAfter,
    );
    return (
      s !== null &&
      s.iteration === 2 &&
      s.messageCount === 150 &&
      s.estimatedInputTokens === 125_000 &&
      s.requestSentAt === base.timestamp &&
      s.attempt === 1 &&
      s.startedAt === '2026-09-06T00:00:10.000Z'
    );
  })(),
);
check(
  'llm_request_sent 后跟 assistant_delta → 等待结束（null）',
  deriveModelWaitState(
    [
      llmStart(),
      requestSent(),
      {
        type: 'assistant_delta',
        runId: 'r',
        messageId: 'm1',
        timestamp: base.timestamp,
        delta: '你',
      },
    ],
    nowAfter,
  ) === null,
);
check(
  'llm_request_sent 无对应 llm_call_started（异常流）→ 回退自身字段',
  (() => {
    const s = deriveModelWaitState([requestSent()], nowAfter);
    return (
      s !== null &&
      s.iteration === 2 &&
      s.messageCount === 0 &&
      s.requestSentAt === base.timestamp &&
      s.startedAt === base.timestamp
    );
  })(),
);

check('同轮交付检查独立计费，重放同一检查事件不重复累计', (() => {
  const event = { type: 'llm_call' as const, step: 1, timestamp: '2026-09-20', iteration: 1, messageCount: 2,
    response: '', hasToolCalls: false, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  const first = { ...event, step: 2, purpose: 'final_review' as const };
  const second = { ...event, step: 3, purpose: 'final_review' as const };
  return deriveRunTokenUsage([event, first, second, first]).tokens === 45;
})());
console.log(`\nContext gauge tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
