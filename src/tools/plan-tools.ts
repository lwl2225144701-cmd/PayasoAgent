// 模块: 计划工具 —— 模型自述任务清单的写入口（薄适配层）。
//
// 分层：计划的状态、校验、归一化与渲染都在 Harness（`src/harness/plan.ts`）；
// `plan_update` 事件由 Runtime 在端口返回 changed=true 时发出。本文件只做参数
// 转交与 fail-closed，不含任何计划语义——这样换 Harness 实现即换行为。

import type { PlanItemInput, PlanItemStatus } from '../harness/plan.js';
import { register } from './tools.js';

register({
  name: 'updatePlan',
  description:
    '提交本次任务的完整清单（全量替换，不是增量）。计划是可选能力：按需使用，阶段完成、方向变化、' +
    '阻塞或交付时更新（可合并）。status 取值：pending=待办，in_progress=进行中（同时最多一项），' +
    'completed=已完成。清空计划传 {"items":[]}。参数示例：' +
    '{"items":[{"title":"补充回归测试","status":"in_progress"}]}。条目标题字段为 title。',
  effect: 'idempotent',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: '本次提交的完整清单（全量替换当前计划）；清空计划传 []',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: '可选：沿用上一次的 id 可稳定更新同一项（省略时按顺序自动编号）',
            },
            title: { type: 'string', description: '写给用户看的任务标题' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: '任务状态',
            },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['items'],
  },
  execute: async (args, context) => {
    const port = context.planPort;
    if (!port) {
      // fail-closed：脱离 Agent Runtime（无 Harness）时不允许"假装成功"。
      throw new Error('updatePlan 需要 Agent Runtime 提供的计划端口，当前调用没有 Harness 支持。');
    }
    const raw = Array.isArray(args.items) ? args.items : [];
    const items: PlanItemInput[] = raw.map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : undefined;
      return {
        ...(id ? { id } : {}),
        title: typeof record.title === 'string' ? record.title : '',
        status: record.status as PlanItemStatus,
      };
    });
    return port.apply(items);
  },
});
