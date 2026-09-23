// 测试污染检测单测（node:test）：已知模式 + test_patch 路径 + 解析。
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTestPollution, matchTestPath, parseChangedPaths } from './policy.js';

test('模式命中：测试文件', () => {
  assert.equal(matchTestPath('tests/test_user.py'), 'test_file'); // 同时命中 dir/file 规则时按更具体的 test_file 报
  assert.equal(matchTestPath('src/user_test.py'), 'test_file');
  assert.equal(matchTestPath('a/b/c/test_models.py'), 'test_file');
});

test('模式命中：测试目录与 hook', () => {
  assert.equal(matchTestPath('pkg/tests/helpers.py'), 'test_dir');
  assert.equal(matchTestPath('pkg/testing/util.py'), 'test_dir');
  assert.equal(matchTestPath('conftest.py'), 'test_hook');
  assert.equal(matchTestPath('pytest.ini'), 'test_hook');
  assert.equal(matchTestPath('pyproject.toml'), 'test_hook');
});

test('模式未命中：正常源码', () => {
  assert.equal(matchTestPath('src/user/service.py'), null);
  assert.equal(matchTestPath('docs/readme.md'), null);
  assert.equal(matchTestPath('latest/notes.txt'), null); // "test" 仅作子串不算
});

test('detectTestPollution：模式 + test_patch 双通道', () => {
  const verdict = detectTestPollution(['src/a.py', 'pkg/tests/b.py', 'extra/fixture.json'], ['extra/fixture.json']);
  assert.equal(verdict.policyInvalid, true);
  assert.deepEqual(
    verdict.hits.map((h) => `${h.file}:${h.rule}`),
    ['pkg/tests/b.py:test_dir', 'extra/fixture.json:test_patch'],
  );
});

test('detectTestPollution：干净 diff 不误伤', () => {
  const verdict = detectTestPollution(['src/a.py', 'src/b/c.py'], ['x/y_test.py']);
  assert.equal(verdict.policyInvalid, false);
  assert.deepEqual(verdict.hits, []);
});

test('parseChangedPaths：空行过滤', () => {
  assert.deepEqual(parseChangedPaths('a.py\n\n b.py \n'), ['a.py', 'b.py']);
});
