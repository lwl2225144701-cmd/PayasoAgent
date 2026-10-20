// Runtime persistence port. The Agent Loop owns when a checkpoint must be
// committed, while the composition layer decides where and how it is stored.

import type { ContextHarnessState } from '../harness/context-state.js';
import type { ChatMessage } from '../llm/llm.js';
import type { PermissionMode } from '../permission-mode.js';
import type { ExecutionEvidenceSnapshot } from './execution-evidence-store.js';
import type { Scratchpad } from './scratchpad.js';
import type { ExecutedOperation } from './side-effect.js';
import type { AgentState } from './state.js';

export interface CheckpointSnapshot {
  runId: string;
  task: string;
  status: string;
  iteration: number;
  scratchpad: Scratchpad;
  messages: ChatMessage[];
  state: AgentState;
  workspaceRoot?: string;
  permissionMode?: PermissionMode;
  sideEffects?: ExecutedOperation[];
  harnessState?: ContextHarnessState;
  /** v2.5（计划 §6.1）：本 Run 的执行事实记录（检查结论/读取指纹/未决执行），由 Runtime 归属。 */
  executionEvidence?: ExecutionEvidenceSnapshot;
}

export interface Checkpoint extends CheckpointSnapshot {
  savedAt: string;
}

export interface CheckpointWriter {
  save(snapshot: CheckpointSnapshot): string;
}
