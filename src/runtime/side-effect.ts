// 模块: Side-Effect Safety — 高风险副作用（non_idempotent）操作的操作身份去重
// 核心原则：non_idempotent 必须显式定义"什么叫同一个操作"（getOperationKey）。
// 运行时以此做操作身份识别：同一 run 内同一 canonical operation key 成功执行后，
// 后续重复请求一律回放首次结果，绝不重复执行副作用（防重放 / 防双写 / 防重复扣款等）。
// read / idempotent 可安全重复执行，不进入去重。
// 已执行操作随 checkpoint 持久化，resume 时恢复，跨中断防重放。

import type { Tool } from "../tools/tools.js";
import { resolveOperationKey } from "../tools/tools.js";

// 完整操作身份：`toolName::canonicalOpKey`（跨工具命名空间隔离，避免不同工具同参冲突）
export function operationIdentity(
  tool: Tool,
  args: Record<string, unknown>
): string {
  return `${tool.name}::${resolveOperationKey(tool, args)}`;
}

// 已执行操作记录（供 checkpoint 持久化 / resume 恢复）
export interface ExecutedOperation {
  key: string; // operationIdentity(tool, args)
  result: string; // 首次成功结果（回放用）
}

export interface SideEffectGuard {
  // 该操作身份是否已成功执行过
  isExecuted(key: string): boolean;
  // 回放已执行操作的结果；未执行过返回 undefined
  replay(key: string): string | undefined;
  // 记录一次成功执行（仅在 execute 成功后调用）
  record(key: string, result: string): void;
  // 导出已执行操作（checkpoint 持久化 / resume 种子）
  snapshot(): ExecutedOperation[];
}

// 创建 per-run 副作用守卫；seed 用于 resume 时恢复已执行操作
export function createSideEffectGuard(
  seed: ExecutedOperation[] = []
): SideEffectGuard {
  const done = new Map<string, string>();
  for (const op of seed) done.set(op.key, op.result);
  return {
    isExecuted: (key) => done.has(key),
    replay: (key) => done.get(key),
    record: (key, result) => {
      done.set(key, result);
    },
    snapshot: () =>
      [...done.entries()].map(([key, result]) => ({ key, result })),
  };
}

// ---- Agent Loop 集成辅助 ----
// 非幂等且已执行过 → 返回缓存结果（回放）；未执行过或非 non_idempotent → undefined
export function getReplay(
  guard: SideEffectGuard,
  tool: Tool,
  args: Record<string, unknown>
): string | undefined {
  if (tool.effect !== "non_idempotent") return undefined;
  return guard.replay(operationIdentity(tool, args));
}

// 非幂等 execute 成功后记录操作身份（read/idempotent 不记录）
export function markExecuted(
  guard: SideEffectGuard,
  tool: Tool,
  args: Record<string, unknown>,
  result: string
): void {
  if (tool.effect !== "non_idempotent") return;
  guard.record(operationIdentity(tool, args), result);
}
