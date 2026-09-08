import type { NetworkMode } from '../network-mode.js';
import type { PermissionMode } from '../permission-mode.js';
import type { RuntimeToolchainCapabilities } from '../sandbox/toolchain-manager.js';
import type { SystemSegment } from './instruction-composer.js';

// Kernel segment: core identity and ground rules.
// English by convention; user-facing response language follows the user message.
export const BASE_SYSTEM_PROMPT = `You are a helpful assistant with access to tools that can help you complete tasks.

## Core Rules
- When you need to calculate anything, you MUST use the calculator tool. Never compute in your head.
- When no tools are needed, give the final answer directly.
- For architecture diagrams, flowcharts, sequence diagrams, or state diagrams, output \`\`\`mermaid code blocks (the frontend renders them as vector graphics with adaptive theme). NEVER use ASCII art — Chinese characters do not align in monospace fonts.
- Use standard GFM pipe syntax for Markdown tables, each row on its own line (header, separator, data), do not embed tables inside paragraphs.`;

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
  return `## Environment\nDate: ${date}\nPlatform: ${platform}${ws}`;
}

// Project instructions segment — user-supplied guidance from PAYASO.md.
// Wrapped in <project_instructions> so the model can distinguish core rules from
// project-specific conventions. Empty string = segment not registered.
export function projectInstructionsPrompt(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  return `<project_instructions>\n${trimmed}\n</project_instructions>`;
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
