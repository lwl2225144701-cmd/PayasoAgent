// Module: Plan — Agent 自述的任务清单（Harness 层状态）。
//
// 为什么单独存在（而不是塞进 Scratchpad）：
//   Scratchpad 是"工具执行账本"——每次 tool_call 自动记一条行为信号，v1.10 已把它
//   瘦身成纯进度/防重复信号；Plan 是"给用户看的承诺清单"——模型自己声明要做什么、
//   做到哪。两者语义、更新时机与注入预算都不同，混在一起会让每轮 system 注入重新膨胀。
//
// 职责边界：
//   - 本模块是纯函数：状态、校验、归一化、两个方向的渲染（给模型的结果文本 /
//     注入 system 的有界投影）。不 IO、不发事件、不认识 trace。
//   - 事件由 Runtime 发（`plan_update`），持久化搭 `ContextHarnessState` 的车。
//
// 契约：
//   - 全量替换：模型每次提交完整清单，Harness 归一化后整份替换（不做增量 patch，
//     前端因此零合并逻辑，SSE 重连/快照回放天然收敛）。
//   - 超限一律抛错（不静默截断、不静默丢弃），错误文案带实际值与上限。
//   - 同一时刻至多一项 in_progress：多项时最后一项生效，其余回落 pending。

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanItem {
  id: string;
  title: string;
  status: PlanItemStatus;
}

export interface Plan {
  /** 每次真实变更 +1；前端据此对乱序/重放事件保持幂等。0 = 尚未提交过计划。 */
  revision: number;
  items: PlanItem[];
}

/** 模型传入的原始项（id 可省略，由 Harness 归一化）。 */
export interface PlanItemInput {
  id?: string;
  title: string;
  status: PlanItemStatus;
}

/** Harness 写入口的返回：changed=false 表示与当前计划等价，调用方不必发事件。 */
export interface PlanPortResult {
  changed: boolean;
  plan: Plan;
  /** 回给模型的文本（工具结果）。 */
  resultText: string;
}

/** Harness 暴露、Runtime 装饰后交给工具的写入口。 */
export interface PlanPort {
  apply(items: PlanItemInput[]): PlanPortResult;
}

export const PLAN_MAX_ITEMS = 12;
export const PLAN_MAX_TITLE_CHARS = 160;
/** 注入 system 的投影里单项标题的裁剪长度（比存储上限短，避免预算被单行吃掉）。 */
export const PLAN_VIEW_TITLE_CHARS = 80;

const STATUS_LABEL: Record<PlanItemStatus, string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✅',
};

const STATUS_ORDER: readonly PlanItemStatus[] = ['pending', 'in_progress', 'completed'];

export function createPlan(): Plan {
  return { revision: 0, items: [] };
}

export function isPlanEmpty(plan: Plan): boolean {
  return plan.items.length === 0;
}

export function countCompleted(plan: Plan): number {
  return plan.items.filter((item) => item.status === 'completed').length;
}

function isPlanItemStatus(value: unknown): value is PlanItemStatus {
  return typeof value === 'string' && (STATUS_ORDER as readonly string[]).includes(value);
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * 归一化模型提交的清单：裁剪标题、补齐/去重 id、收敛 in_progress。
 * 校验失败一律抛错（工具层把它变成模型可见的结构化错误）。
 */
function normalizeItems(items: PlanItemInput[]): PlanItem[] {
  if (!Array.isArray(items)) {
    throw new Error('Plan items must be an array.');
  }
  if (items.length > PLAN_MAX_ITEMS) {
    throw new Error(
      `Plan has ${items.length} items, above the limit of ${PLAN_MAX_ITEMS}. ` +
        `Merge related items and resubmit the full list.`,
    );
  }

  const usedIds = new Set<string>();
  const normalized: PlanItem[] = items.map((raw, index) => {
    const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
    if (!title) {
      throw new Error(`Plan item #${index + 1} is missing a title.`);
    }
    if (title.length > PLAN_MAX_TITLE_CHARS) {
      throw new Error(
        `Plan item #${index + 1} title is ${title.length} characters, ` +
          `above the limit of ${PLAN_MAX_TITLE_CHARS}. Shorten it and resubmit.`,
      );
    }
    if (!isPlanItemStatus(raw?.status)) {
      throw new Error(
        `Plan item #${index + 1} has invalid status "${String(raw?.status)}"; ` +
          `use one of: ${STATUS_ORDER.join(', ')}.`,
      );
    }
    const providedId = typeof raw.id === 'string' ? raw.id.trim() : '';
    let id = providedId || `t${index + 1}`;
    // 重复 id 会让前端 React key 冲突、也让"更新同一项"失去意义：确定性改名而不是丢弃。
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}#${suffix}`)) suffix += 1;
      id = `${id}#${suffix}`;
    }
    usedIds.add(id);
    return { id, title, status: raw.status };
  });

  // 至多一项进行中：保留最后一项，其余回落 pending（与工具描述里的说明一致）。
  const inProgress = normalized.filter((item) => item.status === 'in_progress');
  if (inProgress.length > 1) {
    const keep = inProgress[inProgress.length - 1].id;
    for (const item of normalized) {
      if (item.status === 'in_progress' && item.id !== keep) item.status = 'pending';
    }
  }
  return normalized;
}

function sameItems(a: PlanItem[], b: PlanItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return item.id === other.id && item.title === other.title && item.status === other.status;
  });
}

/**
 * 全量替换当前计划。内容与现状等价时返回原计划引用且 `changed=false`。
 * 校验失败抛错（调用方不改状态）。
 */
export function applyPlan(plan: Plan, items: PlanItemInput[]): PlanPortResult {
  const normalized = normalizeItems(items);
  if (sameItems(plan.items, normalized)) {
    return { changed: false, plan, resultText: renderPlanResult(plan) };
  }
  const next: Plan = { revision: plan.revision + 1, items: normalized };
  return { changed: true, plan: next, resultText: renderPlanResult(next) };
}

/** 回给模型的结果文本：只讲"现在是什么、下一步做什么"，不重复工具细节。 */
export function renderPlanResult(plan: Plan): string {
  if (isPlanEmpty(plan)) {
    return '[计划] 已清空（0 项）。本次 Run 不再有对外可见的任务清单。';
  }
  const completed = countCompleted(plan);
  const lines = plan.items.map(
    (item, index) =>
      `  ${index + 1}. ${STATUS_LABEL[item.status]} ${clip(item.title, PLAN_MAX_TITLE_CHARS)}`,
  );
  const active = plan.items.find((item) => item.status === 'in_progress');
  const tail = active
    ? `当前进行中：${clip(active.title, PLAN_MAX_TITLE_CHARS)}。完成后立即用 updatePlan 把它标为 completed。`
    : '当前没有进行中的项：开始下一项时用 updatePlan 标为 in_progress。';
  return [
    `[计划] ${completed}/${plan.items.length} 完成（revision ${plan.revision}）`,
    ...lines,
    tail,
  ].join('\n');
}

/**
 * 注入 system 的有界投影（与 scratchpad 投影并列）：只保留清单与进度。
 * 真正的 token 上限由 Harness 的 truncateToTokens 强制；这里先做廉价的项/标题裁剪。
 */
export function renderBoundedPlanView(plan: Plan): { text: string; truncated: boolean } {
  if (isPlanEmpty(plan)) return { text: '', truncated: false };
  const kept = plan.items.slice(0, PLAN_MAX_ITEMS);
  const omitted = plan.items.length - kept.length;
  let truncated = omitted > 0;
  const lines = kept.map((item, index) => {
    if (item.title.length > PLAN_VIEW_TITLE_CHARS) truncated = true;
    return `  ${index + 1}. ${STATUS_LABEL[item.status]} ${clip(item.title, PLAN_VIEW_TITLE_CHARS)}`;
  });
  const header =
    `[当前计划] ${countCompleted(plan)}/${plan.items.length} 完成（revision ${plan.revision}）` +
    (omitted > 0 ? `，另有 ${omitted} 项未列出` : '');
  return {
    text: [
      header,
      ...lines,
      '维护要求：完成一项后立即用 updatePlan 提交更新后的完整清单（用户在看这份进度）。',
    ].join('\n'),
    truncated,
  };
}

/**
 * 旧数据容错：checkpoint 里的 plan 可能缺失、字段非法或被外部改坏。
 * 任何无法解析的内容都退化为"没有计划"，绝不阻断 Run 恢复。
 */
export function normalizePlan(value: unknown): Plan {
  if (!value || typeof value !== 'object') return createPlan();
  const candidate = value as { revision?: unknown; items?: unknown };
  const revision =
    Number.isSafeInteger(candidate.revision) && (candidate.revision as number) >= 0
      ? (candidate.revision as number)
      : 0;
  if (!Array.isArray(candidate.items)) return createPlan();
  const items: PlanItem[] = [];
  for (const [index, raw] of candidate.items.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { id?: unknown; title?: unknown; status?: unknown };
    const title = typeof item.title === 'string' ? item.title.slice(0, PLAN_MAX_TITLE_CHARS) : '';
    if (!title || !isPlanItemStatus(item.status)) continue;
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `t${index + 1}`;
    items.push({ id, title, status: item.status });
  }
  return { revision, items: items.slice(0, PLAN_MAX_ITEMS) };
}

/** 收尾审计报告：Run 结束（final_answer）时计划的实际状态。不阻断收尾，只留痕。 */
export interface PlanReport {
  revision: number;
  total: number;
  completed: number;
  /** 仍处于 pending / in_progress 的项（标题已裁剪，够写进事件即可）。 */
  unfinished: Array<{ id: string; title: string; status: PlanItemStatus }>;
}

export function buildPlanReport(plan: Plan): PlanReport {
  return {
    revision: plan.revision,
    total: plan.items.length,
    completed: countCompleted(plan),
    unfinished: plan.items
      .filter((item) => item.status !== 'completed')
      .map((item) => ({
        id: item.id,
        title: clip(item.title, PLAN_VIEW_TITLE_CHARS),
        status: item.status,
      })),
  };
}
