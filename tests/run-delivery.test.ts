// 交付投影回归：真实 Trace 编号、退出状态、分页复查、文件现状和路径隔离。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addEvent, createTrace } from '../src/runtime/trace.js';
import type { HostEvent } from '../src/host/run-events.js';
import { deriveRunDelivery, inspectRunDelivery } from '../src/host/run-delivery.js';
const trace = createTrace('delivery-test');
function call(tool: string, args: Record<string, unknown>, result: string, durationMs = 10) {
  addEvent(trace, { type: 'tool_call', tool, args });
  addEvent(trace, { type: 'tool_result', tool, result, durationMs });
}
call('read', { path: 'a.md', offset: 1 }, 'one');
call('read', { offset: 1, path: 'a.md' }, 'one');
call('read', { path: 'a.md', offset: 2 }, 'two');
call('write', { path: 'a.md', content: 'three' }, 'written');
call('read', { path: 'a.md', offset: 1 }, 'three');
call('shell', { command: 'npm test' }, '[shell-exit-1]\nfailed');
call('shell', { command: 'npm test' }, '[shell-exit-1]\nfailed', 5500);
call(
  'shell',
  { command: 'npm run build', background: true },
  '[shell-background] jobId=job-1 status=running',
);
call('shellJob', { action: 'wait', jobId: 'job-1' }, '[job-1 completed]\n[shell-exit-0]\nok');
call('shell', { command: 'npm run lint' }, '[shell-timeout]\ntimeout');
addEvent(trace, { type: 'tool_call', tool: 'write', args: { path: 'failed.md' } });
addEvent(trace, {
  type: 'tool_error',
  tool: 'write',
  error: 'denied',
  attempt: 1,
  exhausted: true,
});
addEvent(trace, {
  type: 'plan_update',
  revision: 1,
  completed: 0,
  total: 1,
  items: [{ id: '1', title: 'Review report', status: 'pending' }],
});
const events: HostEvent[] = trace.events;
const result = deriveRunDelivery(
  events,
  '[report](report.csv) [outside](../secret.txt) [web](https://example.com/a.md)',
);
assert.deepEqual(
  result.files.map((f) => f.name),
  ['a.md', 'report.csv', '../secret.txt'],
);
assert.equal(result.diagnostics.filter((d) => d.kind === 'repeatRead').length, 1);
assert.equal(result.diagnostics.filter((d) => d.kind === 'repeatFailure').length, 1);
assert.equal(result.diagnostics.filter((d) => d.kind === 'slow').length, 1);
assert.deepEqual(
  result.checks.map((c) => c.status),
  ['failed', 'failed', 'passed', 'failed'],
);
assert.deepEqual(result.unfinished, ['Review report']);
assert.equal(result.stats.toolCalls, 11);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-delivery-'));
try {
  fs.writeFileSync(path.join(root, 'a.md'), 'three');
  fs.writeFileSync(path.join(root, 'report.csv'), 'a,b\n1,2');
  fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'));
  const inspected = inspectRunDelivery(
    events,
    root,
    new Date(Date.now() + 5000).toISOString(),
    '[report](report.csv) [gone](gone.txt) [escape](outside/secret.txt)',
  );
  assert.deepEqual(
    inspected.files.map((f) => [f.name, f.status]),
    [
      ['a.md', 'available'],
      ['report.csv', 'available'],
      ['gone.txt', 'unavailable'],
    ],
  );
  const changed = inspectRunDelivery(events, root, '2000-01-01T00:00:00Z');
  assert.equal(changed.files[0].status, 'changed');
  fs.unlinkSync(path.join(root, 'a.md'));
  assert.equal(
    inspectRunDelivery(events, root, new Date().toISOString()).files[0].status,
    'unavailable',
  );
  assert.deepEqual(inspectRunDelivery(events, null, '').files, []);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
const unfinishedTrace = createTrace('unknown');
addEvent(unfinishedTrace, {
  type: 'tool_call',
  tool: 'shell',
  args: { command: 'npm test', background: true },
});
addEvent(unfinishedTrace, {
  type: 'tool_result',
  tool: 'shell',
  result: '[shell-background] jobId=x status=running',
  durationMs: 1,
});
assert.equal(deriveRunDelivery(unfinishedTrace.events).checks[0].status, 'unknown');
assert.equal(deriveRunDelivery([]).checks.length, 0);

const stopped = createTrace('stopped');
addEvent(stopped, { type: 'tool_call', tool: 'shell', args: { command: 'npm test' } });
assert.equal(deriveRunDelivery(stopped.events).checks[0].status, 'unknown');

assert.equal(deriveRunDelivery([], '[report](<reports/my report.md>)').files[0].name, 'reports/my report.md');
console.log('Run delivery: PASS');
