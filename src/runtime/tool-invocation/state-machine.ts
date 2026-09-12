/**
 * Explicit lifecycle for one tool invocation.
 *
 * The ProcessManager owns effects; this module owns legal ordering. Keeping
 * transitions pure makes the closed safety sequence independently testable.
 */
export type ToolInvocationPhase =
  | 'received'
  | 'parsed'
  | 'resolved'
  | 'validated'
  | 'authorization_pending'
  | 'authorized'
  | 'effect_checked'
  | 'intent_persisting'
  | 'intent_persisted'
  | 'executing'
  | 'dependency_preparation'
  | 'retry_wait'
  | 'succeeded'
  | 'invalid'
  | 'invalid_result'
  | 'denied'
  | 'replayed'
  | 'uncertain'
  | 'blocked'
  | 'failed'
  | 'timed_out'
  | 'aborted';

const TERMINAL_PHASES = new Set<ToolInvocationPhase>([
  'succeeded',
  'invalid',
  'invalid_result',
  'denied',
  'replayed',
  'uncertain',
  'blocked',
  'failed',
  'timed_out',
  'aborted',
]);

const ALLOWED_TRANSITIONS: Readonly<Record<ToolInvocationPhase, readonly ToolInvocationPhase[]>> = {
  received: ['parsed', 'invalid'],
  parsed: ['resolved', 'invalid'],
  resolved: ['validated', 'invalid'],
  validated: ['authorization_pending', 'authorized'],
  authorization_pending: ['authorized', 'denied', 'aborted'],
  authorized: ['effect_checked'],
  effect_checked: [
    'intent_persisting',
    'executing',
    'replayed',
    'uncertain',
    'blocked',
    'failed',
    'aborted',
  ],
  intent_persisting: ['intent_persisted', 'failed', 'aborted'],
  intent_persisted: ['executing', 'aborted'],
  executing: [
    'succeeded',
    'invalid_result',
    'denied',
    'uncertain',
    'failed',
    'timed_out',
    'aborted',
    'dependency_preparation',
    'retry_wait',
  ],
  dependency_preparation: ['retry_wait', 'failed', 'uncertain', 'aborted'],
  retry_wait: ['executing', 'failed', 'aborted'],
  succeeded: [],
  invalid: [],
  invalid_result: [],
  denied: [],
  replayed: [],
  uncertain: [],
  blocked: [],
  failed: [],
  timed_out: [],
  aborted: [],
};

export interface ToolInvocationState {
  readonly phase: ToolInvocationPhase;
  readonly history: readonly ToolInvocationPhase[];
}

export function createToolInvocationState(): ToolInvocationState {
  return { phase: 'received', history: ['received'] };
}

export function transitionToolInvocation(
  state: ToolInvocationState,
  next: ToolInvocationPhase,
): ToolInvocationState {
  if (!ALLOWED_TRANSITIONS[state.phase].includes(next)) {
    throw new Error(`Illegal tool invocation transition: ${state.phase} -> ${next}`);
  }
  return { phase: next, history: [...state.history, next] };
}

export function isToolInvocationTerminal(state: ToolInvocationState): boolean {
  return TERMINAL_PHASES.has(state.phase);
}

/** Mutable cursor used only by the orchestration shell around the pure reducer. */
export class ToolInvocationStateMachine {
  private current = createToolInvocationState();

  get state(): ToolInvocationState {
    return this.current;
  }

  transition(next: ToolInvocationPhase): void {
    this.current = transitionToolInvocation(this.current, next);
  }
}
