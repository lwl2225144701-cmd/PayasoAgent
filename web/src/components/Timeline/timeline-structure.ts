// 模块: Timeline 数据聚合 —— 事件流 → 视图结构的纯函数层
// 职责边界：与 context-gauge.ts 同 pattern——纯函数与组件分离，便于 node 测试。
//   index.tsx 只留组件与编排；本文件不含任何 React/DOM 依赖，全部确定性纯函数
//   （唯一的"状态"是 parseLlmCallText 的 WeakMap 缓存，键是事件对象，随 GC 自动消失）。
// 注意：llm_call 事件一旦写入事件流就不可变（对象引用也不再替换），其 think 标签解析结果
//   可以安全地按事件对象缓存——buildStructure 在流式期间每帧执行，不缓存就会对本回合
//   全部历史 llm_call 反复跑全串正则（stripThinkTags 是 3~4 趟 O(文本) 正则）。

import { isDuplicateOfFinal, stripThinkTags } from '../../format';
import { translate } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
import type {
  HostEvent,
  HostRun,
  LlmCallEvent,
  StreamingEvent,
  ToolCallEvent,
  ToolErrorEvent,
  ToolResultEvent,
  TraceImage,
} from '../../types';
import { derivePlanNotes, type PlanNote } from './plan-state';

export interface ToolCallData {
  operationKey?: string;
  tool: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  durationMs?: number;
  result?: unknown;
  error?: unknown;
  /** 工具产出的图片（工作区相对路径，需配合 runId 拼访问地址） */
  images?: TraceImage[];
  /**
   * v2.4 前台 shell 实时输出预览（shell_output_delta 累积）。
   * 仅运行中可见：命令结束后以完整 result 为准，避免预览与结果两份文本并存。
   */
  liveOutput?: string;
}

interface ReasoningBlock {
  step: number;
  timestamp: string;
  thinkingDetail: string | null;
  visible: string;
}

interface BuildOut {
  runStarted: HostEvent | undefined;
  finalAnswer: string | null;
  /** finalAnswer 只是流式兜底（还没有真正的终态答案）→ 运行期间按过程折叠。 */
  answerIsStreamingFallback: boolean;
  finalTimestamp: string;
  finalError: string | null;
  toolSteps: ToolStepGroup[];
  lastStepRunning: boolean;
  /** Global reasoning bucket for disclosure (currently unused by default UI). */
  globalThinking: string;
}

export interface ToolStepGroup {
  step: number;
  reasoning: ReasoningBlock | null;
  tools: ToolCallData[];
  /** 上下文压缩（compaction）发生在该 step 时的弱化说明，内务事件不成卡片。 */
  compactionNote?: string | null;
  /** 计划在该 step 发生变化时的弱化说明（与工具步骤的视觉呼应，不做猜测式连线）。 */
  planNote?: PlanNote | null;
}

/**
 * 答案原始文本（尚未 stripThinkTags）：final_answer > run_completed.result >
 * run.result > 流式增量全文。流式路径复用 useEventStream 增量累计的 streamedText
 * （引用稳定，见 useEventStream.flushPending），不再每帧 filter+map+join delta 事件。
 */
export function deriveRawFinalAnswer(
  run: HostRun,
  events: HostEvent[],
  streamedText: string,
): { text: string | null; streamedFallback: boolean } {
  const finalEv = events.find((e) => e.type === 'final_answer');
  const completedEv = events.find((e) => e.type === 'run_completed');
  let finalAnswer: string | null = null;
  if (finalEv && 'content' in finalEv) finalAnswer = finalEv.content?.trim() || null;
  if (!finalAnswer && completedEv && 'result' in completedEv) {
    finalAnswer = (completedEv.result as unknown as string | undefined)?.trim() || null;
  }
  if (!finalAnswer && run.result) finalAnswer = String(run.result).trim() || null;
  // 兜底：还没有任何终态答案时用累计的流式正文顶上。此时显示的其实是**当前这一步
  // 正在写的内容**（多半是中间叙述），调用方据此决定"按过程折叠"还是"按答案展示"。
  if (!finalAnswer) return { text: streamedText || null, streamedFallback: true };
  return { text: finalAnswer, streamedFallback: false };
}

type ParsedThink = ReturnType<typeof stripThinkTags>;

const llmCallParseCache = new WeakMap<
  HostEvent,
  { response: ParsedThink; reasoning: ParsedThink }
>();

function parseLlmCallText(llm: LlmCallEvent): { response: ParsedThink; reasoning: ParsedThink } {
  const cached = llmCallParseCache.get(llm);
  if (cached) return cached;
  const parsed = {
    response: stripThinkTags(llm.response ?? ''),
    reasoning: stripThinkTags(llm.reasoning ?? ''),
  };
  llmCallParseCache.set(llm, parsed);
  return parsed;
}

export function buildStructure(
  run: HostRun,
  events: HostEvent[],
  rawFinalAnswer: string | null,
  finalParsed: { visible: string; thinking: string | null } | null,
  language: LanguageMode,
  answerIsStreamingFallback: boolean,
): BuildOut {
  const runStarted = events.find((e) => e.type === 'run_started');
  const completedEv = events.find((e) => e.type === 'run_completed');
  const failedEv = events.find((e) => e.type === 'run_failed');
  const interruptedEv = events.find((e) => e.type === 'run_interrupted');
  const errorEv = [...events].reverse().find((e) => e.type === 'error');
  const finalEv = events.find((e) => e.type === 'final_answer');

  const finalAnswer: string | null = rawFinalAnswer ? finalParsed?.visible || null : null;
  const finalThinking: string | null = rawFinalAnswer ? (finalParsed?.thinking ?? null) : null;

  const finalError: string | null =
    (failedEv && 'error' in failedEv && typeof failedEv.error === 'string'
      ? failedEv.error.trim()
      : null) ||
    (interruptedEv && 'error' in interruptedEv && typeof interruptedEv.error === 'string'
      ? interruptedEv.error.trim()
      : null) ||
    (errorEv && 'message' in errorEv && typeof errorEv.message === 'string'
      ? errorEv.message.trim()
      : null) ||
    run.error?.trim() ||
    null;

  // Group events by step.
  const byStep = new Map<number, HostEvent[]>();
  for (const ev of events) {
    if (!('step' in ev) || typeof ev.step !== 'number') continue;
    const arr = byStep.get(ev.step) ?? [];
    arr.push(ev);
    byStep.set(ev.step, arr);
  }
  const stepNumbers = [...byStep.keys()].sort((a, b) => a - b);

  const flatCards = buildFlatToolCards(events);

  const cardsByStep = new Map<number, ToolCallData[]>();
  for (const card of flatCards) {
    const step = (card as ToolCallData & { __step?: number }).__step ?? 0;
    delete (card as { __step?: number }).__step;
    const arr = cardsByStep.get(step) ?? [];
    arr.push(card);
    cardsByStep.set(step, arr);
  }

  // Terminal-run safety: force any lingering "running" cards to completed.
  if (run.status !== 'running') {
    for (const list of cardsByStep.values()) {
      for (const c of list) {
        if (c.status === 'running') c.status = 'completed';
      }
    }
  }

  // 计划变更说明：按 revision 顺序 diff 出「这一步之后计划变成了什么」，挂到对应 step。
  const planNotes = derivePlanNotes(events, language);

  const toolSteps: ToolStepGroup[] = [];
  const processedToolsEv: HostEvent[] = [];
  let globalThinkingAcc = events
    .filter((event): event is StreamingEvent => event.type === 'reasoning_delta')
    .map((event) => event.delta)
    .join('');
  if (finalThinking) {
    globalThinkingAcc += `${globalThinkingAcc ? '\n\n' : ''}${finalThinking}`;
  }

  for (const step of stepNumbers) {
    const stepEvents = byStep.get(step) ?? [];
    let reasoning: ReasoningBlock | null = null;
    {
      const llmCalls = stepEvents.filter(
        (e): e is LlmCallEvent => e.type === 'llm_call' && !e.purpose,
      );
      const llm = llmCalls[llmCalls.length - 1];
      if (llm) {
        const { response: parsedResponse, reasoning: parsedReasoning } = parseLlmCallText(llm);
        const thinkingParts = [
          parsedResponse.thinking,
          parsedReasoning.thinking ?? parsedReasoning.visible,
        ].filter((part): part is string => Boolean(part?.trim()));
        const thinking = thinkingParts.join('\n\n') || null;
        const visible = isDuplicateOfFinal(parsedResponse.visible, finalAnswer)
          ? ''
          : parsedResponse.visible;
        if (thinking) globalThinkingAcc += `${globalThinkingAcc ? '\n\n' : ''}${thinking}`;
        // status line is computed once globally, not per step (no multi-line states).
        reasoning = {
          step,
          timestamp: llm.timestamp,
          thinkingDetail: thinking,
          visible,
        };
      }
    }

    const tools = cardsByStep.get(step) ?? [];

    // 上下文压缩是内务事件：每个 step 至多一个，渲染为工具步骤间的弱化注释行。
    const compactionEv = stepEvents.find((e) => e.type === 'context_compaction');
    const compactionNote =
      compactionEv && compactionEv.type === 'context_compaction'
        ? translate(language, 'timeline.compaction.note', {
            count: compactionEv.totalSummarizedMessages,
          })
        : null;
    const planNote = planNotes.get(step) ?? null;

    for (const ev of stepEvents) {
      if (ev.type === 'tool_call' || ev.type === 'tool_result' || ev.type === 'tool_error') {
        processedToolsEv.push(ev);
      }
    }

    // Don't emit a step group that has neither reasoning nor tools nor a compaction note.
    if (tools.length === 0 && !reasoning && !compactionNote && !planNote) continue;
    // Don't emit a step group where reasoning contains only a pure duplicate of final answer with no tools.
    if (
      tools.length === 0 &&
      !compactionNote &&
      !planNote &&
      reasoning &&
      (!reasoning.visible || isDuplicateOfFinal(reasoning.visible, finalAnswer)) &&
      !reasoning.thinkingDetail
    )
      continue;

    toolSteps.push({ step, reasoning, tools, compactionNote, planNote });
  }

  if (toolSteps.length === 0 && run.status === 'running') {
    toolSteps.push({
      step: 0,
      reasoning: {
        step: 0,
        timestamp: runStarted?.timestamp ?? run.createdAt,
        thinkingDetail: null,
        visible: '',
      },
      tools: [],
    });
  }

  const lastStepRunning = run.status === 'running';

  return {
    runStarted,
    finalAnswer,
    answerIsStreamingFallback,
    finalTimestamp:
      (finalEv && 'timestamp' in finalEv ? finalEv.timestamp : undefined) ??
      (completedEv && 'timestamp' in completedEv ? completedEv.timestamp : undefined) ??
      run.updatedAt,
    finalError,
    toolSteps,
    lastStepRunning,
    globalThinking: globalThinkingAcc,
  };
}

function buildFlatToolCards(events: HostEvent[]): Array<ToolCallData & { __step: number }> {
  type R = ToolCallData & { __step: number };
  const cards: R[] = [];
  for (const ev of events) {
    if (ev.type === 'tool_call') {
      const call = ev as ToolCallEvent;
      const card: R = {
        operationKey: `call-${call.step}-${cards.length}`,
        tool: call.tool,
        args: call.args,
        status: 'running',
        startedAt: call.timestamp,
        __step: call.step,
      };
      cards.push(card);
      continue;
    }
    if (ev.type === 'tool_result') {
      const res = ev as ToolResultEvent;
      const target =
        [...cards].reverse().find((c) => c.status === 'running' && c.tool === res.tool) ??
        [...cards].reverse().find((c) => c.status === 'running');
      if (target) {
        target.status = 'completed';
        target.result = res.result;
        if (res.images && res.images.length > 0) target.images = res.images;
        target.durationMs =
          res.durationMs != null
            ? res.durationMs
            : computeDurationMs(target.startedAt, res.timestamp);
      }
      continue;
    }
    if (ev.type === 'tool_error') {
      const err = ev as ToolErrorEvent;
      const target =
        [...cards].reverse().find((c) => c.status === 'running' && c.tool === err.tool) ??
        [...cards].reverse().find((c) => c.status === 'running');
      if (target) {
        target.status = 'failed';
        target.error = err.error;
        target.durationMs = computeDurationMs(target.startedAt, err.timestamp);
      }
      continue;
    }
    // v2.4 前台 shell 实时输出：增量挂到"当前正在跑的那张卡"。
    // 不按 messageId 匹配工具 id —— tool_call 事件本身不携带调用 id，而同一轮内
    // 工具调用是顺序执行的，所以"最后一个 running 卡"就是输出所属的卡，与
    // tool_result / tool_error 的归属逻辑完全一致。
    // 本分支是循环体内最后一支，故无需 continue。
    if (ev.type === 'shell_output_delta') {
      const target = [...cards].reverse().find((c) => c.status === 'running');
      if (target) target.liveOutput = (target.liveOutput ?? '') + ev.delta;
    }
  }
  return cards;
}

function computeDurationMs(startedAt: string, endedAt: string): number {
  const s = new Date(startedAt).getTime();
  const e = new Date(endedAt).getTime();
  return Math.max(0, e - s);
}

export function elapsedSeconds(startedAt: string): number {
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}
