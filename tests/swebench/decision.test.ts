// 提交决策单测（node:test）：§5.4 优先级全排列。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSubmission } from './decision.js';
import { detectTestPollution } from './policy.js';

const clean = { policyInvalid: false, hits: [] };
const dirty = detectTestPollution(['pkg/tests/x.py']);

test('runner 故障优先：即使有 patch 且干净也交空', () => {
  const d = decideSubmission({ runnerFaults: ['agent 执行失败'], patch: 'diff --git a b', policy: clean, applyOk: true });
  assert.equal(d.status, 'runner_fault');
  assert.equal(d.approvedPatch, false);
});

test('空 patch → empty_patch', () => {
  const d = decideSubmission({ runnerFaults: [], patch: '  \n', policy: clean, applyOk: false });
  assert.equal(d.status, 'empty_patch');
  assert.equal(d.approvedPatch, false);
});

test('policy 命中 → policy_invalid + 空 patch（优先于 apply）', () => {
  const d = decideSubmission({ runnerFaults: [], patch: 'diff --git a b', policy: dirty, applyOk: true });
  assert.equal(d.status, 'policy_invalid');
  assert.equal(d.approvedPatch, false);
});

test('apply 不过 → patch_invalid + 空 patch', () => {
  const d = decideSubmission({ runnerFaults: [], patch: 'diff --git a b', policy: clean, applyOk: false, applyError: 'conflict' });
  assert.equal(d.status, 'patch_invalid');
  assert.equal(d.approvedPatch, false);
});

test('干净且 apply 过 → ok + 交实际 patch', () => {
  const d = decideSubmission({ runnerFaults: [], patch: 'diff --git a b', policy: clean, applyOk: true });
  assert.equal(d.status, 'ok');
  assert.equal(d.approvedPatch, true);
});

test('timeout 不参与判定（过程标签）：干净 + apply 过的超时 diff 依然 ok', () => {
  // timeout 状态由 runner 层记录在 results.json，不进 decideSubmission 的输入
  const d = decideSubmission({ runnerFaults: [], patch: 'diff --git a b', policy: clean, applyOk: true });
  assert.equal(d.status, 'ok');
  assert.equal(d.approvedPatch, true);
});
