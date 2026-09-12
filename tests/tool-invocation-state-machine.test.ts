import assert from 'node:assert/strict';
import {
  createToolInvocationState,
  isToolInvocationTerminal,
  type ToolInvocationPhase,
  ToolInvocationStateMachine,
  transitionToolInvocation,
} from '../src/runtime/tool-invocation/state-machine.js';

function walk(phases: ToolInvocationPhase[]) {
  let state = createToolInvocationState();
  for (const phase of phases) state = transitionToolInvocation(state, phase);
  return state;
}

const success = walk([
  'parsed',
  'resolved',
  'validated',
  'authorized',
  'effect_checked',
  'executing',
  'succeeded',
]);
assert.equal(success.phase, 'succeeded');
assert.equal(isToolInvocationTerminal(success), true);

const approvedSideEffect = walk([
  'parsed',
  'resolved',
  'validated',
  'authorization_pending',
  'authorized',
  'effect_checked',
  'intent_persisting',
  'intent_persisted',
  'executing',
  'succeeded',
]);
assert.equal(approvedSideEffect.phase, 'succeeded');

const denied = walk(['parsed', 'resolved', 'validated', 'authorization_pending', 'denied']);
assert.equal(denied.phase, 'denied');
assert.equal(isToolInvocationTerminal(denied), true);

const retried = walk([
  'parsed',
  'resolved',
  'validated',
  'authorized',
  'effect_checked',
  'executing',
  'retry_wait',
  'executing',
  'failed',
]);
assert.equal(retried.phase, 'failed');

const prepared = walk([
  'parsed',
  'resolved',
  'validated',
  'authorized',
  'effect_checked',
  'executing',
  'dependency_preparation',
  'failed',
]);
assert.equal(prepared.phase, 'failed');

const timedOut = walk([
  'parsed',
  'resolved',
  'validated',
  'authorized',
  'effect_checked',
  'executing',
  'timed_out',
]);
assert.equal(timedOut.phase, 'timed_out');
assert.equal(isToolInvocationTerminal(timedOut), true);

const uncertainAfterTimeout = walk([
  'parsed',
  'resolved',
  'validated',
  'authorized',
  'effect_checked',
  'intent_persisting',
  'intent_persisted',
  'executing',
  'uncertain',
]);
assert.equal(uncertainAfterTimeout.phase, 'uncertain', 'non_idempotent 超时按不确定副作用处理');

assert.throws(
  () => transitionToolInvocation(createToolInvocationState(), 'executing'),
  /Illegal tool invocation transition: received -> executing/,
);
assert.throws(
  () => transitionToolInvocation(success, 'retry_wait'),
  /Illegal tool invocation transition/,
);

const machine = new ToolInvocationStateMachine();
machine.transition('parsed');
assert.deepEqual(machine.state.history, ['received', 'parsed']);

console.log('Tool invocation state machine tests: PASS');
