// 模块: Run 停止原因与交付结果的词汇与映射（Host 纯函数）。
//
// 为什么单独存在：「为什么停止」与「目标完成了多少」是两个问题——
//   - run.status 回答"执行是否结束"（completed/stopped/failed…）；
//   - stopReason 回答"为什么停"（预算耗尽 / 策略拒绝 / 用户取消…）；
//   - deliveryOutcome 回答"目标完成了多少"（delivered/partial/blocked/unknown）。
// 三者的词汇与映射规则是 Host 业务语义（Runtime 只给稳定码，Store 只落库），
// 独立成纯函数后才能被确定性测试锁定，也避免 UI 各写一份推导。
//
// 依赖方向说明：本模块是 stopReason/deliveryOutcome/RunTerminalStatus 词汇的
// 唯一 owner（store.ts / run-events.ts / run-types.ts 都从这里取），因此
// persistence/store.ts 与 run-events.ts 不再互相 import 类型——那会形成
// store → run-events → store 的导入环（architecture-boundaries 锁死）。

import type { AgentStopReasonCode } from '../runtime/agent.js';

/** Run 终态（运行生命周期语义；与交付结果正交）。 */
export type RunTerminalStatus = 'completed' | 'failed' | 'stopped';

/**
 * 稳定停止原因码（Host 持久化身份；与 Runtime `AgentStopReasonCode` 同源，
 * 映射见 toStoredStopReason）。界面与 API 只认这些码，不用自然语言充当身份。
 */
export type StoredStopReason =
  | 'budget_exhausted'
  | 'policy_denied'
  | 'tool_unavailable'
  | 'outcome_uncertain'
  | 'user_cancelled';

/**
 * 交付结果（与 run.status 正交）：status 回答"执行是否结束"，
 * deliveryOutcome 回答"目标完成了多少"。预算耗尽停止 = partial，
 * 绝不能显示为任务成功。
 */
export type StoredDeliveryOutcome = 'delivered' | 'partial' | 'blocked' | 'unknown';

/**
 * Runtime 停止原因码 → Host 持久化码。穷尽匹配：Runtime 新增码而这里没跟进
 * 时 TS 直接报错（never 收尾），避免"新原因静默变 unknown"。
 */
export function toStoredStopReason(code: AgentStopReasonCode): StoredStopReason {
  switch (code) {
    case 'budget_exhausted':
    case 'policy_denied':
    case 'tool_unavailable':
    case 'outcome_uncertain':
    case 'user_cancelled':
      return code;
    default: {
      const exhaustive: never = code;
      throw new Error(`Unknown stop reason code: ${String(exhaustive)}`);
    }
  }
}

/**
 * 交付结果机械派生（与 run.status 正交）：
 * - completed 且有停止原因（如预算耗尽后模型仍给出回答）→ partial；
 * - stopped：预算 → partial；策略/工具/uncertain → blocked；用户主动停止 / 无原因
 *   → unknown（用户停止不构成"受阻"，也不构成任何完成度声明）；
 * - failed → unknown（失败不构成任何交付声明）。
 */
export function deriveDeliveryOutcome(
  status: RunTerminalStatus,
  stopReason: StoredStopReason | undefined,
): StoredDeliveryOutcome {
  if (status === 'completed') return stopReason === undefined ? 'delivered' : 'partial';
  if (status === 'stopped') {
    if (stopReason === 'budget_exhausted') return 'partial';
    if (stopReason !== undefined && stopReason !== 'user_cancelled') return 'blocked';
    return 'unknown';
  }
  return 'unknown';
}
