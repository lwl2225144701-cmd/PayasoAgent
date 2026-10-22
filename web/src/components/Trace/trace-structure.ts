// 模块: Trace 数据聚合 —— 单条 Run 的事件流 → 轨迹调用列表的纯函数层
// 职责边界：与 Timeline/timeline-structure.ts 同 pattern——纯函数与组件分离，
//   便于 node 测试；本文件不含任何 React/DOM 依赖。
//
// 诚实性约定（与需求一致）：
//   - 模型调用耗时只在「llm_call_started → llm_call」两端时间戳都在场时才计算，
//     缺开始端（旧历史 Run 没有 llm_call_started 事件）如实标记未记录；
//   - 工具调用耗时优先用 tool_result.durationMs（Host 实测），tool_error 用两端
//     事件时间戳之差（两端都有记录）；两者都拿不到就是未记录；
//   - 绝不用「Run 总耗时 − 工具耗时」倒推模型耗时。

import type { MessageKey } from '../../i18n/messages';
import type {
  HostEvent,
  HostRun,
  LlmCallEvent,
  TokenUsage,
  ToolCallEvent,
  ToolErrorEvent,
  ToolResultEvent,
  TraceImage,
} from '../../types';

export type TraceCallStatus = 'running' | 'completed' | 'failed' | 'interrupted';

/** 轨迹里的模型调用（一次 LLM 请求 = started → deltas → llm_call 完整周期） */
export interface TraceModelCall {
  kind: 'model';
  key: string;
  iteration?: number;
  purpose?: LlmCallEvent['purpose'];
  status: TraceCallStatus;
  /** llm_call_started 时间戳；旧历史 Run 可能缺失 → 耗时未记录 */
  startedAt?: string;
  /** llm_call 事件时间戳（调用完成时刻） */
  endedAt?: string;
  durationMs?: number;
  /** false = 没有记录依据，界面必须显示「未记录」而不是 0 或推算值 */
  durationRecorded: boolean;
  /** assistant_delta 流式增量合并后的全文（同一次调用只渲染一个块，不逐 token 成行） */
  streamedText: string;
  /** reasoning_delta 合并后的思考文本 */
  reasoningText: string;
  usage?: TokenUsage;
  messageCount?: number;
  stopReason?: LlmCallEvent['stopReason'];
  /** 传输层失败记录（llm_transport phase=failed），失败原因可见 */
  transportError?: string;
}

/** 轨迹里的工具调用 */
export interface TraceToolCall {
  kind: 'tool';
  key: string;
  tool: string;
  args?: unknown;
  status: TraceCallStatus;
  startedAt: string;
  durationMs?: number;
  durationRecorded: boolean;
  result?: string;
  error?: string;
  /** 工具产出的图片（工作区相对路径，需配合 runId 拼访问地址） */
  images?: TraceImage[];
  /** v2.4 前台 shell 实时输出预览（shell_output_delta 累积；仅运行中可见） */
  liveOutput?: string;
  /** tool_execution_skipped 的原因码（如 budget_exhausted）：工具未执行即被拦下 */
  skippedReason?: string;
}

export type TraceCall = TraceModelCall | TraceToolCall;

export interface TraceRunView {
  calls: TraceCall[];
  modelCallCount: number;
  toolCallCount: number;
  failedCallCount: number;
  /** Run 起点时间戳（run_started 事件优先，回退 run.createdAt） */
  runStartedAt: string;
  /** 终态错误（run_failed / run_interrupted / error 事件，取最后一条） */
  terminalError?: string;
}

/** 单条调用的紧凑时间数据：供跨 Run 时间轴与搜索空态判断 */
export interface TraceCallTiming {
  kind: 'model' | 'tool';
  key: string;
  /** 开始时间戳（ms）；模型调用缺 started 时回退 endedAt，再缺为 null（不画/不推测） */
  ts: number | null;
  /** 有记录依据的耗时；未记录为 null */
  durationMs: number | null;
  durationRecorded: boolean;
  status: TraceCallStatus;
  /** 工具调用名（模型调用为空，时间轴 tooltip 用泳道名） */
  label: string;
  /** 是否命中当前搜索词（空搜索 = 全部命中） */
  matched: boolean;
}

/** 单条 Run 的紧凑摘要：由 TraceRunGroup 上报给 TraceView 汇总 */
export interface TraceRunSummary {
  runId: string;
  status: HostRun['status'];
  task: string;
  /** Run 起点时间戳（ms）；无记录为 null */
  runStartedAt: number | null;
  modelCallCount: number;
  toolCallCount: number;
  calls: TraceCallTiming[];
  terminalError?: string;
  /** 用户任务文本是否命中搜索词（空搜索 = true） */
  taskMatched: boolean;
}

const STOP_REASON_KEYS: Record<string, MessageKey> = {
  budget_exhausted: 'timeline.execution.stopReason.budget_exhausted',
  policy_denied: 'timeline.execution.stopReason.policy_denied',
  tool_unavailable: 'timeline.execution.stopReason.tool_unavailable',
  outcome_uncertain: 'timeline.execution.stopReason.outcome_uncertain',
  user_cancelled: 'timeline.execution.stopReason.user_cancelled',
};

/** skippedReason / 错误码 → 已知文案 key；未知码返回 null（调用方显示原文） */
export function stopReasonKey(reason: string): MessageKey | null {
  return STOP_REASON_KEYS[reason] ?? null;
}

function computeDurationMs(startedAt: string, endedAt: string): number {
  const s = new Date(startedAt).getTime();
  const e = new Date(endedAt).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
  return Math.max(0, e - s);
}

function isTerminalStatus(status: HostRun['status']): boolean {
  return status !== 'running' && status !== 'stopping';
}

/**
 * 把一条 Run 的事件流按执行顺序展开成「模型调用 + 工具调用」列表。
 *
 * 事件顺序即执行顺序（SSE / 快照都按 seq 升序），所以单趟扫描即可：
 *   llm_call_started 开启一个模型调用 → assistant/reasoning delta 归入当前
 *   running 的调用（合并文本）→ llm_call 落定（含 usage / stopReason）；
 *   tool_call 开启工具调用 → tool_result / tool_error / tool_result_invalid 落定。
 */
export function buildTraceRun(run: HostRun, events: HostEvent[]): TraceRunView {
  const calls: TraceCall[] = [];
  let seq = 0;
  let model: TraceModelCall | null = null;
  let terminalError: string | undefined;

  // 开启一个新的模型调用（llm_call_started 到达；startedAt 有记录）
  const openModel = (startedAt?: string): TraceModelCall => {
    const call: TraceModelCall = {
      kind: 'model',
      key: `model-${++seq}`,
      status: 'running',
      ...(startedAt !== undefined
        ? { startedAt, durationRecorded: true }
        : { durationRecorded: false }),
      streamedText: '',
      reasoningText: '',
    };
    model = call;
    calls.push(call);
    return call;
  };

  // delta / 迟到的 llm_call 归属：当前 running 的模型调用；没有就隐式开一个。
  // 隐式开启【不】带 startedAt —— 没有开始时间戳就没有记录依据，耗时必须显示未记录。
  const runningModel = (): TraceModelCall => {
    if (model && model.status === 'running') return model;
    return openModel();
  };

  const lastRunningTool = (tool?: string): TraceToolCall | undefined => {
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i];
      if (call.kind !== 'tool' || call.status !== 'running') continue;
      if (!tool || call.tool === tool) return call;
    }
    return undefined;
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'llm_call_started': {
        const call = openModel(ev.timestamp);
        call.iteration = ev.iteration;
        continue;
      }
      case 'assistant_delta': {
        runningModel().streamedText += ev.delta;
        continue;
      }
      case 'reasoning_delta': {
        runningModel().reasoningText += ev.delta;
        continue;
      }
      case 'llm_transport': {
        // 不直接读闭包里的 model 变量：TS 无法追踪闭包内赋值，会把它窄化成 never。
        if (ev.phase === 'failed' && ev.reason) {
          for (let i = calls.length - 1; i >= 0; i--) {
            const prev = calls[i];
            if (prev.kind !== 'model') continue;
            if (prev.status !== 'running') break;
            prev.transportError = ev.reason;
            break;
          }
        }
        continue;
      }
      case 'llm_call': {
        // llm_call 到达但没有 started（旧历史 Run）→ 隐式开启，耗时未记录
        const target = runningModel();
        target.status = 'completed';
        target.endedAt = ev.timestamp;
        if (target.startedAt) {
          target.durationMs = computeDurationMs(target.startedAt, ev.timestamp);
          target.durationRecorded = true;
        } else {
          target.durationRecorded = false;
        }
        target.purpose = ev.purpose;
        target.usage = ev.usage;
        target.messageCount = ev.messageCount;
        target.stopReason = ev.stopReason;
        continue;
      }
      case 'tool_call': {
        const call = ev as ToolCallEvent;
        calls.push({
          kind: 'tool',
          key: `tool-${++seq}`,
          tool: call.tool,
          args: call.args,
          status: 'running',
          startedAt: call.timestamp,
          durationRecorded: false,
        });
        continue;
      }
      case 'tool_result': {
        const res = ev as ToolResultEvent;
        const target = lastRunningTool(res.tool);
        if (!target) continue;
        target.status = 'completed';
        target.result = res.result;
        if (res.images && res.images.length > 0) target.images = res.images;
        // Host 实测耗时优先；缺失时两端事件时间戳之差同样有记录依据
        target.durationMs =
          res.durationMs != null
            ? res.durationMs
            : computeDurationMs(target.startedAt, res.timestamp);
        target.durationRecorded = true;
        continue;
      }
      case 'tool_result_invalid': {
        // 工具已执行但返回结构无效：结果保留，错误原因并列展示
        const target = lastRunningTool(ev.tool);
        if (!target) continue;
        target.status = 'completed';
        target.error = ev.reason;
        continue;
      }
      case 'tool_call_invalid': {
        // 模型生成的调用未通过校验，工具未执行：结构化错误码即错误信息
        calls.push({
          kind: 'tool',
          key: `tool-${++seq}`,
          tool: ev.tool,
          status: 'failed',
          startedAt: ev.timestamp,
          durationRecorded: false,
          error: ev.code,
        });
        continue;
      }
      case 'tool_error': {
        const err = ev as ToolErrorEvent;
        const target = lastRunningTool(err.tool);
        if (!target) continue;
        target.status = 'failed';
        target.error = err.error;
        target.durationMs = computeDurationMs(target.startedAt, err.timestamp);
        target.durationRecorded = true;
        continue;
      }
      case 'tool_execution_skipped': {
        // 预算准入拦截：调用未执行（无副作用），如实以失败语义展示并标注原因码
        calls.push({
          kind: 'tool',
          key: `tool-${++seq}`,
          tool: ev.tool,
          status: 'failed',
          startedAt: ev.timestamp,
          durationRecorded: false,
          skippedReason: ev.reason,
        });
        continue;
      }
      case 'shell_output_delta': {
        const target = lastRunningTool();
        if (target) target.liveOutput = (target.liveOutput ?? '') + ev.delta;
        continue;
      }
      case 'run_failed':
      case 'run_interrupted': {
        if ('error' in ev && typeof ev.error === 'string' && ev.error.trim()) {
          terminalError = ev.error.trim();
        }
        continue;
      }
      case 'error': {
        if (ev.message.trim()) terminalError = ev.message.trim();
        continue;
      }
      default:
        continue;
    }
  }

  // Run 已终态但调用仍挂着 running → 没有结果也没有错误，如实标「已中断」。
  // （不伪造 completed：没有 tool_result 就没有结果可展示。）
  if (isTerminalStatus(run.status)) {
    for (const call of calls) {
      if (call.status === 'running') call.status = 'interrupted';
    }
  }

  const modelCallCount = calls.filter((c) => c.kind === 'model').length;
  const toolCallCount = calls.filter((c) => c.kind === 'tool').length;
  const failedCallCount = calls.filter((c) => c.status === 'failed').length;

  const runStarted = events.find((e) => e.type === 'run_started')?.timestamp ?? run.createdAt;

  return {
    calls,
    modelCallCount,
    toolCallCount,
    failedCallCount,
    runStartedAt: runStarted,
    ...(terminalError ? { terminalError } : {}),
  };
}

function parseTs(ts: string | undefined): number | null {
  if (ts === undefined) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** 参数序列化为可搜索文本（有界，避免超大参数拖慢搜索） */
function argsSearchText(args: unknown): string {
  if (args == null) return '';
  try {
    const s = JSON.stringify(args);
    return s.length > 2000 ? s.slice(0, 2000) : s;
  } catch {
    return String(args);
  }
}

/**
 * 调用是否命中搜索词（大小写不敏感）：
 *   工具调用 → 工具名 / 参数 / 实时输出 / 结果 / 错误；
 *   模型调用 → 流式输出 / 思考文本 / 传输错误。
 */
export function callMatchesSearch(call: TraceCall, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const haystacks: string[] = [];
  if (call.kind === 'tool') {
    haystacks.push(
      call.tool,
      argsSearchText(call.args),
      call.liveOutput ?? '',
      call.result ?? '',
      call.error ?? '',
    );
  } else {
    haystacks.push(call.streamedText, call.reasoningText, call.transportError ?? '');
  }
  return haystacks.some((s) => s.toLowerCase().includes(q));
}

/**
 * 从 TraceRunView 派生紧凑摘要（时间轴 + 搜索空态判断的数据源）。
 * 与耗时规则一致：只携带有记录依据的时间戳与耗时，缺失为 null，不推测。
 */
export function buildTraceRunSummary(
  run: HostRun,
  view: TraceRunView,
  search: string,
): TraceRunSummary {
  const calls: TraceCallTiming[] = view.calls.map((call) => {
    const ts =
      call.kind === 'model'
        ? (parseTs(call.startedAt) ?? parseTs(call.endedAt))
        : parseTs(call.startedAt);
    const durationRecorded = call.durationRecorded && typeof call.durationMs === 'number';
    return {
      kind: call.kind,
      key: call.key,
      ts,
      durationMs: durationRecorded ? (call.durationMs as number) : null,
      durationRecorded,
      status: call.status,
      label: call.kind === 'tool' ? call.tool : '',
      matched: callMatchesSearch(call, search),
    };
  });
  const q = search.trim().toLowerCase();
  return {
    runId: run.runId,
    status: run.status,
    task: run.task,
    runStartedAt: parseTs(view.runStartedAt),
    modelCallCount: view.modelCallCount,
    toolCallCount: view.toolCallCount,
    calls,
    ...(view.terminalError ? { terminalError: view.terminalError } : {}),
    taskMatched: !q || run.task.toLowerCase().includes(q),
  };
}

/** 时间轴上的一个刻度（跨 Run 三泳道：输入 / 模型 / 工具） */
export interface TraceTimelineTick {
  kind: 'input' | 'model' | 'tool';
  key: string;
  /** 开始时间戳（ms）；无记录依据的不产出刻度，不推测 */
  ts: number;
  /** 有记录依据的耗时；未记录为 null（刻度用最小宽度） */
  durationMs: number | null;
  status: TraceCallStatus;
  /** 工具调用名 / 输入刻度为空（tooltip 由组件拼装） */
  label: string;
  /** 所属 Run 的任务文本 */
  task: string;
  matched: boolean;
}

/** 时间轴全局时间窗口（ms）；无任何带时间刻度时为 null */
export interface TraceTimelineWindow {
  minTs: number;
  maxTs: number;
}

/**
 * 从 Run 摘要列表派生时间轴刻度（保持传入顺序，不重排）。
 * 输入泳道 = 每条 Run 的起点（用户任务提交时刻）；
 * 模型/工具泳道 = 摘要里带时间戳的调用。只产出有记录依据的刻度。
 */
export function buildTimelineTicks(summaries: TraceRunSummary[]): TraceTimelineTick[] {
  const ticks: TraceTimelineTick[] = [];
  for (const summary of summaries) {
    if (summary.runStartedAt !== null) {
      ticks.push({
        kind: 'input',
        key: `${summary.runId}-input`,
        ts: summary.runStartedAt,
        durationMs: null,
        status:
          summary.status === 'running' || summary.status === 'stopping' ? 'running' : 'completed',
        label: '',
        task: summary.task,
        matched: summary.taskMatched || summary.calls.some((c) => c.matched),
      });
    }
    for (const call of summary.calls) {
      if (call.ts === null) continue;
      ticks.push({
        kind: call.kind,
        key: `${summary.runId}-${call.key}`,
        ts: call.ts,
        durationMs: call.durationMs,
        status: call.status,
        label: call.label,
        task: summary.task,
        matched: call.matched,
      });
    }
  }
  return ticks;
}

/** 全局时间窗口：最早刻度起点 → 最晚（起点 + 已记录耗时，无耗时则起点） */
export function timelineWindow(ticks: TraceTimelineTick[]): TraceTimelineWindow | null {
  let min = Infinity;
  let max = -Infinity;
  for (const tick of ticks) {
    if (tick.ts < min) min = tick.ts;
    const end = tick.durationMs != null ? tick.ts + tick.durationMs : tick.ts;
    if (end > max) max = end;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { minTs: min, maxTs: Math.max(max, min + 1) };
}
