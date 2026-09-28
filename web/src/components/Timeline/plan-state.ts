// 计划清单的派生（纯函数，便于 node 测试）：
// 从事件流里折叠出"当前计划"，供 PlanPanel 渲染。与 context-gauge.ts 同风格——
// 组件只负责画，折叠逻辑可单独跑确定性测试。

import { translate } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
import type { HostEvent, PlanUpdateEvent } from '../../types';

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';

/**
 * 渲染用的项状态：比数据层多一个 `abandoned`。
 * Run 已结束但仍留在 in_progress 的项（模型忘了在收尾时更新计划）在视觉上
 * 不能继续显示「进行中」——那与「回复已经输出完」矛盾。见 derivePlan 的收尾折叠。
 */
export type PlanItemRenderStatus = PlanItemStatus | 'abandoned';

export interface PlanItemView {
  id: string;
  title: string;
  status: PlanItemStatus;
  /** 渲染状态：run 结束后未完成的 in_progress 项降级为 abandoned。 */
  renderStatus: PlanItemRenderStatus;
}

export interface PlanView {
  /** 当前清单的 revision（单调递增，权威序）。 */
  revision: number;
  items: PlanItemView[];
  completed: number;
  total: number;
  /** 全部完成（空计划不算完成——那种情况直接返回 null）。 */
  allDone: boolean;
  /** Run 已收尾且仍有未完成项（含被降级为 abandoned 的进行中项）。 */
  finishedIncomplete: boolean;
}

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed'];

function sanitizeItems(items: PlanUpdateEvent['items']): PlanItemView[] {
  if (!Array.isArray(items)) return [];
  const views: PlanItemView[] = [];
  for (const [index, raw] of items.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const title = typeof raw.title === 'string' ? raw.title : '';
    if (!title) continue;
    const status = STATUSES.includes(raw.status) ? (raw.status as PlanItemStatus) : 'pending';
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `t${index + 1}`;
    views.push({ id, title, status, renderStatus: status });
  }
  return views;
}

/** Run 已收尾的事件类型（任一个出现即认为本轮不再运行）。 */
const TERMINAL_EVENT_TYPES = new Set([
  'run_completed',
  'run_failed',
  'run_stopped',
  'run_interrupted',
  'plan_incomplete_at_finish',
]);

function isRunFinished(events: HostEvent[]): boolean {
  return events.some((event) => TERMINAL_EVENT_TYPES.has(event.type));
}

function toView(event: PlanUpdateEvent, finished: boolean): PlanView | null {
  const items = sanitizeItems(event.items);
  // 空清单 = 模型主动清空计划 → 面板不渲染（旧会话、清空后都零变化）。
  if (items.length === 0) return null;
  // 收尾折叠：Run 已结束但某项仍停在 in_progress（模型忘了在收尾时更新计划）——
  // 如实降级为 abandoned，不再显示「进行中」。pending 项保持 pending（它本来就
  // 没开始过，不存在"进行中"的误导）。
  if (finished) {
    for (const item of items) {
      if (item.status === 'in_progress') item.renderStatus = 'abandoned';
    }
  }
  const completed = items.filter((item) => item.status === 'completed').length;
  return {
    revision: event.revision,
    items,
    completed,
    total: items.length,
    allDone: completed === items.length,
    finishedIncomplete: finished && completed < items.length,
  };
}

/**
 * 取"当前计划"：`revision` 最大的一条 plan_update。
 *
 * 为什么不是"数组里最后一条"：SSE 重连回放与快照回放可能乱序或重复投递，
 * revision 才是权威序；按最大值取，重放/乱序/重复都幂等。
 * 没有任何计划事件（或计划已清空）→ null，调用方据此完全不渲染。
 */
export function derivePlan(events: HostEvent[]): PlanView | null {
  let latest: PlanUpdateEvent | null = null;
  for (const event of events) {
    if (event.type !== 'plan_update') continue;
    const candidate = event as PlanUpdateEvent;
    if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 0) continue;
    if (!latest || candidate.revision > latest.revision) latest = candidate;
  }
  return latest ? toView(latest, isRunFinished(events)) : null;
}

/** 时间线里的计划变更说明（挂在发生变更的那个 step 上）。 */
export interface PlanNote {
  step: number;
  text: string;
  kind: 'created' | 'progress' | 'done' | 'cleared';
}

const NOTE_TITLE_CHARS = 40;

function clipTitle(title: string): string {
  return title.length > NOTE_TITLE_CHARS ? `${title.slice(0, NOTE_TITLE_CHARS - 1)}…` : title;
}

/**
 * 计划变更 → 执行流里的弱化说明行。
 *
 * 为什么这样做"视觉呼应"而不是把工具调用和计划项连线：事件里**没有**计划项与工具调用的
 * 对应关系，任何自动连线都是猜测。我们能确定性知道的是"这一步之后计划变成了什么"，
 * 所以只在对应 step 上落一行说明 —— 宁缺勿错。
 *
 * 说明文案跟随语言（末位可选入参，默认中文；不传时输出与改造前一致）。
 */
export function derivePlanNotes(
  events: HostEvent[],
  language: LanguageMode = 'zh-CN',
): Map<number, PlanNote> {
  const updates: PlanUpdateEvent[] = [];
  for (const event of events) {
    if (event.type !== 'plan_update') continue;
    const candidate = event as PlanUpdateEvent;
    if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 0) continue;
    updates.push(candidate);
  }
  updates.sort((a, b) => a.revision - b.revision);

  const notes = new Map<number, PlanNote>();
  let previous: PlanItemView[] = [];
  for (const update of updates) {
    const items = sanitizeItems(update.items);
    const described = describeChange(previous, items, language);
    if (described) {
      const step = Number.isSafeInteger(update.step) ? update.step : 0;
      notes.set(step, { step, ...described });
    }
    previous = items;
  }
  return notes;
}

function describeChange(
  before: PlanItemView[],
  after: PlanItemView[],
  language: LanguageMode,
): { text: string; kind: PlanNote['kind'] } | null {
  if (before.length === 0 && after.length === 0) return null;
  if (before.length === 0) {
    return {
      text: translate(language, 'timeline.planNote.created', { count: after.length }),
      kind: 'created',
    };
  }
  if (after.length === 0) {
    return { text: translate(language, 'timeline.planNote.cleared'), kind: 'cleared' };
  }

  const beforeById = new Map(before.map((item) => [item.id, item]));
  const completed = after.filter(
    (item) => item.status === 'completed' && beforeById.get(item.id)?.status !== 'completed',
  );
  const started = after.find(
    (item) => item.status === 'in_progress' && beforeById.get(item.id)?.status !== 'in_progress',
  );
  const completedCount = after.filter((item) => item.status === 'completed').length;
  const allDone = completedCount === after.length;

  if (completed.length === 0 && !started) {
    return {
      text: translate(language, 'timeline.planNote.updated', {
        completed: completedCount,
        total: after.length,
      }),
      kind: 'progress',
    };
  }
  const parts: string[] = [];
  if (completed.length > 0) {
    parts.push(
      translate(language, 'timeline.planNote.completed', {
        titles: completed
          .map((item) => clipTitle(item.title))
          .join(translate(language, 'timeline.planNote.titleJoiner')),
      }),
    );
  }
  if (started) {
    parts.push(
      translate(language, 'timeline.planNote.started', { title: clipTitle(started.title) }),
    );
  }
  return {
    text: translate(language, 'timeline.planNote.summary', {
      parts: parts.join(' · '),
      completed: completedCount,
      total: after.length,
    }),
    kind: allDone ? 'done' : 'progress',
  };
}
