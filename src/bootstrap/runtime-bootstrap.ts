// Application composition for the default local Runtime.
// Importing concrete tools belongs to Host/CLI/test bootstrap, not Agent Loop.
import "../tools/builtin-tools.js";
import "../tools/filesystem.js";
import "../tools/runtime-tools.js";

import path from "node:path";
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from "../permission-mode.js";
import {
  canonicalizeWorkspaceRoot,
  createWorkspace,
  getRunWorkspaceRoot,
} from "../sandbox/sandbox-manager.js";
import type { AgentExecutionContext } from "../runtime/contracts.js";
import { fileCheckpointWriter } from "../persistence/file-checkpoint-store.js";
import type { CheckpointWriter } from "../runtime/checkpoint-port.js";
import { consoleRuntimeObserver } from "../observability/console-runtime-observer.js";
import type { RuntimeObserver } from "../runtime/observer-port.js";

export interface AgentExecutionContextInput {
  runId: string;
  workspaceRoot?: string;
  permissionMode?: PermissionMode;
}

export interface DefaultRuntimeServices {
  checkpointWriter: CheckpointWriter;
  observer: RuntimeObserver;
}

// Default local adapter wiring. Runtime itself has no dependency on the file
// checkpoint implementation.
export function createDefaultRuntimeServices(): DefaultRuntimeServices {
  return {
    checkpointWriter: fileCheckpointWriter,
    observer: consoleRuntimeObserver,
  };
}

// Canonicalize an explicitly authorized root. When no real Workspace was
// selected, preserve the legacy per-Run sandbox and ensure it exists.
export function createAgentExecutionContext(input: AgentExecutionContextInput): AgentExecutionContext {
  const legacyRoot = getRunWorkspaceRoot(input.runId);
  const requestedRoot = input.workspaceRoot;
  const workspaceRoot = !requestedRoot
    || (path.isAbsolute(requestedRoot) && path.resolve(requestedRoot) === path.resolve(legacyRoot))
    ? canonicalizeWorkspaceRoot(createWorkspace(input.runId))
    : canonicalizeWorkspaceRoot(requestedRoot);
  return {
    runId: input.runId,
    workspaceRoot,
    permissionMode: input.permissionMode ?? DEFAULT_PERMISSION_MODE,
  };
}
