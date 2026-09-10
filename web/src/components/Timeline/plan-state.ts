// 计划清单的派生（纯函数，便于 node 测试）：
// 从事件流里折叠出"当前计划"，供 PlanPanel 渲染。与 context-gauge.ts 同风格——
// 组件只负责画，折叠逻辑可单独跑确定性测试。

import type { HostEvent, PlanUpdateEvent } from '../../types';

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanItemView {
  id: string;
  title: string;
  status: PlanItemStatus;
}

export interface PlanView {
  /** 当前清单的 revision（单调递增，权威序）。 */
  revision: number;
  items: PlanItemView[];
  completed: number;
  total: number;
  /** 全部完成（空计划不算完成——那种情况直接返回 null）。 */
  allDone: boolean;
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
    views.push({ id, title, status });
  }
  return views;
}

function toView(event: PlanUpdateEvent): PlanView | null {
  const items = sanitizeItems(event.items);
  // 空清单 = 模型主动清空计划 → 面板不渲染（旧会话、清空后都零变化）。
  if (items.length === 0) return null;
  const completed = items.filter((item) => item.status === 'completed').length;
  return {
    revision: event.revision,
    items,
    completed,
    total: items.length,
    allDone: completed === items.length,
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
  return latest ? toView(latest) : null;
}
