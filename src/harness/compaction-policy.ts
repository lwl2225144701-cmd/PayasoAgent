// 压缩阈值策略（P2-D · docs/plans/context-management-plan.md）：
// 决定「什么时候压」与「压完留多少」。
//
// 为什么不能只用比例：原来的触发线是 `maxInputTokens × 0.8`，它锚在**容量**上，
// 随窗口一起长大。实测 step-5-preview 窗口 1M → 触发线 77.7 万 token，而一次
// 长会话只涨到 30 万：**永远不会触发**，上下文一路裸奔到「20 次调用 / 16.7 分钟」。
// 参考实现那条 `min(W×0.8, W−O−64K)` 也治不了这个病——代入 1M 窗口它触发于
// 81.9 万，比我们原本还晚；那个 64K 绝对项只在 256K 这类小窗口下才顶得住。
// 它服务的目标是「防溢出」（别撑爆窗口），不是「控时延」（别越聊越慢）。
//
// 所以要补一条**独立于窗口**的成本上限，与比例项取 min；并用「带宽」隔离
// 触发线与保留量，避免刚压完就又触发（疯狂压缩）。
//
// 带宽怎么定（实测依据：普通轮 +6K token、重轮 +20K）：
//   1M 窗口 → 触发 160K / 保留 80K → 带宽 80K → 撑 4~13 轮才压一次。

export interface CompactionPolicy {
  /** 比例触发线：maxInputTokens × triggerRatio。 */
  triggerRatio: number;
  /** 独立于窗口的触发上限（token）。省略 = 不设上限（退回纯比例）。 */
  triggerTokens?: number;
  /** 比例保留量：maxInputTokens × retainRatio。 */
  retainRatio: number;
  /** 绝对保留量（token）。省略 = 由「比例保留量」与「触发线一半」取更小者。 */
  retainTokens?: number;
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  triggerRatio: 0.8,
  // 成本上限：与窗口大小无关。1M 窗口下它把触发线从 77.7 万拉回 16 万。
  triggerTokens: 160_000,
  // 保留比例：压完只留 16%（原来是 65%，压得太少，等于没压）。
  retainRatio: 0.16,
};

export interface CompactionThresholds {
  /** 越过它就触发压缩。 */
  trigger: number;
  /** 压缩后要落到这个量级以内。 */
  retain: number;
}

/** 正数（可为小数比例）。非法 → 回退默认。 */
function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * 从环境变量解析策略。`PAYASO_COMPACT_TRIGGER_TOKENS=0` 表示**关闭成本上限**
 * （退回旧的纯比例行为，供对照与回退用）。
 */
export function resolveCompactionPolicy(
  env: Record<string, string | undefined> = process.env,
): CompactionPolicy {
  const policy: CompactionPolicy = {
    triggerRatio: positiveNumber(
      env.PAYASO_COMPACT_TRIGGER_RATIO,
      DEFAULT_COMPACTION_POLICY.triggerRatio,
    ),
    retainRatio: positiveNumber(
      env.PAYASO_COMPACT_RETAIN_RATIO,
      DEFAULT_COMPACTION_POLICY.retainRatio,
    ),
  };
  const triggerRaw = env.PAYASO_COMPACT_TRIGGER_TOKENS?.trim();
  if (triggerRaw === '0') {
    // 显式关闭成本上限：纯比例（旧行为）。
  } else {
    policy.triggerTokens = positiveInt(
      triggerRaw,
      DEFAULT_COMPACTION_POLICY.triggerTokens ?? 160_000,
    );
  }
  const retainRaw = env.PAYASO_COMPACT_RETAIN_TOKENS?.trim();
  if (retainRaw !== undefined && retainRaw !== '') {
    policy.retainTokens = positiveInt(retainRaw, 0) || undefined;
  }
  return policy;
}

/**
 * 由策略与模型的实际输入预算算出触发线 / 保留量。
 *
 * 硬不变式：`retain < trigger`，且带宽 ≥ 触发线的一半。否则压缩刚结束就再次
 * 越线，每一轮都要花钱写摘要（"疯狂压缩"）——这是必须由公式保证、不能靠调参运气的事。
 */
export function resolveCompactionThresholds(
  policy: CompactionPolicy,
  maxInputTokens: number,
): CompactionThresholds {
  const byRatio = Math.floor(maxInputTokens * policy.triggerRatio);
  const trigger = Math.max(1, Math.min(byRatio, policy.triggerTokens ?? Number.POSITIVE_INFINITY));
  const retainByBand = Math.floor(trigger / 2);
  const unclamped =
    policy.retainTokens ?? Math.min(Math.floor(maxInputTokens * policy.retainRatio), retainByBand);
  const retain = Math.max(0, Math.min(unclamped, trigger - 1));
  return { trigger, retain };
}
