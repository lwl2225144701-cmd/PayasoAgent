// 分层抽样单测（node:test）：确定性 + 最大余额法 + repo 内字典序 + pilot 预取。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pilotFromSelection, stratifiedSample } from './sampling.js';
import type { SwebenchInstance } from './dataset.js';

const instance = (instanceId: string, repo: string): SwebenchInstance => ({
  instance_id: instanceId,
  repo,
  base_commit: 'x',
  problem_statement: '',
  patch: '',
  test_patch: '',
  FAIL_TO_PASS: '',
  PASS_TO_PASS: '',
  version: '1',
});

const repoA = (n: number) => Array.from({ length: n }, (_, i) => instance(`a-${String(i).padStart(3, '0')}`, 'org/a'));
const repoB = (n: number) => Array.from({ length: n }, (_, i) => instance(`b-${String(i).padStart(3, '0')}`, 'org/b'));

test('分层抽样：按占比分配名额，总数精确', () => {
  // 60 个 A（60%）+ 40 个 B（40%）抽 50 → A 30 / B 20（整除，无余数）
  const result = stratifiedSample([...repoA(60), ...repoB(40)], 50);
  assert.equal(result.selected.length, 50);
  assert.equal(result.quota['org/a'], 30);
  assert.equal(result.quota['org/b'], 20);
  assert.equal(result.selected.filter((i) => i.repo === 'org/a').length, 30);
});

test('分层抽样：余数按小数部分降序补（最大余额法）', () => {
  // 100 = 33A + 67B：A 16.5 / B 33.5，floor 后剩 1 席；余数 .5 对 .5 平手 →
  // 按 repo 字典序 deterministic 补 A（tie-break 规则见 stratifiedSample 注释）
  const result = stratifiedSample([...repoA(33), ...repoB(67)], 50);
  assert.equal(result.quota["org/a"], 17);
  assert.equal(result.quota["org/b"], 33);
  assert.equal(result.selected.length, 50);
});

test('分层抽样：repo 内按 instance_id 字典序取前 K', () => {
  const result = stratifiedSample([...repoA(3)], 2);
  assert.deepEqual(
    result.selected.map((i) => i.instance_id),
    ['a-000', 'a-001'],
  );
});

test('分层抽样：确定性（输入同序/乱序结果一致）', () => {
  const input = [...repoA(4), ...repoB(4)];
  const a = stratifiedSample(input, 4).selected.map((i) => i.instance_id);
  const b = stratifiedSample([...input].reverse(), 4).selected.map((i) => i.instance_id);
  assert.deepEqual(a, b);
});

test('pilot：选中清单字典序前 n', () => {
  const selected = stratifiedSample([...repoA(5), ...repoB(5)], 6).selected;
  const pilot = pilotFromSelection(selected, 3);
  assert.equal(pilot.length, 3);
  assert.deepEqual(
    pilot.map((i) => i.instance_id),
    [...selected].sort((x, y) => x.instance_id.localeCompare(y.instance_id)).slice(0, 3).map((i) => i.instance_id),
  );
});

test('边界：total 超总量 / 空输入', () => {
  const all = [...repoA(3)];
  assert.equal(stratifiedSample(all, 10).selected.length, 3);
  assert.deepEqual(stratifiedSample([], 5).selected, []);
});
