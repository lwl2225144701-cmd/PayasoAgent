// 模块: open-in-app 客户端 controller 单测 —— 默认项记忆的**校验**与**作用域隔离**。
// 用法: npx tsx tests/frontend-open-in-app.test.ts（无浏览器；localStorage 打桩）
//
// 背景（真机 bug）：记忆值不校验就回退时，文件目标存进去的 /Applications/… 路径
// 会在目录目标上悬空 —— 胶囊图标退回通用图标、菜单里没有任何一项标（默认）。

import assert from 'node:assert/strict';
import {
  defaultAppId,
  effectiveDefaultId,
  getSelectedAppId,
  type OpenInApp,
  scopeOfTarget,
  setSelectedAppId,
} from '../web/src/preview/open-in-app';

// Node 里没有 localStorage：用 Map 打桩（模块内部对读写都有 try/catch）
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
};

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

/** 目录目标（白名单来源）的列表。 */
const FOLDER_APPS: OpenInApp[] = [
  { id: 'finder', label: '访达' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'intellij-idea', label: 'IntelliJ IDEA' },
];

/** 文件目标（系统关联来源）的列表：id 是 .app 路径，且第一项被标为系统默认。 */
const FILE_APPS: OpenInApp[] = [
  { id: '/Applications/Preview.app', label: '预览', icon: 'data:image/png;base64,x' },
  { id: '/Applications/WPS Office.app', label: 'wpsoffice', isDefault: true },
];

function reset(): void {
  store.clear();
}

test('记忆为空 → 列表第一个', () => {
  reset();
  assert.equal(defaultAppId(FOLDER_APPS, 'folder'), 'finder');
});

test('记忆值仍在列表里 → 用它（尊重用户上次选择）', () => {
  reset();
  setSelectedAppId('folder', 'cursor');
  assert.equal(defaultAppId(FOLDER_APPS, 'folder'), 'cursor');
});

test('记忆值悬空（列表里没有）→ 退回列表第一个，而不是 null', () => {
  reset();
  // 文件目标存进去的 .app 路径，落到目录目标的列表上必然匹配不到
  setSelectedAppId('file', '/Applications/WPS Office.app');
  setSelectedAppId('folder', '/Applications/WPS Office.app');
  assert.equal(defaultAppId(FOLDER_APPS, 'folder'), 'finder');
});

test('记忆值悬空时不会让图标/高亮落空：默认项仍是列表首个的 id', () => {
  reset();
  setSelectedAppId('folder', 'ghost-app');
  const id = defaultAppId(FOLDER_APPS, 'folder');
  assert.ok(id !== null && FOLDER_APPS.some((app) => app.id === id));
});

test('作用域隔离：给文件目标选过打开方式，不顶掉目录目标的记忆', () => {
  reset();
  setSelectedAppId('folder', 'intellij-idea');
  setSelectedAppId('file', '/Applications/Preview.app');
  assert.equal(getSelectedAppId('folder'), 'intellij-idea');
  assert.equal(getSelectedAppId('file'), '/Applications/Preview.app');
  assert.equal(defaultAppId(FOLDER_APPS, 'folder'), 'intellij-idea');
});

test('两套键不互相覆盖', () => {
  reset();
  setSelectedAppId('folder', 'cursor');
  setSelectedAppId('file', '/Applications/Preview.app');
  setSelectedAppId('file', '/Applications/WPS Office.app');
  assert.equal(getSelectedAppId('folder'), 'cursor');
});

test('scopeOfTarget：给了 path 是文件目标，缺省是目录目标', () => {
  assert.equal(scopeOfTarget('docs/a.pdf'), 'file');
  assert.equal(scopeOfTarget(''), 'folder');
  assert.equal(scopeOfTarget(null), 'folder');
  assert.equal(scopeOfTarget(undefined), 'folder');
});

test('effectiveDefaultId：系统 isDefault 优先于记忆值', () => {
  reset();
  setSelectedAppId('file', '/Applications/Preview.app');
  assert.equal(effectiveDefaultId(FILE_APPS, 'file'), '/Applications/WPS Office.app');
});

test('effectiveDefaultId：无 isDefault 时用校验过的记忆值', () => {
  reset();
  setSelectedAppId('file', '/Applications/Preview.app');
  assert.equal(effectiveDefaultId(FOLDER_APPS, 'folder'), 'finder');
  setSelectedAppId('folder', 'cursor');
  assert.equal(effectiveDefaultId(FOLDER_APPS, 'folder'), 'cursor');
});

test('空列表 → null（调用方据此回退图标/行为）', () => {
  reset();
  assert.equal(defaultAppId([], 'folder'), null);
  assert.equal(defaultAppId([], 'file'), null);
});

test('localStorage 不可用时（隐私模式）不抛错，退回列表首个', () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  try {
    assert.equal(defaultAppId(FOLDER_APPS, 'folder'), 'finder');
    assert.doesNotThrow(() => setSelectedAppId('folder', 'cursor'));
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  }
});

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${(err as Error).message}`);
      failed++;
    }
  }
  console.log(`\nfrontend-open-in-app 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

void main();
