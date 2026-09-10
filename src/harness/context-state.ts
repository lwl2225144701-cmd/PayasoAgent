import { createPlan, normalizePlan, type Plan } from './plan.js';

export interface ContextHarnessState {
  conversationSummary: string;
  summarizedMessageCount: number;
  // Agent 自述的任务清单：由 Harness 持有，随 checkpoint 的 harnessState 一起持久化
  // （因此不需要给 CheckpointSnapshot 加字段）。旧 checkpoint 无此字段 → 空计划。
  plan: Plan;
}

export function createContextHarnessState(): ContextHarnessState {
  return { conversationSummary: '', summarizedMessageCount: 0, plan: createPlan() };
}

export function normalizeContextHarnessState(
  value: ContextHarnessState | undefined,
): ContextHarnessState {
  if (!value) return createContextHarnessState();
  return {
    conversationSummary:
      typeof value.conversationSummary === 'string' ? value.conversationSummary : '',
    summarizedMessageCount:
      Number.isSafeInteger(value.summarizedMessageCount) && value.summarizedMessageCount >= 0
        ? value.summarizedMessageCount
        : 0,
    plan: normalizePlan((value as { plan?: unknown }).plan),
  };
}
