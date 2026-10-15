// 目录选择器的"用户取消"判据 —— 锁定它与语言无关。
//
// 真机 bug：中文 macOS 上点「取消」弹 `API 400 无法打开本地文件夹选择器`。
// 根因是老代码只匹配英文 `/user canceled/i`，而中文系统下 osascript 输出的是
// `execution error: 用户已取消。 (-128)` —— 取消被当成失败。
// 下面的字符串是**从真机直接抓的真实输出**（zh_CN）。

import assert from 'node:assert/strict';
import { isAppleScriptCancelled } from '../src/host/workspace.js';

const tests: { name: string; run: () => void }[] = [];
function test(name: string, run: () => void): void {
  tests.push({ name, run });
}

// —— 真实输出（本机 zh_CN 实测）——
test('中文系统的取消输出被识别', () => {
  assert.equal(isAppleScriptCancelled('0:17: execution error: 用户已取消。 (-128)'), true);
});

test('英文系统的取消输出被识别', () => {
  assert.equal(isAppleScriptCancelled('execution error: User canceled. (-128)'), true);
});

test('只要带 -128 就判取消（不依赖文案）', () => {
  // -128 = errAEEventCancelled；即使系统语言是第三种，错误号也在
  assert.equal(isAppleScriptCancelled('execution error: irgendein text (-128)'), true);
});

// —— 真正的失败不能被当成取消（否则会静默吞掉错误）——
test('普通执行错误不算取消', () => {
  assert.equal(isAppleScriptCancelled('execution error: something broke (-1728)'), false);
});

test('空 stderr 不算取消', () => {
  assert.equal(isAppleScriptCancelled(''), false);
});

test('无错误号的本地化取消文案仍能兜住', () => {
  // 万一某个 macOS 版本不打错误号，中英文文案兜底
  assert.equal(isAppleScriptCancelled('execution error: 用户已取消。'), true);
  assert.equal(isAppleScriptCancelled('execution error: User canceled.'), true);
});

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ✓ ${t.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${t.name}\n    ${(error as Error).message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} 通过`);
if (failed > 0) process.exit(1);
