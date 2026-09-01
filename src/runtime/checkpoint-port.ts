// Runtime persistence port. The Agent Loop owns when a checkpoint must be
// committed, while the composition layer decides where and how it is stored.

import type { ChatMessage } from "../llm/llm.js";
import type { PermissionMode } from "../permission-mode.js";
import type { AgentState } from "./state.js";
import type { Scratchpad } from "./scratchpad.js";
import type { ExecutedOperation } from "./side-effect.js";
import type { ContextHarnessState } from "../harness/context-state.js";

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
}

export interface Checkpoint extends CheckpointSnapshot {
  savedAt: string;
}

export interface CheckpointWriter {
  save(snapshot: CheckpointSnapshot): string;
}
