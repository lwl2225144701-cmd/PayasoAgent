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
import type { MessageKey } from '../web/src/i18n/messages/index.js';
import { translate } from '../web/src/i18n/translate.js';

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

// 期望值一律从 i18n 消息表取（标签本身不再在测试里抄一份），
// 但断言结构不变：档次与文案的对应关系、顺序、回退行为都仍然被钉住。
const zh = (key: MessageKey) => translate('zh-CN', key);
const en = (key: MessageKey) => translate('en-US', key);

const values = (options: Array<{ value: string }>) => options.map((option) => option.value);
const labels = (options: Array<{ label: string }>) => options.map((option) => option.label);

check('自定义端点：中文标签', () => {
  const options = thinkingLevelOptionsFor({ isPiProvider: false, language: 'zh-CN' });
  assert.deepEqual(values(options), ['', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(labels(options), [
    zh('settings.thinking.notSet'),
    zh('settings.thinking.minimal'),
    zh('settings.thinking.low'),
    zh('settings.thinking.medium'),
    zh('settings.thinking.high'),
  ]);
});

check('自定义端点：英文标签', () => {
  const options = thinkingLevelOptionsFor({ isPiProvider: false, language: 'en-US' });
  assert.deepEqual(values(options), ['', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(labels(options), [
    en('settings.thinking.notSet'),
    en('settings.thinking.minimal'),
    en('settings.thinking.low'),
    en('settings.thinking.medium'),
    en('settings.thinking.high'),
  ]);
});

check('值集合与语言无关：只有文案变', () => {
  const inputs = [
    { isPiProvider: false, supportedLevels: undefined },
    { isPiProvider: true, supportedLevels: undefined },
    { isPiProvider: true, supportedLevels: ['off', 'low', 'high', 'max'] },
  ];
  for (const base of inputs) {
    const zhOptions = thinkingLevelOptionsFor({ ...base, language: 'zh-CN' });
    const enOptions = thinkingLevelOptionsFor({ ...base, language: 'en-US' });
    assert.deepEqual(values(zhOptions), values(enOptions));
    assert.notDeepEqual(labels(zhOptions), labels(enOptions));
  }
});

check('注册表档次优先，且 off 恒被剔除', () => {
  // DeepSeek 注册表：off/low/high/max（minimal/medium 声明为不可用）
  const zhOptions = thinkingLevelOptionsFor({
    supportedLevels: ['off', 'low', 'high', 'max'],
    isPiProvider: true,
    language: 'zh-CN',
  });
  assert.deepEqual(values(zhOptions), ['', 'low', 'high', 'max']);
  assert.deepEqual(labels(zhOptions), [
    zh('settings.thinking.notSet'),
    zh('settings.thinking.low'),
    zh('settings.thinking.high'),
    zh('settings.thinking.max'),
  ]);
  const enOptions = thinkingLevelOptionsFor({
    supportedLevels: ['off', 'low', 'high', 'max'],
    isPiProvider: true,
    language: 'en-US',
  });
  assert.deepEqual(labels(enOptions), [
    en('settings.thinking.notSet'),
    en('settings.thinking.low'),
    en('settings.thinking.high'),
    en('settings.thinking.max'),
  ]);
});

check('非推理模型（注册表只给 off）：只剩「不设置」', () => {
  const options = thinkingLevelOptionsFor({
    supportedLevels: ['off'],
    isPiProvider: true,
    language: 'zh-CN',
  });
  assert.deepEqual(values(options), ['']);
  assert.deepEqual(labels(options), [zh('settings.thinking.notSet')]);
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
    en('settings.thinking.notSet'),
    en('settings.thinking.minimal'),
    en('settings.thinking.low'),
    en('settings.thinking.medium'),
    en('settings.thinking.high'),
    en('settings.thinking.xhigh'),
    en('settings.thinking.max'),
  ]);
});

check('未知档次值不丢：回退为原值当文案（不是空串、不是 key）', () => {
  const options = thinkingLevelOptionsFor({
    supportedLevels: ['off', 'weird-level'],
    isPiProvider: true,
    language: 'zh-CN',
  });
  assert.deepEqual(values(options), ['', 'weird-level']);
  assert.deepEqual(labels(options), [zh('settings.thinking.notSet'), 'weird-level']);
});

check('title / aria 跟随语言，且说明「未设置 ≠ 关闭思考」', () => {
  const zhTitle = thinkingLevelSelectTitle('zh-CN');
  const enTitle = thinkingLevelSelectTitle('en-US');
  assert.equal(zhTitle, zh('settings.thinking.selectTitle'));
  assert.equal(enTitle, en('settings.thinking.selectTitle'));
  assert.notEqual(zhTitle, enTitle);
  // 除「跟随语言」外，说明本身仍须讲清语义，不能退化成一句无信息量的短标签
  assert.ok(zhTitle.includes('未设置时不发送任何思考参数'));
  assert.ok(enTitle.includes('no thinking parameters are sent'));
  assert.equal(thinkingLevelSelectAriaLabel('zh-CN'), zh('settings.thinking.selectAria'));
  assert.equal(thinkingLevelSelectAriaLabel('en-US'), en('settings.thinking.selectAria'));
});

check('档次文案的中英两侧确实不同（避免中英混排抄成同一份）', () => {
  const keys: MessageKey[] = [
    'settings.thinking.notSet',
    'settings.thinking.off',
    'settings.thinking.minimal',
    'settings.thinking.low',
    'settings.thinking.medium',
    'settings.thinking.high',
    'settings.thinking.xhigh',
    'settings.thinking.max',
    'settings.thinking.selectAria',
  ];
  for (const key of keys) {
    assert.notEqual(zh(key), en(key), `${key} 的中英文案相同`);
    assert.ok(zh(key).length > 0 && en(key).length > 0, `${key} 有空文案`);
  }
});

console.log(`\n前端思考档次选项汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：中英标签 / 值集合语言无关 / off 剔除 / 注册表优先 / 降级项不提供 / 兜底 ✓');
