// 上下文预算环形指示器（v1.6）：把 Context Budget / 压缩 / 紧急裁剪
// 的状态投影到前端 —— 环的填充比例 = 当前上下文占用，颜色随占用率分级，
// 悬停可查看模型 / 估算 / 预算明细。纯函数与组件分离，便于 node 测试。

import type { HostEvent, ContextUsageEvent } from '../../types';

/** 取事件流中最新一条 context_usage（无则 null）。 */
export function findLatestContextUsage(events: HostEvent[]): ContextUsageEvent | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === 'context_usage') return event;
  }
  return null;
}

/** 占用率分档：<70% 正常，<90% 警告，≥90% 危险（≥100% 必然已超限）。 */
export function gaugeLevel(ratio: number): 'normal' | 'warning' | 'danger' {
  if (ratio >= 0.9) return 'danger';
  if (ratio >= 0.7) return 'warning';
  return 'normal';
}

/** token 数 → 紧凑展示（8549 → "8.5K"，512000 → "512K"）。 */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`;
  }
  return String(tokens);
}

/** 悬停明细（模型 / 已用 / 预算 / 占比 / 特殊状态）。 */
export function contextGaugeTitle(usage: ContextUsageEvent): string {
  const parts = [
    `上下文 ${formatContextTokens(usage.estimatedInputTokens)} / ${formatContextTokens(usage.inputBudgetTokens)} tokens（${Math.round(usage.usageRatio * 100)}%）`,
    `模型 ${usage.model}`,
  ];
  if (usage.emergencyTrim) parts.push('已触发紧急裁剪');
  if (usage.configSource === 'fallback') parts.push('模型能力未知，按保守预算估计');
  return parts.join(' · ');
}
