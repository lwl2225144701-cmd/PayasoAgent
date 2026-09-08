// 确定性测试：上下文预算环形指示器的纯函数（提取 / 分档 / 格式化 / tooltip）。
// 环形 SVG 渲染为 React 组件，由 tsc + build:web 保证；此处锁定数据逻辑。

import {
  contextGaugeTitle,
  findLatestContextUsage,
  formatContextTokens,
  gaugeLevel,
  summarizeRunUsage,
} from '../web/src/components/Timeline/context-gauge.js';
import type { ContextUsageEvent, HostEvent } from '../web/src/types.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
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
  usage: { totalTokens },
})) as HostEvent[];
check(
  '累计所有请求，不累计上下文或流式事件',
  summarizeRunUsage([...calls, usageEvent(), other('assistant_delta')]).tokens === 300,
);
check('完整记录不标部分', !summarizeRunUsage(calls).partial);
check('旧记录不伪造零用量', !summarizeRunUsage([other('llm_call')]).available);
check('混合记录标记部分', summarizeRunUsage([...calls, other('llm_call')]).partial);
console.log(`\nContext gauge tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
