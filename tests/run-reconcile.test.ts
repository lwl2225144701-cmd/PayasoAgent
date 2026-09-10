import assert from 'node:assert/strict';
import { reconcileRuns } from '../web/src/run-reconcile.js';
import type { HostRun } from '../web/src/types.js';

// 契约：/runs 每次返回全新 JSON 对象，reconcileRuns 负责把「没变的 Run」还原成
// 上一份快照里的对象引用。Timeline 是 memo 组件——只有引用稳定，历史回合才能在
// 每次状态对账后跳过重渲。本测试同时锁定「该复用的复用」与「该替换的必须替换」两侧。

function run(overrides: Partial<HostRun> = {}): HostRun {
  return {
    runId: 'r1',
    sessionId: 's1',
    turnIndex: 1,
    task: '任务',
    status: 'running',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:01.000Z',
    permissionMode: 'workspace-write',
    ...overrides,
  };
}

/** 模拟一次 /runs 响应：结构相同但全是新实例。 */
function freshCopy(source: HostRun): HostRun {
  return { ...source, ...(source.workspace ? { workspace: { ...source.workspace } } : {}) };
}

const cases: Array<{ name: string; run: () => void }> = [
  {
    name: '内容与顺序完全一致 → 返回原数组（setState 可直接 bail out）',
    run: () => {
      const previous = [run(), run({ runId: 'r2', turnIndex: 2 })];
      const next = previous.map(freshCopy);
      assert.equal(reconcileRuns(previous, next), previous, '应返回 previous 本身');
    },
  },
  {
    name: 'workspace 是新实例但值相同 → 按值比较后复用旧引用',
    run: () => {
      const previous = [run({ workspace: { name: 'pi' } })];
      const next = [run({ workspace: { name: 'pi' } })];
      // 嵌套对象身份不同、值相同：必须判定为「未变化」，否则引用复用永远不命中。
      assert.notEqual(next[0], previous[0], '前置条件：两个是不同的对象实例');
      assert.equal(reconcileRuns(previous, next), previous, '值相同 → 原样返回');
    },
  },
  {
    name: 'status 变化 → 只替换该条目，其余引用保持',
    run: () => {
      const first = run();
      const second = run({ runId: 'r2', turnIndex: 2 });
      const previous = [first, second];
      const merged = reconcileRuns(previous, [run({ status: 'completed' }), freshCopy(second)]);
      assert.notEqual(merged[0], first, '变化的条目必须替换');
      assert.equal(merged[0]?.status, 'completed');
      assert.equal(merged[1], second, '未变化的条目引用必须保持');
    },
  },
  {
    name: 'result 变化被检测到（防止漏比字段吞掉更新）',
    run: () => {
      const previous = [run({ result: '旧答案' })];
      const merged = reconcileRuns(previous, [run({ result: '新答案' })]);
      assert.notEqual(merged[0], previous[0]);
      assert.equal(merged[0]?.result, '新答案');
    },
  },
  {
    name: 'workspace 名称变化被检测到',
    run: () => {
      const previous = [run({ workspace: { name: 'pi' } })];
      const merged = reconcileRuns(previous, [run({ workspace: { name: 'other' } })]);
      assert.notEqual(merged[0], previous[0]);
      assert.equal(merged[0]?.workspace?.name, 'other');
    },
  },
  {
    name: '新增 Run → 新数组，旧条目引用保持',
    run: () => {
      const existing = run();
      const previous = [existing];
      const appended = run({ runId: 'r2', turnIndex: 2 });
      const merged = reconcileRuns(previous, [freshCopy(existing), appended]);
      assert.notEqual(merged, previous);
      assert.equal(merged[0], existing);
      assert.equal(merged[1], appended);
      assert.equal(merged.length, 2);
    },
  },
  {
    name: '删除 Run → 新数组',
    run: () => {
      const first = run();
      const second = run({ runId: 'r2', turnIndex: 2 });
      const previous = [first, second];
      const merged = reconcileRuns(previous, [freshCopy(second)]);
      assert.notEqual(merged, previous, '数量变了必须是新数组');
      assert.equal(merged.length, 1);
      assert.equal(merged[0], second);
    },
  },
  {
    name: '顺序变化 → 不得返回原数组（否则顺序会过期）',
    run: () => {
      const first = run();
      const second = run({ runId: 'r2', turnIndex: 2 });
      const previous = [first, second];
      const merged = reconcileRuns(previous, [freshCopy(second), freshCopy(first)]);
      assert.notEqual(merged, previous, '顺序变了就不能原样返回');
      assert.equal(merged[0], second);
      assert.equal(merged[1], first);
    },
  },
  {
    name: '空快照为起点 → 内容确实变了，采用新列表元素',
    run: () => {
      const next = [run()];
      const merged = reconcileRuns([], next);
      assert.equal(merged.length, 1);
      assert.equal(merged[0], next[0]);
    },
  },
];

for (const item of cases) {
  item.run();
  console.log(`  [PASS] ${item.name}`);
}

console.log(`\nRun reconcile tests: ${cases.length} PASS / 0 FAIL`);
