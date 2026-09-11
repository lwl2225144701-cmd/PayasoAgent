import type { HostSession } from '../../types';

export interface WorkspaceGroup {
  name: string;
  sessions: HostSession[];
}

/**
 * 侧栏工作区分组是否展开：**用户显式选择优先，否则自动判定**。
 *
 * 自动判定有两条：
 *   1. 当前工作区所在分组 —— 原有行为；
 *   2. **包含当前会话的分组** —— 刷新后恢复会话时，用户需要立刻看到自己在哪个工作区，
 *      而「当前工作区」未必就是该会话所属的分组（两者可以不一致，实测就是这样）。
 *
 * 为什么这里返回布尔值而不是把判断交给 `Collapse` 的 `defaultExpanded`：
 * 后者只在**挂载那一刻**生效，而「当前会话属于哪个分组」要等会话清单回来才知道 ——
 * 用默认值的结果是当前会话所在分组一直收着，用户看不到自己在哪。
 */
export function isWorkspaceGroupExpanded(
  group: WorkspaceGroup,
  options: {
    currentSessionId: string | null;
    /** 当前工作区分组名（无工作区时为哨兵值，由调用方给出） */
    currentWorkspaceName: string;
    /** 用户手动点过展开/收起的记录，优先级最高 */
    overrides: ReadonlyMap<string, boolean>;
  },
): boolean {
  const override = options.overrides.get(group.name);
  if (override !== undefined) return override;
  if (group.name === options.currentWorkspaceName) return true;
  return (
    options.currentSessionId !== null &&
    group.sessions.some((session) => session.sessionId === options.currentSessionId)
  );
}
