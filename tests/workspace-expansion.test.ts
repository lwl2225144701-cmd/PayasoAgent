import assert from 'node:assert/strict';
import {
  isWorkspaceGroupExpanded,
  type WorkspaceGroup,
} from '../web/src/components/WorkspaceSection/workspace-expansion.js';
import type { HostSession } from '../web/src/types.js';

// 契约：侧栏工作区分组的展开规则。
//
// 第 2 条用例是本次的回归重点：刷新浏览器恢复会话时，当前会话所在分组必须展开 ——
// 用户得能立刻看到自己在哪个工作区。此前用的是 Collapse 的 defaultExpanded，
// 只在挂载那一刻生效，而会话清单是异步回来的，导致该分组一直收着（实测复现）。

const NO_WORKSPACE = '\u0000no-workspace';

function session(sessionId: string, workspaceName: string): HostSession {
  return {
    sessionId,
    title: `标题 ${sessionId}`,
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    workspace: { name: workspaceName },
  };
}

const payaso: WorkspaceGroup = {
  name: 'PayasoAgent',
  sessions: [session('s-payaso', 'PayasoAgent')],
};
const pi: WorkspaceGroup = { name: 'pi', sessions: [session('s-pi', 'pi')] };
const none: WorkspaceGroup = { name: NO_WORKSPACE, sessions: [session('s-none', '')] };

const NO_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

type Case = { name: string; run: () => void };
const cases: Case[] = [
  {
    name: '当前工作区分组默认展开',
    run: () => {
      assert.equal(
        isWorkspaceGroupExpanded(payaso, {
          currentSessionId: null,
          currentWorkspaceName: 'PayasoAgent',
          overrides: NO_OVERRIDES,
        }),
        true,
      );
    },
  },
  {
    name: '【刷新恢复回归】当前会话所在分组展开，即使它不是当前工作区',
    run: () => {
      // 实测场景：当前工作区是 pi，但恢复出来的会话属于 PayasoAgent
      assert.equal(
        isWorkspaceGroupExpanded(payaso, {
          currentSessionId: 's-payaso',
          currentWorkspaceName: 'pi',
          overrides: NO_OVERRIDES,
        }),
        true,
        '当前会话所在分组必须展开，否则用户看不到自己在哪',
      );
    },
  },
  {
    name: '当前会话与当前工作区不一致时，两个分组都展开',
    run: () => {
      const options = {
        currentSessionId: 's-payaso',
        currentWorkspaceName: 'pi',
        overrides: NO_OVERRIDES,
      };
      assert.equal(isWorkspaceGroupExpanded(payaso, options), true);
      assert.equal(isWorkspaceGroupExpanded(pi, options), true);
    },
  },
  {
    name: '既不是当前工作区、也不含当前会话 → 收起',
    run: () => {
      assert.equal(
        isWorkspaceGroupExpanded(pi, {
          currentSessionId: 's-payaso',
          currentWorkspaceName: 'PayasoAgent',
          overrides: NO_OVERRIDES,
        }),
        false,
      );
    },
  },
  {
    name: '没有当前会话时只看当前工作区（landing）',
    run: () => {
      const options = {
        currentSessionId: null,
        currentWorkspaceName: 'pi',
        overrides: NO_OVERRIDES,
      };
      assert.equal(isWorkspaceGroupExpanded(pi, options), true);
      assert.equal(isWorkspaceGroupExpanded(payaso, options), false);
      assert.equal(isWorkspaceGroupExpanded(none, options), false);
    },
  },
  {
    name: '用户收起当前会话所在分组后保持收起（覆盖优先，不被自动逻辑弹开）',
    run: () => {
      assert.equal(
        isWorkspaceGroupExpanded(payaso, {
          currentSessionId: 's-payaso',
          currentWorkspaceName: 'payaso-placeholder',
          overrides: new Map([['PayasoAgent', false]]),
        }),
        false,
      );
    },
  },
  {
    name: '用户展开一个普通分组后保持展开',
    run: () => {
      assert.equal(
        isWorkspaceGroupExpanded(none, {
          currentSessionId: 's-payaso',
          currentWorkspaceName: 'PayasoAgent',
          overrides: new Map([[NO_WORKSPACE, true]]),
        }),
        true,
      );
    },
  },
  {
    name: '无工作区哨兵名同样适用「含当前会话」规则',
    run: () => {
      assert.equal(
        isWorkspaceGroupExpanded(none, {
          currentSessionId: 's-none',
          currentWorkspaceName: 'pi',
          overrides: NO_OVERRIDES,
        }),
        true,
      );
    },
  },
];

for (const item of cases) {
  item.run();
  console.log(`  [PASS] ${item.name}`);
}

console.log(`\nWorkspace expansion tests: ${cases.length} PASS / 0 FAIL`);
