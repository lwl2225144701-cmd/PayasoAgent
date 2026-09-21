// 任务交付投影：只从实际 Trace 提取依据；文件现状由 Host 校验，不把结束当作验证通过。
import fs from 'node:fs';
import path from 'node:path';
import { assertInsideRoot, resolveWorkspacePath } from '../sandbox/sandbox-manager.js';
import type { HostEvent } from './run-events.js';
import { deriveRunStats } from './run-stats.js';

export interface DeliveryFile {
  name: string;
  source: 'tool' | 'reported';
  status: 'available' | 'changed' | 'unavailable';
  size?: number;
}
export interface RunDelivery {
  files: DeliveryFile[];
  checks: Array<{ command: string; step: number; status: 'passed' | 'failed' | 'unknown' }>;
  unfinished: string[];
  diagnostics: Array<{
    kind: 'repeatRead' | 'repeatFailure' | 'slow';
    tool: string;
    step: number;
    durationMs?: number;
  }>;
  stats: ReturnType<typeof deriveRunStats>;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return JSON.stringify(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  return JSON.stringify(value) ?? '';
}

/** Trace 的 step 是事件序号；当前 Runtime 顺序执行，结果关联最近尚未结束的同名调用。 */
export function deriveRunDelivery(events: HostEvent[], finalText = ''): RunDelivery {
  const result: RunDelivery = {
    files: [],
    checks: [],
    unfinished: [],
    diagnostics: [],
    stats: deriveRunStats(events),
  };
  const calls = new Map<string, Extract<HostEvent, { type: 'tool_call' }>>();
  const reads = new Set<string>();
  const failures = new Set<string>();
  const files = new Map<string, DeliveryFile>();
  const checks = new Map<number, RunDelivery['checks'][number]>();
  const jobs = new Map<string, RunDelivery['checks'][number]>();
  for (const event of events) {
    if (event.type === 'plan_update')
      result.unfinished = event.items.filter((i) => i.status !== 'completed').map((i) => i.title);
    if (event.type === 'final_answer') finalText = event.content;
    if (event.type === 'tool_call') {
      calls.set(event.tool, event);
      const args = event.args as { command?: unknown } | null;
      if (
        event.tool === 'shell' &&
        typeof args?.command === 'string' &&
        /\b(test|pytest|vitest|jest|tsc|lint|check|build)\b/i.test(args.command)
      ) {
        const check: RunDelivery['checks'][number] = {
          command: args.command,
          step: event.step,
          status: 'unknown',
        };
        checks.set(event.step, check);
        result.checks.push(check);
      }
      continue;
    }
    if (event.type !== 'tool_result' && event.type !== 'tool_error') continue;
    const call = calls.get(event.tool);
    if (!call) continue;
    if (event.type === 'tool_result' || event.exhausted) calls.delete(event.tool);
    const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<
      string,
      unknown
    >;
    const key = `${call.tool}:${stable(args)}`;
    const text = event.type === 'tool_result' ? event.result : '';
    const shellBody = call.tool === 'shellJob' ? text.replace(/^\[[^\n]+\]\n/, '') : text;
    const exit = shellBody.match(/^\[shell-exit-(-?\d+)\]/);
    const failed =
      event.type === 'tool_error' ||
      (exit && exit[1] !== '0') ||
      shellBody.startsWith('[shell-timeout]');
    if (!['read', 'ls', 'grep', 'glob', 'updatePlan', 'calculator'].includes(call.tool))
      reads.clear();
    if (failed) {
      if (failures.has(key))
        result.diagnostics.push({ kind: 'repeatFailure', tool: call.tool, step: call.step });
      failures.add(key);
    } else failures.delete(key);
    if (event.type === 'tool_result') {
      if (event.durationMs >= 5000)
        result.diagnostics.push({
          kind: 'slow',
          tool: call.tool,
          step: call.step,
          durationMs: event.durationMs,
        });
      if (call.tool === 'read') {
        if (reads.has(key))
          result.diagnostics.push({ kind: 'repeatRead', tool: call.tool, step: call.step });
        reads.add(key);
      }
      if (['write', 'edit'].includes(call.tool) && typeof args.path === 'string')
        files.set(args.path, { name: args.path, source: 'tool', status: 'unavailable' });
    }
    const check = checks.get(call.step);
    if (check && (event.type === 'tool_result' || event.exhausted)) {
      check.status = failed ? 'failed' : exit?.[1] === '0' ? 'passed' : 'unknown';
      const job = text.match(/^\[shell-background\] jobId=(\S+)/)?.[1];
      if (job) jobs.set(job, check);
    }
    if (call.tool === 'shellJob' && typeof args.jobId === 'string') {
      const check = jobs.get(args.jobId);
      if (check && (exit || shellBody.startsWith('[shell-timeout]')))
        check.status = failed ? 'failed' : 'passed';
    }
  }
  // Shell 产物沿用最终回复中的 Markdown 文件链接；明确标为 Agent 报告，不能伪装成写入证据。
  for (const match of finalText.matchAll(/\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))\)/g)) {
    let name: string;
    try {
      name = decodeURIComponent(match[1] ?? match[2]);
    } catch {
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(name) || !path.extname(name)) continue;
    if (!files.has(name)) files.set(name, { name, source: 'reported', status: 'unavailable' });
  }
  result.files = [...files.values()];
  return result;
}

/** 不扫全工作区、不读文件正文；只校验已知交付路径，并提示结束后修改的当前版本。 */
export function inspectRunDelivery(
  events: HostEvent[],
  root: string | null,
  finishedAt: string,
  finalText = '',
): RunDelivery {
  const result = deriveRunDelivery(events, finalText);
  const unique = new Map<string, DeliveryFile>();
  for (const file of result.files) {
    try {
      if (!root) continue;
      const relative = path.isAbsolute(file.name) ? path.relative(root, file.name) : file.name;
      const absolute = resolveWorkspacePath(root, relative);
      file.name = path.relative(root, absolute).split(path.sep).join('/');
      // 即使文件已删除也保留路径；越界和链接逃逸不暴露到交付列表。
      assertInsideRoot(root, absolute);
      if (unique.get(file.name)?.source === 'tool') continue;
      unique.set(file.name, file);
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) continue;
      file.size = stat.size;
      file.status = stat.mtimeMs > Date.parse(finishedAt) ? 'changed' : 'available';
    } catch {
      /* 不可读的已知路径保留 unavailable，不返回宿主错误详情 */
    }
  }
  result.files = [...unique.values()];
  return result;
}
