// 模块: 消息输入框草稿自动保存与恢复测试（无 LLM、无 DOM）。
// 用法: node --import tsx tests/frontend-composer-draft.test.ts （或随 npm run test:all 运行）
//
// 契约（与需求逐条对应）：
//   1. 每个任务独立保存文字草稿；新建任务页（无会话 id）也有独立草稿，互不串用。
//   2. 切换任务、刷新页面后自动恢复（键只由作用域决定，刷新后命中同一把键）。
//   3. 发送成功清除对应草稿；发送失败保留，且不覆盖用户后来输入的内容（旧草稿在前、
//      新输入接后）。
//   4. 仅保存文字：附件不进草稿（本模块不出现任何附件/File 概念）。
//   5. 本地存储不可用（隐私模式 / 配额 / 非浏览器环境）时读写全部安静降级，
//      输入与发送不受影响。
// 说明：存取与合并是纯函数，直接调用；React 侧的接线（恢复时机、发送成功/失败分支）
// 用源码契约断言守住（防倒退的第一道防线）；真实行为交错（发送等待期的新输入、切任务、
// 刷新恢复）由 tests/frontend-composer-draft-dom.test.ts 以 jsdom + 真实 React 渲染验证。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clampDraftText,
  clearComposerDraft,
  composerDraftKey,
  isDraftWorthSaving,
  MAX_DRAFT_CHARS,
  mergeDraftOnSendFailure,
  NEW_TASK_DRAFT_SCOPE,
  readComposerDraft,
  saveComposerDraft,
} from '../web/src/components/InputBar/composer-draft.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...segments), 'utf8');
}

class FakeStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** 挂上（或换掉）window.localStorage；返回底层存储，便于断言键集合。 */
function useStorage(storage: unknown = new FakeStorage()): FakeStorage {
  const fake = storage instanceof FakeStorage ? storage : new FakeStorage();
  (globalThis as { window?: unknown }).window = { localStorage: storage ?? fake };
  return fake;
}

/** 模拟刷新：localStorage 内容不变，但 window 对象是全新的。 */
function reloadWithSameStorage(map: Map<string, string>): void {
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    },
  };
}

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

// ── 1. 任务隔离：每个任务一把键，新建任务页独立作用域 ─────────────────────

check('草稿键按任务隔离：不同 sessionId 落到不同键', () => {
  const a = composerDraftKey('session-a');
  const b = composerDraftKey('session-b');
  assert.notEqual(a, b);
  assert.equal(a, 'payaso.composerDraft.session-a');
  assert.equal(b, 'payaso.composerDraft.session-b');
});

check('新建任务页有独立草稿作用域（null / undefined / 空串 / 空白）', () => {
  const key = composerDraftKey(null);
  assert.equal(key, `payaso.composerDraft.${NEW_TASK_DRAFT_SCOPE}`);
  assert.equal(composerDraftKey(undefined), key);
  assert.equal(composerDraftKey(''), key);
  assert.equal(composerDraftKey('   '), key);
  assert.notEqual(key, composerDraftKey('session-a'), '不能和任何真实任务串用');
});

check('任务隔离：写 A 的草稿不影响 B，也读不到 B 的草稿', () => {
  const storage = useStorage();
  saveComposerDraft('session-a', 'A 的草稿');
  saveComposerDraft('session-b', 'B 的草稿');
  assert.equal(readComposerDraft('session-a'), 'A 的草稿');
  assert.equal(readComposerDraft('session-b'), 'B 的草稿');
  assert.equal(readComposerDraft('session-c'), '', '没写过草稿的任务读到空串');
  assert.equal(storage.map.size, 2, '每个任务恰好一份草稿');
});

check('新建任务页与任务草稿互不串用', () => {
  useStorage();
  saveComposerDraft(null, '新建任务的草稿');
  saveComposerDraft('session-a', '任务 A 的草稿');
  assert.equal(readComposerDraft(null), '新建任务的草稿');
  assert.equal(readComposerDraft('session-a'), '任务 A 的草稿');
  assert.equal(readComposerDraft(undefined), '新建任务的草稿');
});

check('清除一个任务的草稿不影响其它任务', () => {
  useStorage();
  saveComposerDraft('session-a', 'A');
  saveComposerDraft('session-b', 'B');
  clearComposerDraft('session-a');
  assert.equal(readComposerDraft('session-a'), '');
  assert.equal(readComposerDraft('session-b'), 'B');
});

// ── 2. 刷新恢复：键稳定，重开页面读回同一份草稿 ───────────────────────────

check('刷新页面后草稿仍在（键稳定，localStorage 内容不变）', () => {
  const storage = useStorage();
  saveComposerDraft('session-a', '写了一半的需求');
  reloadWithSameStorage(storage.map); // 模拟 F5
  assert.equal(readComposerDraft('session-a'), '写了一半的需求');
});

check('刷新后新建任务页草稿同样恢复', () => {
  const storage = useStorage();
  saveComposerDraft(null, '还没选任务就想说的话');
  reloadWithSameStorage(storage.map);
  assert.equal(readComposerDraft(null), '还没选任务就想说的话');
});

check('写入后能读回（含换行与首尾空白）', () => {
  useStorage();
  const text = '第一行\n\n  第二行  ';
  saveComposerDraft('session-a', text);
  assert.equal(readComposerDraft('session-a'), text, '草稿原样保存，不做 trim');
});

// ── 3. 发送成功清除 / 失败保留且不覆盖新输入 ─────────────────────────────

check('发送成功：清除对应任务的草稿', () => {
  const storage = useStorage();
  saveComposerDraft('session-a', '即将发送的任务');
  clearComposerDraft('session-a');
  assert.equal(readComposerDraft('session-a'), '');
  assert.equal(storage.map.has(composerDraftKey('session-a')), false, '键应被移除');
});

check('发送失败：草稿保留，用户后来输入的内容接在后面', () => {
  useStorage();
  const draftText = '原始草稿';
  const typedWhileSending = '期间新输入';
  const merged = mergeDraftOnSendFailure(draftText, typedWhileSending);
  assert.equal(merged, '原始草稿\n期间新输入');
  saveComposerDraft('session-a', merged);
  assert.equal(readComposerDraft('session-a'), '原始草稿\n期间新输入');
});

check('发送失败：期间没有新输入 → 还原为原草稿', () => {
  assert.equal(mergeDraftOnSendFailure('原始草稿', ''), '原始草稿');
});

check('发送失败：原草稿为空（只发了附件）→ 保留用户新输入', () => {
  assert.equal(mergeDraftOnSendFailure('', '新输入'), '新输入');
});

check('发送失败：两侧都空 → 空串（不会留下无意义草稿）', () => {
  assert.equal(mergeDraftOnSendFailure('', ''), '');
});

// ── 4. 仅保存文字：空白不入库、超长截断、附件不参与 ───────────────────────

check('空白草稿不入库（清键而不是写空串）', () => {
  const storage = useStorage();
  saveComposerDraft('session-a', '有内容');
  saveComposerDraft('session-a', '   \n  ');
  assert.equal(storage.map.has(composerDraftKey('session-a')), false);
  assert.equal(readComposerDraft('session-a'), '');
  assert.equal(isDraftWorthSaving('   '), false);
  assert.equal(isDraftWorthSaving('x'), true);
});

check('超长草稿截断到上限，不因配额写失败丢整份', () => {
  const long = 'x'.repeat(MAX_DRAFT_CHARS + 500);
  const clamped = clampDraftText(long);
  assert.equal(clamped.length, MAX_DRAFT_CHARS);
  assert.equal(clamped, long.slice(0, MAX_DRAFT_CHARS));
  assert.equal(clampDraftText('短草稿'), '短草稿', '未超限时原样返回');
});

check('草稿模块不涉及附件（仅保存文字）', () => {
  const src = readSource('web', 'src', 'components', 'InputBar', 'composer-draft.ts');
  assert.equal(/\bFile\b|attachment/i.test(src), false, '草稿模块不应出现附件概念');
});

// ── 5. 存储不可用：安静降级，输入与发送不受影响 ───────────────────────────

check('localStorage 抛错时读写都不崩（隐私模式）', () => {
  useStorage({
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  });
  assert.equal(readComposerDraft('session-a'), '', '读失败降级为空草稿');
  saveComposerDraft('session-a', '照常输入'); // 不应抛出
  clearComposerDraft('session-a'); // 不应抛出
});

check('setItem 配额写满时降级，不抛给调用方', () => {
  useStorage({
    getItem: () => null,
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {},
  });
  saveComposerDraft('session-a', '很长的草稿'.repeat(100)); // 不应抛出
});

check('window 不存在时（非浏览器环境）也不崩', () => {
  (globalThis as { window?: unknown }).window = undefined;
  assert.equal(readComposerDraft('session-a'), '');
  saveComposerDraft('session-a', 'x');
  clearComposerDraft('session-a');
});

check('window 存在但没有 localStorage 时也不崩', () => {
  (globalThis as { window?: unknown }).window = {};
  assert.equal(readComposerDraft('session-a'), '');
  saveComposerDraft('session-a', 'x');
  clearComposerDraft('session-a');
});

// ── 接线契约：React 侧必须真的接上（无 jsdom，用源码断言守住） ────────────

const INPUT_BAR = readSource('web', 'src', 'components', 'InputBar', 'index.tsx');
const APP = readSource('web', 'src', 'App.tsx');

check('InputBar 暴露 sessionId 草稿作用域 prop', () => {
  assert.match(INPUT_BAR, /sessionId\?:\s*string\s*\|\s*null/, 'props 里要有 sessionId');
});

check('InputBar 挂载即恢复草稿（useState 初始值读草稿）', () => {
  assert.match(
    INPUT_BAR,
    /useState\(\(\)\s*=>\s*readComposerDraft\(sessionId\)\)/,
    '初始 state 必须读草稿，否则刷新后不恢复',
  );
});

check('InputBar 输入变化即落盘（自动保存）', () => {
  assert.match(INPUT_BAR, /saveComposerDraft\(sessionId,\s*text\)/, '输入变化要写草稿');
});

check('InputBar 切换任务时恢复新任务的草稿', () => {
  assert.match(
    INPUT_BAR,
    /pending\.newerText : readComposerDraft\(sessionId\)/,
    'sessionId 变化必须换成新任务的草稿（发送等待中的作用域显示期间新输入，而非含已发送文本的键内容）',
  );
});

check('InputBar 发送成功清除草稿', () => {
  assert.match(INPUT_BAR, /clearComposerDraft\(pending\.scope\)/, '发送成功分支要清草稿（按作用域，支持等待期切任务）');
});

check('InputBar 发送失败用合并函数还原（不覆盖新输入）', () => {
  assert.match(INPUT_BAR, /mergeDraftOnSendFailure\(pending\.draftText,\s*prev\)/, '失败还原必须走合并函数');
});

check('App 两处 InputBar 都传入 sessionId（会话页 + 新建任务页）', () => {
  const matches = APP.match(/<InputBar[\s\S]{0,200}?sessionId=\{currentSessionId\}/g) ?? [];
  assert.equal(matches.length, 2, `期望 2 处，实际 ${matches.length}`);
});

console.log(`\nFrontend composer-draft tests: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exit(1);
