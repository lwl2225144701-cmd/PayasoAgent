// Module: Tool Output Guard — Runtime enforcement point for the tool output
// budget. The budget itself (and the byte-accurate slicing) lives in
// `src/tool-output-budget.ts`, shared with the tools that produce large
// results, so an advertised tool limit can never drift from the enforced one.
//
// Contract:
//   - <= budget  → returned unchanged
//   - >  budget  → deterministic head + marker + tail, UTF-8 boundary safe
//   - `validateResult` must see the full raw result: this guard runs after it.

import {
  resolveToolOutputBudget,
  type SlicedText,
  sliceTextToBudget,
  TOOL_OUTPUT_MAX_BYTES,
  type ToolOutputBudget,
} from '../tool-output-budget.js';

export const MAX_TOOL_OUTPUT_BYTES = TOOL_OUTPUT_MAX_BYTES;

/** Result of applying the shared budget to one tool output. */
export type GuardedOutput = SlicedText;

/**
 * Apply the shared budget to one tool result. Pure and deterministic.
 * 预算在调用时解析（部署可用 PAYASO_TOOL_OUTPUT_* 调整），与所有生产者共用
 * 同一个解析器——调大调小都不会重新引入"宣称 vs 执行"的漂移。
 */
export function guardToolOutput(
  result: string,
  budget: ToolOutputBudget = resolveToolOutputBudget(),
): GuardedOutput {
  return sliceTextToBudget(result, budget);
}
