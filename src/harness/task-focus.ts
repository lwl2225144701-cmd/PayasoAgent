// 模块: 用户请求与读取观察。仅提供上下文，不分类任务、不替模型选择工作流。
import { type EvidenceViewRead, isWorkspaceRelativePath } from '../execution-evidence.js';
import type { ChatMessage } from '../llm/llm.js';

export interface TaskFocus {
  goal: string;
  previousRequests: string[];
  workspaceRoot: string;
  reads: EvidenceViewRead[];
}

export function normalizeTaskFocus(value: unknown): TaskFocus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<TaskFocus>;
  if (typeof raw.goal !== 'string' || !raw.goal.trim() || raw.goal.length > 8000) return undefined;
  return {
    goal: raw.goal,
    previousRequests: Array.isArray(raw.previousRequests)
      ? raw.previousRequests
          .filter((request): request is string => typeof request === 'string' && !!request.trim())
          .slice(-4)
          .map((request) => request.slice(0, 8000))
      : [],
    workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : '',
    reads: Array.isArray(raw.reads)
      ? raw.reads
          .filter(
            (read) =>
              read &&
              typeof read.path === 'string' &&
              isWorkspaceRelativePath(read.path) &&
              typeof read.version === 'string' &&
              (read.versionKind === 'content' || read.versionKind === 'stat') &&
              Array.isArray(read.returnedRanges),
          )
          .slice(-16)
          .map((read) => ({
            ...read,
            returnedRanges: read.returnedRanges
              .filter(
                (r) =>
                  r &&
                  Number.isSafeInteger(r.startLine) &&
                  Number.isSafeInteger(r.endLine) &&
                  r.startLine > 0 &&
                  r.endLine >= r.startLine,
              )
              .slice(0, 64),
          }))
      : [],
  };
}

export function resolveTaskFocus(
  task: string,
  previous: TaskFocus | undefined,
  history: readonly ChatMessage[],
  workspaceRoot: string,
): TaskFocus {
  const sameWorkspace = previous?.workspaceRoot === workspaceRoot;
  const historyRequests = history
    .filter(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        !message.content.startsWith('[Context]'),
    )
    .map((message) => message.content);
  // 优先使用每轮实际传入的请求；canonical 历史的 user-role 还可能含恢复提示。
  const requests =
    sameWorkspace && previous ? [...previous.previousRequests, previous.goal] : historyRequests;
  return {
    goal: task.slice(0, 8000),
    previousRequests: requests
      .filter((request, index) => index === 0 || request !== requests[index - 1])
      .slice(-4)
      .map((request) => request.slice(0, 8000)),
    workspaceRoot,
    reads:
      sameWorkspace && previous ? previous.reads : previous ? [] : historicalReadCoverage(history),
  };
}

/** 旧 checkpoint 没有观察账本时，只恢复“曾读过哪些行”；版本未知，不能复用检查。 */
function historicalReadCoverage(history: readonly ChatMessage[]): EvidenceViewRead[] {
  const calls = new Map<string, string>();
  const paths = new Map<string, EvidenceViewRead>();
  for (const message of history) {
    for (const call of message.tool_calls ?? []) {
      if (call.function.name !== 'read' && call.function.name !== 'readFile') continue;
      try {
        const args = JSON.parse(call.function.arguments);
        if (typeof args.path === 'string' && isWorkspaceRelativePath(args.path))
          calls.set(call.id, args.path);
      } catch {
        /* 旧记录不合法时保留未知。 */
      }
    }
    if (message.role !== 'tool' || !message.tool_call_id || typeof message.content !== 'string')
      continue;
    const path = calls.get(message.tool_call_id);
    if (!path) continue;
    const lines = [...message.content.slice(0, 32768).matchAll(/^\s*(\d+)→/gm)].map((m) =>
      Number(m[1]),
    );
    if (!lines.length) continue;
    const existing = paths.get(path) ?? {
      path,
      versionKind: 'content',
      version: 'unknown',
      returnedRanges: [],
      complete: false,
    };
    existing.returnedRanges.push({ startLine: Math.min(...lines), endLine: Math.max(...lines) });
    existing.returnedRanges = existing.returnedRanges.slice(-8);
    paths.delete(path);
    paths.set(path, existing);
  }
  return [...paths.values()].slice(-16);
}

export function renderTaskFocus(focus: TaskFocus): string {
  const bounded = (text: string, size: number): string =>
    text.length <= size
      ? text
      : `${text.slice(0, Math.floor(size / 2))} … ${text.slice(-Math.floor(size / 2))}`;
  return (
    `[User request context]\nLatest request (bounded): ${bounded(focus.goal, 650)}\n` +
    (focus.previousRequests.length
      ? `Earlier user requests (chronological, bounded):\n${focus.previousRequests.map((request) => `- ${bounded(request, 180)}`).join('\n')}\n`
      : '') +
    'Earlier requests provide context; follow the latest request, including changes of scope.\n'
  );
}
