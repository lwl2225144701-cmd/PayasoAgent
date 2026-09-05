// Runtime-owned filesystem capability. The LLM cannot set or change this value;
// Host validates it once when creating a Run and persists the resulting snapshot.

export const PERMISSION_MODES = ['read-only', 'workspace-write', 'full-access'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'workspace-write';

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.includes(value as PermissionMode);
}

// Backward compatibility for Runs/checkpoints created before permission snapshots
// existed. New external input must use isPermissionMode() and reject unknown values.
export function storedPermissionMode(value: unknown): PermissionMode {
  return isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE;
}
