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
// Why the root is SHORT (v1.10 fix):
// The path handed to a child as HOME/TMPDIR becomes the base for everything the
// tool writes, including Unix domain sockets (AF_UNIX hard limit = 108 bytes)
// and the test suite's own `fs.mkdtempSync(os.tmpdir(), ...)`. The original
// root was `os.tmpdir()/payaso-shell/<runId>-<rand>` — 113 bytes — so `tsx`
// crashed with `listen EINVAL` (socket path 132 > 108) and the agent could
// never run its own tests. The default root therefore lives at `/private/tmp`
// (12 bytes on macOS) instead of `/private/var/folders/...` (59+ bytes), and
// each invocation uses a minimal `s-XXXXXX` name. `scope` is no longer embedded
// in the path — it exists only for caller bookkeeping.
//
// Contract:
// - The scratch root lives OUTSIDE the Workspace, so a crashed run can never
//   leave artifacts in the user's project.
// - The root and each scratch directory are 0700; per-invocation directories
//   are unique (mkdtemp) and removed by the caller via `dispose()`.
// - `isShellScratchPath` is the only authority the sandbox policy trusts to
//   accept a writable root outside the Workspace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRATCH_DIR_NAME = 'payaso-shell';
/** Minimal per-invocation prefix; mkdtemp appends 6 random chars → `s-XXXXXX`. */
const SCRATCH_DIR_PREFIX = 's';

/** AF_UNIX (Unix domain socket) path length limit. */
export const UNIX_SOCKET_PATH_LIMIT_BYTES = 108;
/**
 * Longest expected child-created suffix under $TMPDIR: `/tsx-<uid>/<pid>.pipe`
 * (~24 bytes). Kept explicit so the length invariant is testable.
 */
export const SCRATCH_SOCKET_RESERVE_BYTES = 24;
/** Safe upper bound for the TMPDIR path handed to a child process. */
export const SCRATCH_MAX_TMPDIR_BYTES = UNIX_SOCKET_PATH_LIMIT_BYTES - SCRATCH_SOCKET_RESERVE_BYTES;

/**
 * Candidate scratch roots in priority order (canonicalized when they exist).
 * macOS primary is `/tmp/payaso-shell` → `/private/tmp/payaso-shell` (short,
 * avoids `/var/folders/...`); fallback is `os.tmpdir()/payaso-shell`, which in a
 * nested sandbox resolves to the outer scratch (writable AND short). This
 * fallback keeps the Shell tool functional when the primary root is not
 * writable (e.g. the Host itself runs inside another sandbox).
 * `PAYASO_SHELL_SCRATCH_ROOT` overrides the whole list.
 */
export function shellScratchRoots(env: Record<string, string | undefined> = process.env): string[] {
  const override = env.PAYASO_SHELL_SCRATCH_ROOT?.trim();
  if (override) return [path.resolve(override)];
  if (process.platform === 'darwin') {
    return [path.join('/tmp', SCRATCH_DIR_NAME), path.join(os.tmpdir(), SCRATCH_DIR_NAME)];
  }
  return [path.join(os.tmpdir(), SCRATCH_DIR_NAME)];
}

/** Primary scratch root (first candidate). Kept for callers that want one path. */
export function shellScratchRoot(env: Record<string, string | undefined> = process.env): string {
  const root = shellScratchRoots(env)[0];
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch {
    /* a later create/validate will surface the real error */
  }
  return canonicalize(root);
}

/** True when `candidate` is any managed scratch root or a descendant of it. */
export function isShellScratchPath(
  candidate: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const target = canonicalize(path.resolve(candidate));
  return shellScratchRoots(env).some((root) => {
    const canonicalRoot = canonicalize(root);
    return target === canonicalRoot || target.startsWith(canonicalRoot + path.sep);
  });
}

export interface ShellScratch {
  /** Canonical absolute path handed to the child as HOME and TMPDIR. */
  readonly path: string;
  /** Best-effort recursive removal. Safe to call more than once. */
  dispose(): void;
}

/**
 * Create one 0700 scratch directory for a Shell invocation.
 * `scope` is retained for caller bookkeeping only — it is NEVER placed in the
 * path, because the path length is the hard constraint here (see module doc).
 */
export function createShellScratch(
  _scope: string,
  env: Record<string, string | undefined> = process.env,
): ShellScratch {
  const roots = shellScratchRoots(env);
  let lastError: unknown;
  for (const root of roots) {
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const created = fs.mkdtempSync(path.join(root, `${SCRATCH_DIR_PREFIX}-`));
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
    } catch (err) {
      lastError = err;
    }
  }
  // 所有候选根都不可写：把最后一个真实错误抛给调用方（fail-closed，不静默降级）。
  throw lastError instanceof Error
    ? lastError
    : new Error(`unable to create shell scratch under any managed root (${roots.join(', ')})`);
}

/** realpath when the path exists, resolve otherwise (never throws). */
function canonicalize(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}
