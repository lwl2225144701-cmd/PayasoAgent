import type { PermissionMode } from '../permission-mode.js';
import type { RuntimeToolchainCapabilities } from '../sandbox/toolchain-manager.js';

// Fully authorized, Host/bootstrap-owned execution boundary. Runtime consumes
// this value but never derives a Workspace root or permission capability.
export interface AgentExecutionContext {
  runId: string;
  // Background Job（Session 级所有权）的会话键；Host 注入持久会话 id，
  // CLI/测试未注入时 Runtime 回退到 runId 派生键。
  sessionId?: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  /** Host 固化的精确相对路径；undefined 不限，空集合禁止全部写入。 */
  writeScope?: readonly string[];
  // Host/bootstrap-owned startup snapshot; contains no host paths.
  toolchain?: RuntimeToolchainCapabilities;
  // Project-level instructions from PAYASO.md (only loaded when permission >= workspace-write).
  // Empty string / undefined = no project instructions.
  projectInstructions?: string;
}
