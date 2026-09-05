// Runtime observability port. Execution semantics never depend on an observer;
// Host/CLI/tests choose how diagnostic output is rendered or collected.

import type { Scratchpad } from './scratchpad.js';
import type { AgentState } from './state.js';
import type { TraceEvent } from './trace.js';

export interface RuntimeTraceSnapshot {
  run_id: string;
  events: TraceEvent[];
}

export interface RuntimeObserver {
  log(message: string): void;
  state(state: Readonly<AgentState>, detail: 'summary' | 'full'): void;
  scratchpad(scratchpad: Readonly<Scratchpad>): void;
  traceEvent(event: Readonly<TraceEvent>): void;
  trace(trace: Readonly<RuntimeTraceSnapshot>): void;
}

export const silentRuntimeObserver: RuntimeObserver = {
  log: () => {},
  state: () => {},
  scratchpad: () => {},
  traceEvent: () => {},
  trace: () => {},
};

// Observability is best-effort. A broken renderer/collector must never change
// Agent execution, persistence or side-effect safety semantics.
export function protectRuntimeObserver(observer: RuntimeObserver): RuntimeObserver {
  return {
    log: (message) => {
      try {
        observer.log(message);
      } catch {}
    },
    state: (state, detail) => {
      try {
        observer.state(state, detail);
      } catch {}
    },
    scratchpad: (scratchpad) => {
      try {
        observer.scratchpad(scratchpad);
      } catch {}
    },
    traceEvent: (event) => {
      try {
        observer.traceEvent(event);
      } catch {}
    },
    trace: (trace) => {
      try {
        observer.trace(trace);
      } catch {}
    },
  };
}
