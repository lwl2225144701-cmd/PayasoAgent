// Token 计量约定（与 pi-ai / DSH 对齐的 DISJOINT 桶语义）：
//   inputTokens = 未缓存输入；cache 命中/写入单独计桶；reasoningTokens ⊆ outputTokens。
// 归一化层只做防御性校验与映射（pi-ai 适配器已处理 provider 语义，如 DeepSeek
// prompt_tokens 含 cache 命中 → 已减出为 input），纯函数、无副作用，host/web 复用。

export interface TokenUsage {
  /** 未缓存输入（prompt 扣除 cache 命中/写入后）。 */
  inputTokens: number;
  outputTokens: number;
  /** 全调用精确总数（prompt + output + cache 流量）；与分桶自洽才携带。 */
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** 输出子集（推理 token），仅当 provider 上报时携带。 */
  reasoningTokens?: number;
}

/** pi-ai 归一化后的 Usage 形状（运行时可能缺字段，全部按可选防御）。 */
interface PiUsageLike {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readCount(value: unknown): number | undefined {
  return isCount(value) ? value : undefined;
}

/** prompt 侧全部流量（未缓存输入 + cache 命中 + cache 写入）——计费/压力口径。 */
export function promptSideTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/**
 * 归一化一次模型调用的用量（Adapter 模式：外部 wire 表示 → 内部 DISJOINT 约定）。
 * 入口接受 unknown —— 第三方兼容端点返回的 usage 结构不可信，边界处全量防御。
 * 宁缺勿错：任一桶不是非负安全整数、reasoning 超过 output、或 totalTokens 与
 * 分桶之和矛盾时整体拒绝（返回 undefined），调用方降级为估算/不展示。
 */
export function normalizeTokenUsage(raw: unknown): TokenUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const usage = raw as PiUsageLike;
  const input = readCount(usage.input);
  const output = readCount(usage.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = readCount(usage.cacheRead) ?? 0;
  const cacheWrite = readCount(usage.cacheWrite) ?? 0;
  if (!isCount(cacheRead) || !isCount(cacheWrite)) return undefined;
  const reasoning = readCount(usage.reasoning);
  if (reasoning !== undefined && reasoning > output) return undefined;

  const knownPrompt = input + cacheRead + cacheWrite;
  let totalTokens: number | undefined;
  const reportedTotal = readCount(usage.totalTokens);
  if (reportedTotal !== undefined) {
    // 分桶之和不可能超过总数；违反即自相矛盾。
    if (reportedTotal < knownPrompt + output) return undefined;
    totalTokens = reportedTotal;
  } else {
    totalTokens = knownPrompt + output;
  }

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * 校验一次已归一化的 TokenUsage 是否可安全用于展示/累加。
 * 与 normalizeTokenUsage 的校验规则同构，供持久化事件（旧记录可能残缺）复用。
 */
export function isValidTokenUsage(usage: TokenUsage | undefined): usage is TokenUsage {
  if (usage === undefined) return false;
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return false;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (!isCount(cacheRead) || !isCount(cacheWrite)) return false;
  const reasoning = usage.reasoningTokens;
  if (reasoning !== undefined && (!isCount(reasoning) || reasoning > usage.outputTokens)) {
    return false;
  }
  if (usage.totalTokens !== undefined) {
    if (!isCount(usage.totalTokens)) return false;
    if (usage.totalTokens < usage.inputTokens + cacheRead + cacheWrite + usage.outputTokens) {
      return false;
    }
  }
  return true;
}
