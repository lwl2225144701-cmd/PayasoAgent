// 提交决策（方案 §5.4 唯一优先级）：policy → apply --check → 交实际 patch / 空 patch。
// 纯函数：IO（git apply 预检）由调用方算好传入，结果可单测（decision.test.ts）。
import type { PolicyVerdict } from './policy.js';

export type SubmissionStatus = 'ok' | 'empty_patch' | 'patch_invalid' | 'policy_invalid' | 'runner_fault';

export interface DecisionInput {
  /** runner 层已经判定的管线故障（clone/agent 执行失败等）——直接 runner_fault */
  runnerFaults: readonly string[];
  /** 捕获到的原始 diff（可能为空） */
  patch: string;
  /** policy 检测结果（A2） */
  policy: PolicyVerdict;
  /** git apply --check 预检结果（patch 非空时才算） */
  applyOk: boolean;
  applyError?: string;
}

export interface Decision {
  status: SubmissionStatus;
  /** true = preds.jsonl 里交实际 patch；false = 交空 patch */
  approvedPatch: boolean;
}

/**
 * 判定规则（§5.4）：
 *   1. runner 故障 → 空 patch（可能是仍在变化的文件，不可提交）
 *   2. 无 patch   → empty_patch，空 patch
 *   3. policy 命中 → policy_invalid，空 patch（原始留档）
 *   4. apply 不过  → patch_invalid，空 patch（原始留档）
 *   5. 其余        → ok，交实际 patch
 * 注意：timeout/budget 只是过程标签，不参与本判定（§5.4 v1.2）。
 */
export function decideSubmission(input: DecisionInput): Decision {
  if (input.runnerFaults.length > 0) return { status: 'runner_fault', approvedPatch: false };
  if (!input.patch.trim()) return { status: 'empty_patch', approvedPatch: false };
  if (input.policy.policyInvalid) return { status: 'policy_invalid', approvedPatch: false };
  if (!input.applyOk) return { status: 'patch_invalid', approvedPatch: false };
  return { status: 'ok', approvedPatch: true };
}
