// Module: Shared Timeout Primitives — one place for the layered-timeout
// vocabulary used across the Runtime (docs/long-task-timeout-plan.md step 1).
//
// Why this module exists:
// Timeout responsibility moves from a single fixed total deadline to the
// layer that actually blocks: LLM transport, tool execution, foreground
// Shell, and background jobs each own their boundary. Every layer still
// needs the same four mechanics — combine upstream cancellation with a local
// deadline, clamp a requested budget into policy, watch a stream for stalls,
// and identify *which* layer timed out afterwards. Keeping them here means
// the identification rules have one owner and no layer re-invents timers.
//
// Dependency direction: plain Node primitives only; no Runtime/Host imports,
// so Runtime, Sandbox and Host layers may all consume it freely.

export type TimeoutSource = 'user' | 'llm-connect' | 'llm-idle' | 'tool' | 'none';

/**
 * Structured abort reason for a layer-level timeout.
 *
 * Abort can mean "user cancelled" or "this layer's budget expired". The two
 * must stay observable: an AbortController is aborted *with* this reason so
 * `timeoutOf()` can attribute the abort without parsing error messages.
 */
export class TimeoutAbortError extends Error {
  constructor(
    public readonly source: 'llm-connect' | 'llm-idle' | 'tool',
    message: string,
  ) {
    super(message);
    this.name = 'TimeoutAbortError';
  }
}

/** Identify which layer a timeout came from; 'none' when it is not a timeout. */
export function timeoutOf(value: unknown): TimeoutSource {
  if (value instanceof TimeoutAbortError) return value.source;
  if (typeof value !== 'object' || value === null) return 'none';
  // AbortSignal.reason (DOMException('Aborted') → user cancel, or a nested
  // TimeoutAbortError → the layer that aborted it).
  const reason = (value as { reason?: unknown }).reason;
  if (reason instanceof TimeoutAbortError) return reason.source;
  if ((value as { name?: unknown }).name === 'AbortError') return 'user';
  return 'none';
}

export interface TimeoutPolicy {
  /** Budget used when the caller requests nothing or an invalid value. */
  defaultMs: number;
  /** Requests below this are noise and get lifted to it. */
  minMs: number;
  /** Requests above this are clamped to it (hard ceiling). */
  maxMs: number;
}

/**
 * Parse a positive whole number from an environment/tests override.
 * Fail-closed: an invalid value yields null and the caller falls back to its
 * built-in default rather than accidentally disabling a limit.
 */
export function positiveIntMs(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number((raw as string).trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * Clamp a requested budget into a policy. Invalid requests get the policy
 * default; the result is always within [minMs, maxMs], so a caller can extend
 * a budget but never remove the envelope.
 */
export function clampTimeoutMs(requested: unknown, policy: TimeoutPolicy): number {
  const value = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(value) || value <= 0) return policy.defaultMs;
  return Math.min(policy.maxMs, Math.max(policy.minMs, Math.floor(value)));
}

/**
 * A derived AbortSignal that combines upstream cancellation with one local
 * deadline:
 * - upstream abort → this signal aborts with the standard AbortError reason
 *   (user cancellation must stay distinguishable from a layer timeout);
 * - deadline expiry → aborts with `reasonFactory()` (usually a
 *   TimeoutAbortError identifying the layer);
 * - `dispose()` detaches listeners and clears the timer; the returned signal
 *   is inert afterwards and must not be used again.
 */
export interface Deadline {
  signal: AbortSignal;
  dispose: () => void;
}

export function createDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  reasonFactory: () => unknown,
): Deadline {
  const controller = new AbortController();
  let disposed = false;

  const onParentAbort = (): void => {
    controller.abort(new DOMException('Aborted', 'AbortError'));
  };
  if (parent) {
    if (parent.aborted) onParentAbort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(
    () => {
      if (!disposed && !controller.signal.aborted) controller.abort(reasonFactory());
    },
    Math.max(1, Math.floor(timeoutMs)),
  );
  // 注意：绝不 unref。deadline 语义是"必须触发"——若调用方除这个信号外没有其他
  // keep-alive 句柄（挂死工具只等信号、事件循环即将排空），unref 会让进程在
  // deadline 生效前退出，超时保护形同虚设。定时器生命周期有界：dispose/到期即清。

  return {
    signal: controller.signal,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * Stream idle watchdog: fires `onIdle` when no `poke()` happened for
 * `idleMs`. A stream that keeps producing renews its own budget on every
 * poke, so continuous output never trips the watchdog — only genuine stalls
 * do. Creation starts the first window; poke before any data keeps it alive.
 */
export interface IdleWatchdog {
  poke: () => void;
  dispose: () => void;
}

export function createIdleWatchdog(idleMs: number, onIdle: () => void): IdleWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const arm = (): void => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        if (disposed) return;
        disposed = true;
        onIdle();
      },
      Math.max(1, Math.floor(idleMs)),
    );
    // 同 deadline：绝不 unref（空闲看门狗必须触发，见 createDeadline 注释）。
  };
  arm();

  return {
    poke: (): void => {
      if (disposed) return;
      arm();
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
