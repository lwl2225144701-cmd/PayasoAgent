import type { HostRun } from './types';

/**
 * Run 上会被渲染消费的标量字段。
 *
 * 用 `Record<Exclude<keyof HostRun, 'workspace'>, true>` 做编译期护栏：
 * 以后给 HostRun 新增字段却忘了在这里登记，会直接编译失败，而不是让
 * `sameRunView` 悄悄漏比该字段、把更新吞掉。
 */
const RUN_SCALAR_KEYS: Record<Exclude<keyof HostRun, 'workspace'>, true> = {
  runId: true,
  sessionId: true,
  turnIndex: true,
  task: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  result: true,
  error: true,
  providerId: true,
  model: true,
  permissionMode: true,
};

function sameRunView(a: HostRun, b: HostRun): boolean {
  for (const key of Object.keys(RUN_SCALAR_KEYS) as Array<keyof typeof RUN_SCALAR_KEYS>) {
    if (!Object.is(a[key], b[key])) return false;
  }
  // workspace 是对象：Host 每次都返回新实例，必须按值比较，
  // 否则「引用复用」永远不会命中，memo 也就白加了。
  return a.workspace?.name === b.workspace?.name;
}

/**
 * 用上一份 Run 快照复用未变化条目的对象引用。
 *
 * `/runs` 每次返回全新 JSON 对象，直接 `setRuns(resp.runs)` 会让会话里**全部历史回合**
 * 的 Timeline 重渲（memo 因 run 引用变化而失效），并连带重建各自的 buildStructure。
 * 只在字段真的变化时替换引用。
 *
 * 返回入参 `previous` 本身表示「数量、顺序、内容都没变」——setState 收到同一引用会直接
 * bail out，连 App 级重渲都省掉。
 */
export function reconcileRuns(previous: HostRun[], next: HostRun[]): HostRun[] {
  const byId = new Map(previous.map((run) => [run.runId, run]));
  const merged = next.map((run) => {
    const old = byId.get(run.runId);
    return old && sameRunView(old, run) ? old : run;
  });
  const unchanged =
    merged.length === previous.length && merged.every((run, index) => run === previous[index]);
  return unchanged ? previous : merged;
}
