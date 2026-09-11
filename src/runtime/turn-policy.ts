// 模块: TurnPolicy —— runAgent 的回合收尾策略判定（纯函数）。
//
// 为什么单独存在：空回合（无工具调用且无可见内容）与未完成收尾（计划式文本
// 但未调用工具）的「是否可恢复 / 恢复后追加什么」是 Harness 策略；但「有界
// 恢复预算的判定」是 Runtime 的规则。判定逻辑独立成纯函数后：策略词汇归
// Harness（EmptyTurnPolicy / IncompleteTurnPolicy），预算判定归 TurnPolicy，
// runAgent 主循环只消费决策结果并执行副作用。

import type { EmptyTurnPolicy, IncompleteTurnPolicy } from '../harness/context-harness.js';

/** 空回合 / 未完成收尾的决策结果。主循环据此执行副作用（log/emit/state/push/save）。 */
export type TurnRecoveryDecision =
  | { kind: 'recover'; nudge: string; attempt: number; maxAttempts: number; reason?: string }
  | { kind: 'fail'; attempt: number; maxAttempts: number; reason?: string }
  | { kind: 'accept' };

/**
 * 空回合不变量（v1.8）：模型没有工具调用且没有可见内容 → 不是答案。
 * 策略存在且恢复预算未用尽 → recover（追加提示重试）；否则 fail loudly。
 */
export function decideEmptyTurn(
  policy: EmptyTurnPolicy | undefined,
  recoveries: number,
): TurnRecoveryDecision {
  if (policy && recoveries < policy.maxRecoveries) {
    return {
      kind: 'recover',
      nudge: policy.nudge,
      attempt: recoveries + 1,
      maxAttempts: policy.maxRecoveries,
    };
  }
  return { kind: 'fail', attempt: recoveries + 1, maxAttempts: policy?.maxRecoveries ?? 0 };
}

/**
 * 未完成收尾判定（v1.8）：模型产出非空计划式文本但未调用工具 → 可能没做完。
 * 策略存在且预算未用尽 → recover；预算用尽 → fail（AgentStalledError）；
 * 无策略 → accept（接受回答，走正常收尾）。
 */
export function decideIncompleteTurn(
  policy: IncompleteTurnPolicy | undefined,
  recoveries: number,
): TurnRecoveryDecision {
  if (!policy) return { kind: 'accept' };
  const attempt = recoveries + 1;
  const canRecover = recoveries < policy.maxRecoveries;
  if (canRecover) {
    return {
      kind: 'recover',
      nudge: policy.nudge,
      attempt,
      maxAttempts: policy.maxRecoveries,
      reason: policy.reason,
    };
  }
  return { kind: 'fail', attempt, maxAttempts: policy.maxRecoveries, reason: policy.reason };
}
