import type { PermissionMode } from '../permission-mode.js';
import type { RuntimeToolchainCapabilities } from '../sandbox/toolchain-manager.js';

// Fully authorized, Host/bootstrap-owned execution boundary. Runtime consumes
// this value but never derives a Workspace root or permission capability.
export interface AgentExecutionContext {
  runId: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  // Host/bootstrap-owned startup snapshot; contains no host paths.
  toolchain?: RuntimeToolchainCapabilities;
}
