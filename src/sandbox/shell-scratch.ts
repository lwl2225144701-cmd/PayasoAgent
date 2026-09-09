// Module: Shell Scratch — the only writable area the Shell tool may hand to a
// child process when the Workspace itself is read-only.
//
// Why this module exists (v1.8):
// Read Only mode used to point HOME/TMPDIR at the Workspace, which is not
// writable in that mode. Anything that touches a cache or lock file — npm, npx,
// git, tsx, most build tools — was therefore denied by the seatbelt profile,
// and the agent burned turns retrying "run the tests" three different ways.
// The Workspace boundary must stay read-only, but a command still needs a
// writable scratch area; this module owns that area.
//
// Contract:
// - The scratch root lives under the OS temp dir (never inside the Workspace),
//   so a crashed run can never leave artifacts in the user's project.
// - Each scratch directory is created 0700, unique per Shell invocation, and
//   removed by the caller via `dispose()`.
// - `isShellScratchPath` is the only authority the sandbox policy trusts to
//   accept a writable root outside the Workspace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRATCH_DIR_NAME = 'payaso-shell';

/** Root under which all per-invocation scratch directories are created (canonical). */
export function shellScratchRoot(env: Record<string, string | undefined> = process.env): string {
  const override = env.PAYASO_SHELL_SCRATCH_ROOT?.trim();
  return canonicalize(override ? path.resolve(override) : path.join(os.tmpdir(), SCRATCH_DIR_NAME));
}

/** True when `candidate` is the scratch root or a descendant of it. */
export function isShellScratchPath(
  candidate: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const root = shellScratchRoot(env);
  const target = canonicalize(path.resolve(candidate));
  return target === root || target.startsWith(root + path.sep);
}

export interface ShellScratch {
  /** Canonical absolute path handed to the child as HOME and TMPDIR. */
  readonly path: string;
  /** Best-effort recursive removal. Safe to call more than once. */
  dispose(): void;
}

/**
 * Create one 0700 scratch directory for a Shell invocation.
 * `scope` is a human-readable prefix (runId / tool name); it is sanitized so a
 * hostile value can never escape the scratch root.
 */
export function createShellScratch(
  scope: string,
  env: Record<string, string | undefined> = process.env,
): ShellScratch {
  const root = shellScratchRoot(env);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const safeScope = scope.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'run';
  const created = fs.mkdtempSync(path.join(root, `${safeScope}-`));
  fs.chmodSync(created, 0o700);
  const canonical = canonicalize(created);
  let disposed = false;
  return {
    path: canonical,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        fs.rmSync(canonical, { recursive: true, force: true });
      } catch {
        /* best effort: a leaked scratch dir must never fail the tool call */
      }
    },
  };
}

/** realpath when the path exists, resolve otherwise (never throws). */
function canonicalize(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}
