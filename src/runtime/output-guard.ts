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
  type SlicedText,
  sliceTextToBudget,
  TOOL_OUTPUT_MAX_BYTES,
} from '../tool-output-budget.js';

export const MAX_TOOL_OUTPUT_BYTES = TOOL_OUTPUT_MAX_BYTES;

/** Result of applying the shared budget to one tool output. */
export type GuardedOutput = SlicedText;

/** Apply the shared budget to one tool result. Pure and deterministic. */
export function guardToolOutput(result: string): GuardedOutput {
  return sliceTextToBudget(result);
}
