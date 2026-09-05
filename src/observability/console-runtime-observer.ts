// Default CLI/local diagnostic renderer. Runtime publishes observations through
// a port and never writes to stdout directly.

import type { RuntimeObserver } from '../runtime/observer-port.js';

function stateSummary(state: Parameters<RuntimeObserver['state']>[0]): string {
  const error = state.currentError ? ` | curErr=${state.currentError}` : '';
  const pending = state.pendingAction
    ? ` | pending=${state.pendingAction.tool}(${state.pendingAction.input})`
    : '';
  const lastError = state.lastToolError
    ? ` | lastErr=${state.lastToolError.tool}(${state.lastToolError.input})x${state.lastToolError.retries}`
    : '';
  return `[State] ${state.status} | iter=${state.iteration} | step=${state.currentStep} | tools=${state.toolCalls}(ok:${state.successfulToolCalls}/fail:${state.failedToolCalls}/invalid:${state.invalidToolResults})${error}${pending}${lastError}`;
}

export const consoleRuntimeObserver: RuntimeObserver = {
  log: (message) => console.log(message),
  state: (state, detail) => {
    if (detail === 'full') {
      console.log('\n=== Agent State ===');
      console.log(JSON.stringify(state, null, 2));
    } else {
      console.log(stateSummary(state));
    }
  },
  scratchpad: (scratchpad) => {
    console.log('\n=== Scratchpad ===');
    console.log(JSON.stringify(scratchpad, null, 2));
  },
  traceEvent: (event) => console.log(`[Trace] ${JSON.stringify(event)}`),
  trace: (trace) => {
    console.log('\n=== Trace 执行轨迹 ===');
    console.log(JSON.stringify(trace, null, 2));
  },
};
