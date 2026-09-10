// 套件: 前端思考档次选项 — 标签跟随界面语言偏好（纯函数，无 DOM）
// 用法: node --import tsx tests/frontend-thinking-level.test.ts
// 覆盖：中英标签、值集合与语言无关（只有文案变）、off 恒被剔除、注册表档次优先、
//   自定义端点不出现会静默降级的 xhigh/max、目录未加载时的兜底、title/aria 跟随语言

import assert from 'node:assert/strict';
import {
  thinkingLevelOptionsFor,
  thinkingLevelSelectAriaLabel,
  thinkingLevelSelectTitle,
} from '../web/src/components/SettingsModal/thinking-level-options.js';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

const values = (options: Array<{ value: string }>) => options.map((option) => option.value);
const labels = (options: Array<{ label: string }>) => options.map((option) => option.label);

check('自定义端点：中文标签', () => {
  const options = thinkingLevelOptionsFor({ isPiProvider: false, language: 'zh-CN' });
  assert.deepEqual(values(options), ['', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(labels(options), ['默认（不设置）', '最低', '低', '中', '高']);
});

check('自定义端点：英文标签', () => {
  const options = thinkingLevelOptionsFor({ isPiProvider: false, language: 'en-US' });
  assert.deepEqual(values(options), ['', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(labels(options), ['Default (not set)', 'Minimal', 'Low', 'Medium', 'High']);
});

check('值集合与语言无关：只有文案变', () => {
  const inputs = [
    { isPiProvider: false, supportedLevels: undefined },
    { isPiProvider: true, supportedLevels: undefined },
    { isPiProvider: true, supportedLevels: ['off', 'low', 'high', 'max'] },
  ];
  for (const base of inputs) {
    const zh = thinkingLevelOptionsFor({ ...base, language: 'zh-CN' });
    const en = thinkingLevelOptionsFor({ ...base, language: 'en-US' });
    assert.deepEqual(values(zh), values(en));
    assert.notDeepEqual(labels(zh), labels(en));
  }
});

check('注册表档次优先，且 off 恒被剔除', () => {
  // DeepSeek 注册表：off/low/high/max（minimal/medium 声明为不可用）
  const zh = thinkingLevelOptionsFor({
    supportedLevels: ['off', 'low', 'high', 'max'],
    isPiProvider: true,
    language: 'zh-CN',
  });
  assert.deepEqual(values(zh), ['', 'low', 'high', 'max']);
  assert.deepEqual(labels(zh), ['默认（不设置）', '低', '高', '最强']);
  const en = thinkingLevelOptionsFor({
    supportedLevels: ['off', 'low', 'high', 'max'],
    isPiProvider: true,
    language: 'en-US',
  });
  assert.deepEqual(labels(en), ['Default (not set)', 'Low', 'High', 'Max']);
});

check('非推理模型（注册表只给 off）：只剩「不设置」', () => {
  const options = thinkingLevelOptionsFor({
    supportedLevels: ['off'],
    isPiProvider: true,
    language: 'zh-CN',
  });
  assert.deepEqual(values(options), ['']);
});

check('自定义端点不提供会静默降级的 xhigh/max', () => {
  const options = thinkingLevelOptionsFor({ isPiProvider: false, language: 'zh-CN' });
  assert.ok(!values(options).includes('xhigh'));
  assert.ok(!values(options).includes('max'));
});

check('pi 内置但目录未加载：全量档兜底（不丢已选 xhigh/max）', () => {
  const options = thinkingLevelOptionsFor({ isPiProvider: true, language: 'en-US' });
  assert.deepEqual(values(options), ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(labels(options), [
    'Default (not set)',
    'Minimal',
    'Low',
    'Medium',
    'High',
    'XHigh',
    'Max',
  ]);
});

check('未知档次值不丢：回退为原值当文案', () => {
  const options = thinkingLevelOptionsFor({
    supportedLevels: ['off', 'weird-level'],
    isPiProvider: true,
    language: 'zh-CN',
  });
  assert.deepEqual(values(options), ['', 'weird-level']);
  assert.deepEqual(labels(options), ['默认（不设置）', 'weird-level']);
});

check('title / aria 跟随语言，且说明「未设置 ≠ 关闭思考」', () => {
  const zhTitle = thinkingLevelSelectTitle('zh-CN');
  const enTitle = thinkingLevelSelectTitle('en-US');
  assert.notEqual(zhTitle, enTitle);
  assert.ok(zhTitle.includes('未设置时不发送任何思考参数'));
  assert.ok(enTitle.includes('no thinking parameters are sent'));
  assert.equal(thinkingLevelSelectAriaLabel('zh-CN'), '思考档次');
  assert.equal(thinkingLevelSelectAriaLabel('en-US'), 'Thinking level');
});

console.log(`\n前端思考档次选项汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：中英标签 / 值集合语言无关 / off 剔除 / 注册表优先 / 降级项不提供 / 兜底 ✓');
