// 确定性测试：内置斜杠命令注册表 —— 解析 / 权限匹配 / 模型模糊匹配 / 补全合并。

import assert from 'node:assert/strict';
import {
  BUILTIN_COMMANDS,
  matchBuiltinCommand,
  matchModelByQuery,
  matchPermissionMode,
  mergeCommandCandidates,
} from '../web/src/commands/builtin-commands.js';

// DSH 对标的 7 个命令齐全
assert.deepEqual(
  BUILTIN_COMMANDS.map((cmd) => cmd.name),
  ['compact', 'export', 'feedback', 'goal', 'permission', 'plan', 'model'],
);

// ---- matchBuiltinCommand：仅启用中的命令被拦截（当前只有 compact）----
assert.deepEqual(matchBuiltinCommand('/compact'), { name: 'compact', args: '' });
assert.deepEqual(matchBuiltinCommand('/COMPACT 旧对话'), { name: 'compact', args: '旧对话' });
assert.equal(matchBuiltinCommand('hello'), null, '普通消息不拦截');
assert.equal(matchBuiltinCommand('/'), null);
assert.equal(matchBuiltinCommand('/unknown x'), null, '未注册命令走原链路');
assert.equal(matchBuiltinCommand('/compactx'), null, '前缀重叠不误匹配');
assert.equal(matchBuiltinCommand('/export'), null, '未启用的内置命令不拦截（先不下发）');
assert.equal(matchBuiltinCommand('/plan'), null, '未启用的内置命令不拦截（先不下发）');

// ---- mergeCommandCandidates：只展示启用的内置命令，工作区模板跟随 ----
{
  const merged = mergeCommandCandidates('m', [{ name: 'model-doc', description: '工作区模板' }]);
  assert.deepEqual(
    merged.map((cmd) => cmd.name),
    ['model-doc'],
    'model 未启用 → 不展示，只剩工作区模板',
  );
  assert.equal(merged[0]?.builtin, false);
  const all = mergeCommandCandidates('', [{ name: 'compact-helper', description: '' }]);
  assert.ok(all[0]?.name === 'compact' && all[0]?.builtin === true);
  assert.ok(all.some((cmd) => cmd.name === 'compact-helper'));
  assert.ok(!all.some((cmd) => cmd.builtin && cmd.name !== 'compact'), '其余内置命令不下发');
}

// ---- matchPermissionMode ----
assert.equal(matchPermissionMode('read-only'), 'read-only');
assert.equal(matchPermissionMode('READ'), 'read-only', '前缀大小写不敏感');
assert.equal(matchPermissionMode('只读'), 'read-only');
assert.equal(matchPermissionMode('workspace'), 'workspace-write');
assert.equal(matchPermissionMode('full'), 'full-access');
assert.equal(matchPermissionMode('nope'), null);
assert.equal(matchPermissionMode(''), null);

// ---- matchModelByQuery ----
{
  const providers = [
    { id: 'deepseek', name: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { id: 'minimax', name: 'MiniMax', models: ['MiniMax-M3'] },
  ];
  assert.deepEqual(matchModelByQuery(providers, 'minimax/MiniMax-M3').match, {
    providerId: 'minimax',
    model: 'MiniMax-M3',
  });
  assert.deepEqual(matchModelByQuery(providers, 'reasoner').match, {
    providerId: 'deepseek',
    model: 'deepseek-reasoner',
  });
  const multi = matchModelByQuery(providers, 'deepseek');
  assert.equal(multi.match, null);
  assert.equal(multi.candidates.length, 2, '多命中带回候选');
  assert.equal(matchModelByQuery(providers, 'nope').candidates.length, 0);
}

console.log('\nbuiltin-commands tests: all PASS');
