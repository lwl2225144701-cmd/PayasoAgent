import type { NetworkMode } from '../network-mode.js';
import type { PermissionMode } from '../permission-mode.js';
import { describeShellLanguage } from '../sandbox/shell-host.js';
import type { RuntimeToolchainCapabilities } from '../sandbox/toolchain-manager.js';
import type { SystemSegment } from './instruction-composer.js';

// Kernel segment: core identity and ground rules.
// English by convention; user-facing response language follows the user message.
export const BASE_SYSTEM_PROMPT = `You are PayasoAgent, a coding agent in the current workspace.

Finish the user's requested work. Implement and verify changes; answer questions or planning requests within their scope.
Read relevant code and repository instructions. Gather enough evidence for the next useful action, make a small verifiable change, then inspect the result. Investigate further when it could change the solution. Reuse settled evidence and batch independent lookups.
Reuse installed project dependencies and test runners; inspect package manifests before building new test infrastructure.
Preserve unrelated changes and explicit file limits, including tests and temporary files. Use targeted edits.
Proceed independently within authorization. Ask when missing information or permission blocks progress.
Respect filesystem, network and approval boundaries. Never bypass isolation, expose secrets, or take unauthorized destructive or external actions.
Verify behavior, fix relevant failures and report gaps honestly. For async or stateful changes, exercise transitions, failures and interleavings; source-text assertions alone cannot verify them. Plans and tool success do not prove completion.
Keep reasoning private and focused on the next useful action. Give concise progress and final responses in the user's language with changes, workspace-relative file links, checks and unfinished work.
Harness context supplies observations. Choose your own workflow and next action.`;

// File system permission prompt — describes filesystem semantics only.
export function permissionSystemPrompt(mode: PermissionMode): string {
  if (mode === 'read-only') {
    return '## Filesystem Permission: Read Only\nYou can only read files inside the current Workspace. Creating, modifying, moving, or deleting files is forbidden. Shell commands also cannot write.';
  }
  if (mode === 'full-access') {
    return '## Filesystem Permission: Full Access\nYou can read and write files anywhere the host user has access to, using absolute paths. Still subject to macOS user permissions, ACL, TCC, and SIP restrictions.';
  }
  return '## Filesystem Permission: Workspace Write\nYou can read and write files inside the current Workspace. Accessing files outside the Workspace is forbidden.';
}

// Network permission is independent from filesystem permission (v2.0 Network Control).
// Three global modes: on / off / ask. Injected by Host/tests at runtime.
// Regenerated on each system prompt assembly so mid-session mode switches stay accurate.
export function networkSystemPrompt(mode: NetworkMode): string {
  if (mode === 'off') {
    return '## Network Permission: Off\nTools with network capability will be directly denied. Do not attempt network-based solutions.';
  }
  if (mode === 'ask') {
    return '## Network Permission: Ask\nTools with network capability require explicit user approval before execution. Do not assume network is available until approved.';
  }
  return '## Network Permission: On\nNetwork access is allowed. All network access is audited.';
}

// Tool availability is decided once by Host/bootstrap. Keep this model-facing
// message path-free and instruct the Agent not to retry a missing dependency.
export function toolchainSystemPrompt(capabilities?: RuntimeToolchainCapabilities): string {
  if (!capabilities) {
    return '## Toolchain\nThe controlled Shell toolchain is determined once by Host at Runtime startup. If a command indicates a tool is not in the current controlled runtime, do not repeatedly retry or escalate permissions on your own. Clearly inform the user and wait for user authorization before preparing dependencies.';
  }
  if (capabilities.platform === 'unsupported') {
    return '## Toolchain\nNo controlled Shell runtime is available on this platform. Do not repeatedly retry Shell commands. Clearly inform the user that the controlled runtime is unavailable and wait for authorization before preparing an alternative runtime.';
  }
  const available = Object.entries(capabilities.tools)
    .filter(([, capability]) => capability.status === 'available')
    .map(([name]) => name);
  const missing = Object.entries(capabilities.tools)
    .filter(([, capability]) => capability.status === 'missing')
    .map(([name]) => name);
  const availableText = available.length > 0 ? available.join(', ') : 'none';
  const missingText = missing.length > 0 ? missing.join(', ') : 'none';
  return `## Toolchain\nThe controlled Shell toolchain is discovered once at Runtime startup. File permissions are never escalated dynamically based on individual command failures.\nAvailable tools: ${availableText}\nMissing tools: ${missingText}\nMissing tools MUST be clearly reported to the user. Installation or dependency preparation requires explicit user authorization — never install on your own.`;
}

// Environment context: lightweight info about the execution environment.
export function envContextPrompt(workspaceName?: string): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const platform = process.platform;
  const ws = workspaceName ? `\nWorkspace: ${workspaceName}` : '';
  // 命令语言随平台与开关变化（Windows ACL 沙箱只能用原生 PE 载体 → PowerShell），
  // 必须显式告知模型，否则它会写出另一种语言里语法不通的命令。
  const shell = describeShellLanguage(platform);
  return `## Environment\nDate: ${date}\nPlatform: ${platform}\nShell: ${shell}${ws}`;
}

// Project instructions segment — user-supplied guidance from PAYASO.md.
// Wrapped in <project_instructions> so the model can distinguish core rules from
// project-specific conventions. Empty string = segment not registered.
export function projectInstructionsPrompt(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  return `<project_instructions>\n${trimmed}\n</project_instructions>`;
}

// Plan segment — 计划是可选工具：何时值得用、何时该更新（软引导，短）。
// 为什么放在 Harness：计划是"模型看到什么"的一部分，与 scratchpad 投影同层；
// 不放进内核提示词，也不做成硬约束。刻意不以步数/工具调用次数作为触发条件——
// 普通调查直接开展，是否需要计划由模型按任务判断（2026-10-19 按需规划调整）。
export function planningSystemPrompt(): string {
  return '## Task Plan (optional)\nUse updatePlan when useful or requested. Keep scope and statuses accurate; update at meaningful milestones rather than after every tool call.';
}

// Build initial segment definitions for the InstructionComposer.
// Static/per-run segments are built once; dynamic segments are updated per turn.
export function buildBaseSegments(options: {
  permissionMode: PermissionMode;
  modelPromptNotes?: string;
  toolchainCapabilities?: RuntimeToolchainCapabilities;
  networkMode: NetworkMode;
  workspaceName?: string;
  projectInstructions?: string;
}): SystemSegment[] {
  const segments: SystemSegment[] = [];

  segments.push({
    id: 'kernel.base',
    priority: 10,
    content: BASE_SYSTEM_PROMPT,
    budgetTokens: 512,
    mutability: 'static',
  });

  if (options.modelPromptNotes?.trim()) {
    segments.push({
      id: 'model.adaptation',
      priority: 20,
      content: `## Model Adaptation\n${options.modelPromptNotes.trim()}`,
      budgetTokens: 256,
      mutability: 'static',
    });
  }

  if (options.projectInstructions?.trim()) {
    segments.push({
      id: 'project.instructions',
      priority: 30,
      content: projectInstructionsPrompt(options.projectInstructions),
      budgetTokens: 8192,
      mutability: 'per_run',
    });
  }

  segments.push({
    id: 'platform.permission',
    priority: 50,
    content: permissionSystemPrompt(options.permissionMode),
    budgetTokens: 128,
    mutability: 'per_run',
  });

  segments.push({
    id: 'workflow.plan',
    priority: 55,
    content: planningSystemPrompt(),
    budgetTokens: 256,
    mutability: 'static',
  });

  segments.push({
    id: 'platform.toolchain',
    priority: 60,
    content: toolchainSystemPrompt(options.toolchainCapabilities),
    budgetTokens: 256,
    mutability: 'dynamic',
  });

  segments.push({
    id: 'platform.network',
    priority: 70,
    content: networkSystemPrompt(options.networkMode),
    budgetTokens: 128,
    mutability: 'dynamic',
  });

  segments.push({
    id: 'env.context',
    priority: 90,
    content: envContextPrompt(options.workspaceName),
    budgetTokens: 64,
    mutability: 'dynamic',
  });

  return segments;
}
