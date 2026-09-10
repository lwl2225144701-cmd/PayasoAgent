// Module: Shell Timeout Policy — one place that decides how long a Shell
// command may run, for both the model-facing tool contract and the two
// execution backends (seatbelt / uncontained).
//
// Why this module exists (v1.8):
// The timeout was a hard-coded 10s constant. `npm run test:all` needs minutes,
// so "run the tests" was architecturally impossible; worse, the model sometimes
// guessed a `timeout` parameter that the schema did not declare and the Runtime
// silently dropped it. The budget now lives here, is configurable by the host,
// and is *requestable* by the model through a declared, clamped parameter.
//
// Precedence: explicit request (clamped) > env default > built-in default.
// Fail-closed: an invalid env value falls back to the built-in default rather
// than disabling the limit.

/** Built-in default when nothing is configured: long enough for a test suite. */
export const SHELL_TIMEOUT_DEFAULT_MS = 120_000;
/** Hard ceiling a model-requested timeout is clamped to. */
export const SHELL_TIMEOUT_MAX_MS = 600_000;
/** Floor for a model-requested timeout (sub-second requests are noise). */
export const SHELL_TIMEOUT_MIN_MS = 1_000;

export interface ShellTimeoutPolicy {
  defaultMs: number;
  maxMs: number;
  minMs: number;
}

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** Resolve the host policy from the environment. Never throws. */
export function shellTimeoutPolicy(
  env: Record<string, string | undefined> = process.env,
): ShellTimeoutPolicy {
  const maxMs = Math.max(
    positiveInt(env.PAYASO_SHELL_TIMEOUT_MAX_MS) ?? SHELL_TIMEOUT_MAX_MS,
    SHELL_TIMEOUT_MIN_MS,
  );
  const configuredDefault = positiveInt(env.PAYASO_SHELL_TIMEOUT_MS) ?? SHELL_TIMEOUT_DEFAULT_MS;
  return {
    // default 同样收敛到 [min, max]：配置成 500ms 也不允许突破下限。
    defaultMs: Math.max(SHELL_TIMEOUT_MIN_MS, Math.min(configuredDefault, maxMs)),
    maxMs,
    minMs: SHELL_TIMEOUT_MIN_MS,
  };
}

/**
 * Clamp a model-supplied timeout request into the host policy.
 * Non-numeric / missing requests get the policy default; the result is always
 * within [minMs, maxMs], so the model can extend a command but never remove
 * the ceiling.
 */
export function resolveShellTimeout(
  requested: unknown,
  policy: ShellTimeoutPolicy = shellTimeoutPolicy(),
): number {
  const value = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(value) || value <= 0) return policy.defaultMs;
  return Math.min(policy.maxMs, Math.max(policy.minMs, Math.floor(value)));
}

/**
 * Shell tool policy: foreground commands use the normal default; background
 * commands use the configured ceiling when the model did not choose a timeout.
 * Background mode is specifically for builds/tests that commonly exceed 120s.
 */
export function resolveShellToolTimeout(
  requested: unknown,
  background: boolean,
  policy: ShellTimeoutPolicy = shellTimeoutPolicy(),
): number {
  if (background && (requested === undefined || requested === null || requested === '')) {
    return policy.maxMs;
  }
  return resolveShellTimeout(requested, policy);
}
