// 模块: Side-Effect Safety — 高风险副作用（non_idempotent）操作的身份去重 + 生命周期保护
// v1.3.2：新增 executing / uncertain 持久化语义 ——
//   - 操作状态模型：executing（已开始执行，结果未知）→ succeeded（成功+result）| uncertain（throw/崩溃，副作用可能已发生）
//   - execute 前必须持久化 executing（persist 失败 → 禁止 execute，见 agent.ts）
//   - succeeded → 回放已保存 result，不执行
//   - executing / uncertain → 不执行，返回明确 uncertain recovery 信息给 LLM
//   - 不存在 → 正常开始新执行
// read / idempotent 可安全重复执行，不进入本生命周期。
// 核心原则：对 non_idempotent 操作，Runtime 一旦无法确认"没有执行过"，就不能再次自动执行。

import type { Tool, ToolContext, ToolEffect } from '../tools/tools.js';
import { resolveOperationKey } from '../tools/tools.js';

// 操作状态：executing / succeeded / uncertain
export type OperationState = 'executing' | 'succeeded' | 'uncertain';

// 完整操作身份：`toolName::canonicalOpKey`（跨工具命名空间隔离，避免不同工具同参冲突）
// context 可选：路径类工具用它做路径归一化（./work/a.txt 与 work/a.txt → 同一 key）。
export function operationIdentity(
  tool: Tool,
  args: Record<string, unknown>,
  context?: ToolContext,
): string {
  return `${tool.name}::${resolveOperationKey(tool, args, context)}`;
}

// 持久化的操作记录（checkpoint / resume 种子）
export interface ExecutedOperation {
  key: string; // operationIdentity(tool, args)
  state: OperationState; // v1.3.2：操作生命周期状态
  result?: string; // 仅 succeeded 时保存首次成功结果（回放用）
}

export interface SideEffectGuard {
  // 该 key 是否已存在任意状态记录（executing/succeeded/uncertain）
  isExecuted(key: string): boolean;
  // 当前状态（无记录返回 undefined）
  getState(key: string): OperationState | undefined;
  // 仅 succeeded 返回首次结果；executing/uncertain 返回 undefined（不伪造成功）
  replay(key: string): string | undefined;
  // 记录开始执行（executing）—— 必须在 execute 前调用并持久化
  begin(key: string): void;
  // 执行成功 → succeeded + result
  succeed(key: string, result: string): void;
  // execute throw/崩溃 → uncertain（副作用可能已发生，不允许再次执行）
  markUncertain(key: string): void;
  // 导出记录（checkpoint 持久化 / resume 种子）
  snapshot(): ExecutedOperation[];
}

// 创建 per-run 副作用守卫；seed 用于 resume 时恢复已记录操作
export function createSideEffectGuard(seed: ExecutedOperation[] = []): SideEffectGuard {
  const done = new Map<string, { state: OperationState; result?: string }>();
  for (const op of seed) {
    // 旧 checkpoint 格式 {key,result}（无 state）兼容：v1.3 只记录成功 → 视为 succeeded
    const state: OperationState = op.state ?? 'succeeded';
    done.set(op.key, { state, result: op.result });
  }
  return {
    isExecuted: (key) => done.has(key),
    getState: (key) => done.get(key)?.state,
    replay: (key) => (done.get(key)?.state === 'succeeded' ? done.get(key)?.result : undefined),
    begin: (key) => done.set(key, { state: 'executing' }),
    succeed: (key, result) => done.set(key, { state: 'succeeded', result }),
    markUncertain: (key) => done.set(key, { state: 'uncertain' }),
    snapshot: () =>
      [...done.entries()].map(([key, v]) => ({
        key,
        state: v.state,
        result: v.result,
      })),
  };
}

// ---- Agent Loop 集成辅助 ----

// 判定一次 non_idempotent 调用应如何处置：
//   replay    → 已成功执行过 → 回放 result，不执行
//   uncertain → executing/uncertain → 不执行，返回明确 uncertain 信息
//   start     → 无记录 → 正常开始（调用方需在 execute 前持久化 executing）
export type OperationDisposition =
  | { kind: 'replay'; result: string }
  | { kind: 'uncertain' }
  | { kind: 'start' };

export function resolveOperation(
  guard: SideEffectGuard,
  tool: Tool,
  args: Record<string, unknown>,
  context?: ToolContext,
  // v1.9：调用方传入 resolveToolEffect 的结果；缺省回退静态声明（兼容旧调用方）。
  effect: ToolEffect = tool.effect,
): OperationDisposition {
  if (effect !== 'non_idempotent') return { kind: 'start' };
  const key = operationIdentity(tool, args, context);
  const state = guard.getState(key);
  if (state === 'succeeded') {
    return { kind: 'replay', result: guard.replay(key)! };
  }
  if (state === 'executing' || state === 'uncertain') {
    return { kind: 'uncertain' };
  }
  return { kind: 'start' };
}

// 非幂等且已成功执行过 → 返回缓存结果（回放）；否则 undefined（含 executing/uncertain）
export function getReplay(
  guard: SideEffectGuard,
  tool: Tool,
  args: Record<string, unknown>,
  context?: ToolContext,
  effect: ToolEffect = tool.effect,
): string | undefined {
  if (effect !== 'non_idempotent') return undefined;
  return guard.replay(operationIdentity(tool, args, context));
}

// 非幂等 execute 成功后记录 succeeded（read/idempotent 不记录）
export function markExecuted(
  guard: SideEffectGuard,
  tool: Tool,
  args: Record<string, unknown>,
  result: string,
  context?: ToolContext,
  effect: ToolEffect = tool.effect,
): void {
  if (effect !== 'non_idempotent') return;
  guard.succeed(operationIdentity(tool, args, context), result);
}
