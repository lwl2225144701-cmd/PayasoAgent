// 模块: 历史任务搜索的判定规则（侧栏纯函数）。
//
// 为什么单独存在：侧栏要按「任务标题 + 工作区名」即时筛选，但**不能**丢掉工作区
// 分组语义——命中工作区名时该分组下的任务要全部留下，命中标题时只留那条任务。
// 规则抽成纯函数有两个好处：组件只负责渲染与交互；大小写、首尾空白、特殊字符、
// 分组保留这些边界可以被确定性测试逐条锁定（tests/task-search.test.ts）。
//
// 边界（与需求一一对应）：
//   - 关键词归一化 = 去首尾空白 + 英文转小写；中文原样比较，特殊字符按普通文本；
//   - 空关键词（含纯空白）= 未搜索，原样返回全部分组，不做任何过滤；
//   - 只搜任务标题与工作区名，**不碰聊天正文**（会话正文本来就不在 HostSession 里）。

import type { HostSession } from '../../types';
import type { WorkspaceGroup } from './workspace-expansion';

/** 关键词归一化：首尾空白去掉，英文统一小写（中文不受影响）。 */
export function normalizeTaskSearchKeyword(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 是否处于搜索状态：空关键词（或全是空白）不算。 */
export function isTaskSearchActive(raw: string): boolean {
  return normalizeTaskSearchKeyword(raw).length > 0;
}

/**
 * 单个任务是否命中。标题为空时改用调用方给的展示文案（「未命名任务」）参与匹配，
 * 否则未命名任务永远搜不到。
 */
export function sessionMatchesTaskSearch(
  session: HostSession,
  rawKeyword: string,
  untitledTitle = '',
): boolean {
  const needle = normalizeTaskSearchKeyword(rawKeyword);
  if (needle.length === 0) return true;
  const title = session.title.trim().length > 0 ? session.title : untitledTitle;
  return title.toLowerCase().includes(needle);
}

export interface TaskSearchOptions {
  /** 分组名 → 展示文案（「无工作区」哨兵要翻成当前语言，工作区名命中判定才有意义） */
  groupDisplayName?: (name: string) => string;
  /** 空标题任务的展示文案（参与标题命中判定） */
  untitledTitle?: string;
}

export interface TaskSearchOutcome {
  /** 过滤后的分组：相对输入的顺序不变，只保留有命中任务的分组 */
  groups: WorkspaceGroup[];
  /** 命中任务总数（跨分组累计）—— 为 0 且有关键词时用来显示「无匹配」 */
  matchedSessionCount: number;
}

/**
 * 搜索期间的分组展开覆盖：**命中分组默认展开，用户显式覆盖优先**。
 *
 * 为什么是「合成覆盖」而不是直接改 `expanded`：`isWorkspaceGroupExpanded` 的优先级是
 * 「用户覆盖 > 当前工作区 > 含当前会话」。搜索中如果绕过它直接返回 true，用户在搜索里
 * 手动收起分组会被立刻弹回，交互是坏的；如果把展开态写进 `groupOverrides`，清空搜索后
 * 又需要一份额外快照才能还原 —— 两难。合成覆盖同时解决两边：
 *   - 未手动的分组 → true（搜索期间自动展开）；
 *   - 手动过的分组 → 沿用用户选择（搜索中也能收起）；
 *   - 清空搜索后本函数直接返回 `userOverrides`，展开态自然回到搜索前的判定结果，
 *     **不需要为「恢复」保存任何快照**。
 */
export function resolveSearchExpansionOverrides(options: {
  /** 是否处于搜索状态（关键词非空白） */
  searchActive: boolean;
  /** 当前可见（过滤后）的分组 */
  visibleGroups: readonly WorkspaceGroup[];
  /** 用户手动点过展开/收起的记录 */
  userOverrides: ReadonlyMap<string, boolean>;
}): ReadonlyMap<string, boolean> {
  const { searchActive, visibleGroups, userOverrides } = options;
  // 未搜索：原样交出用户记录，展开态完全由既有规则决定（= 搜索前的状态）
  if (!searchActive) return userOverrides;
  const next = new Map<string, boolean>();
  for (const group of visibleGroups) {
    next.set(group.name, userOverrides.get(group.name) ?? true);
  }
  return next;
}

/**
 * 按关键词过滤分组。两条命中规则：
 *   1. **工作区名命中** → 该分组任务全部保留（用户按目录找任务时的预期）；
 *   2. 否则只保留**标题命中**的任务；整组零命中 → 整个分组不显示。
 */
export function filterWorkspaceGroupsForSearch(
  groups: readonly WorkspaceGroup[],
  rawKeyword: string,
  options: TaskSearchOptions = {},
): TaskSearchOutcome {
  if (!isTaskSearchActive(rawKeyword)) {
    return {
      groups: [...groups],
      matchedSessionCount: groups.reduce((sum, group) => sum + group.sessions.length, 0),
    };
  }

  const needle = normalizeTaskSearchKeyword(rawKeyword);
  const out: WorkspaceGroup[] = [];
  let matchedSessionCount = 0;

  for (const group of groups) {
    const displayName = options.groupDisplayName
      ? options.groupDisplayName(group.name)
      : group.name;
    if (displayName.toLowerCase().includes(needle)) {
      out.push(group);
      matchedSessionCount += group.sessions.length;
      continue;
    }
    const sessions = group.sessions.filter((session) =>
      sessionMatchesTaskSearch(session, needle, options.untitledTitle),
    );
    if (sessions.length === 0) continue;
    out.push({ name: group.name, sessions });
    matchedSessionCount += sessions.length;
  }

  return { groups: out, matchedSessionCount };
}
