import type { HostRun } from './types';

/**
 * Run 提示词/结果文本的安全取值。
 *
 * 为什么单独存在：`HostRun.task` 在类型上是必填 `string`，但前端拿到的是**未校验的
 * JSON**（api.ts 的 jsonFetch 只判断 resp.ok）。一旦历史库脏行、半旧半新的 web/host
 * 版本、或任何字段异常让 task/result 变成 null/数字/对象，调用点上的 `.slice()`
 * 就会抛 TypeError —— 被 React 当作渲染期异常处理，代价是整页空白。
 * （实测：`/runs` 响应里第 2 轮 `task: null` 即可让 TurnNavigator 崩掉整棵树，
 * `#root` 子节点变 0，浏览器只剩一条 console 报错。）
 *
 * 这里把「取值 + 兜底 + 截断」收敛成唯一入口，调用点不再直接碰 `.slice()`：
 * 非字符串一律降级为空串，绝不抛错。截断长度与改动前的写法逐字对齐，因此正常数据
 * 的展示结果不变；只有脏数据从「崩溃」变成「空串/空态文案」。
 */

/** 原始提示词文本；非字符串（null/undefined/数字/对象）→ 空串。 */
export function runTaskText(run: Pick<HostRun, 'task'> | null | undefined): string {
  const task = run?.task;
  return typeof task === 'string' ? task : '';
}

/** 提示词短标签（导航条 aria-label）；非字符串 → 空串，由调用方补空态文案。 */
export function runTaskClip(run: Pick<HostRun, 'task'> | null | undefined, limit: number): string {
  return runTaskText(run).slice(0, limit);
}

/** 终态结果预览；非字符串 → 空串（空串为假值，调用方据此跳过该行，与改动前一致）。 */
export function runResultClip(
  run: Pick<HostRun, 'result'> | null | undefined,
  limit: number,
): string {
  const result = run?.result;
  return typeof result === 'string' ? result.slice(0, limit) : '';
}
