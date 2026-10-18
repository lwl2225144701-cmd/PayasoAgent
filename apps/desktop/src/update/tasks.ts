// 模块: 「有没有在跑的任务」判定 —— 安装更新前必须先问清楚。
//
// 权威定义在 Host 侧 `src/host/run-types.ts` 的 `isCancellable()`：running（执行中）
// 与 stopping（已请求停止、abort 已发出、执行未退出）都算"在跑"，此时替换 .app
// 会把用户的任务连同后端进程一起打断。确定性套件锁两份列表一致（壳不能 import
// Host 代码：rootDir 不同，且壳不该依赖 Host 实现）。
//
// 数据来源：`GET /runs` 返回 `{ runs: [...] }`，每个 run 带 `status`
// （routes/runs-handler.ts:86），该 GET 不鉴权、不查 origin，壳直接 fetch 即可
// （调研 §5.2，后端零改动）。

/** 与 Host `isCancellable()` 对齐的"在跑"状态。 */
export const ACTIVE_RUN_STATUSES: readonly string[] = ['running', 'stopping'];

/** `GET /runs` 的响应体（只取壳用得到的字段）。 */
interface RunsPayload {
  runs?: { runId?: string; status?: string; task?: string }[];
}

/**
 * 数出"在跑"的任务，并给出它们的任务描述（确认框里要告诉用户会打断什么）。
 * 数据形状不对时拒绝安装，不能把无法确认当成没有任务。
 */
export function activeTasks(payload: unknown): { runId: string; task: string }[] {
  const runs = (payload as RunsPayload | null)?.runs;
  if (!Array.isArray(runs) || runs.some((run) => typeof run?.status !== 'string')) {
    throw new Error('本地任务状态响应异常，已保留更新包，请稍后重试安装');
  }
  return runs
    .filter((run) => typeof run?.status === 'string' && ACTIVE_RUN_STATUSES.includes(run.status))
    .map((run) => ({ runId: run.runId ?? '', task: run.task ?? '' }));
}
