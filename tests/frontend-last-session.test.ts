import assert from 'node:assert/strict';
import { readLastSessionId, saveLastSessionId } from '../web/src/preferences.js';

// 契约：刷新浏览器后回到上次打开的会话，靠的是这份本地记录。
// 它必须满足：
//   1. 存进去能读回来；
//   2. 传 null 是「清掉」，而不是写入空串——否则下次刷新会把空字符串当成有效会话 id；
//   3. localStorage 被禁用（隐私模式/配额）时读写都不能抛，只能安静降级。
// 注意：这里只测存储层。会话是否仍然存在由 App 启动时用服务端清单校验，
// 不在这两个函数的职责范围内。

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

function useStorage(storage: unknown): FakeStorage {
  const fake = new FakeStorage();
  (globalThis as { window?: unknown }).window = { localStorage: storage ?? fake };
  return fake;
}

const KEY = 'payaso.lastSessionId';
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

check('写入后能读回', () => {
  useStorage(null);
  saveLastSessionId('session-abc');
  assert.equal(readLastSessionId(), 'session-abc');
});

check('传 null 是删除键，而不是写入空串', () => {
  const storage = useStorage(null);
  saveLastSessionId('session-abc');
  saveLastSessionId(null);
  assert.equal(readLastSessionId(), null);
  assert.equal(storage.map.has(KEY), false, '键应被移除，而不是留下空值');
});

check('空白值视为无效记录', () => {
  const storage = useStorage(null);
  storage.map.set(KEY, '   ');
  assert.equal(readLastSessionId(), null);
});

check('从未写入过 → null（首次访问）', () => {
  useStorage(null);
  assert.equal(readLastSessionId(), null);
});

check('localStorage 抛错时读写都不崩（隐私模式）', () => {
  const throwing = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  useStorage(throwing);
  assert.equal(readLastSessionId(), null, '读失败应降级为 null');
  saveLastSessionId('session-abc'); // 不应抛出
  saveLastSessionId(null); // 不应抛出
});

check('window 不存在时（非浏览器环境）也不崩', () => {
  (globalThis as { window?: unknown }).window = undefined;
  assert.equal(readLastSessionId(), null);
  saveLastSessionId('session-abc');
});

console.log(`\nFrontend last-session tests: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exit(1);
