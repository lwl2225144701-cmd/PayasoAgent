// 模块: Timeline —— 单条 Run 的对话流视图（用户消息 + 执行面板 + 终态答案 + 用量）
// 职责边界：本文件只做组件编排与滚动/派生 Hook；数据聚合在 timeline-structure.ts
//   （纯函数），执行详情面板在 ExecutionPanel.tsx，审批/工具链准备卡片在
//   TimelineApprovals.tsx。v2.4 从 1146 行拆出，外部接口（TimelineProps /
//   ToolCallData 再导出）保持不变。

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { workspaceFileUrl } from '../../api';
import { formatTime, stripThinkTags } from '../../format';
import { useEventStream } from '../../hooks/useEventStream';
import { useI18n } from '../../i18n';
import type { ContextUsageEvent, HostRun } from '../../types';
import { CollapsibleText } from '../CollapsibleText';
import { CopyButton } from '../CopyButton';
import { MarkdownText } from '../MarkdownText';
import { deriveModelWaitState, findLatestContextUsage } from './context-gauge';
import { ExecutionPanel } from './ExecutionPanel';
import { FileAttachment } from './FileAttachment';
import { MessageImage } from './MessageImage';
import { derivePlan, type PlanView } from './plan-state';

import { RunUsage } from './RunUsage';
import { ThinkBlock } from './ThinkBlock';
import styles from './Timeline.module.css';
import { TimelineApprovals } from './TimelineApprovals';
import { buildStructure, deriveRawFinalAnswer } from './timeline-structure';

// ToolCallData 的权威定义已移至 timeline-structure.ts（数据层）；此处再导出保持
// ToolActionRow 等既有 import 路径（'./index'）不变。
export type { ToolCallData } from './timeline-structure';

interface TimelineProps {
  run: HostRun | null;
  modelFallback: string | null;
  embedded?: boolean;
  /** POST 创建成功前的本地回合，只负责即时反馈，不连接不存在的临时 runId。 */
  optimistic?: boolean;
  onRunTerminal?: () => void;
  // v1.6 工具链闭环②：准备成功后用户显式重试 —— 以新会话轮次发起
  // （新轮次拥有全新 side-effect 身份空间；Runtime 不自动重放）
  onRetryCommand?: (message: string) => void;
  // 上下文预算指示：最新 context_usage 上抛给宿主（输入栏环形指示器数据源）
  onContextUsage?: (usage: ContextUsageEvent | null) => void;
  // 计划清单上抛给宿主（输入栏上方"当前计划"数据源）。宿主只把它接到最新一轮
  // Run 上：计划是会话级临时状态，下一轮开始即不再展示。
  onPlan?: (plan: PlanView | null) => void;
  // M4 预览模块集成：工具参数/附件里的工作区文件 → 右侧预览面板。缺省不显示入口。
  // runId 是"这条入口所属的 Run"：面板要按它的工作区取文件（历史回合也能看）。
  onOpenPreview?: (path: string, name: string, runId: string) => void;
}

function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let current = element;
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return current;
    current = current.parentElement;
  }
  return element;
}

export const Timeline = memo(function Timeline({
  run,
  embedded = false,
  optimistic = false,
  onRunTerminal,
  onRetryCommand,
  onContextUsage,
  onPlan,
  onOpenPreview,
  modelFallback,
}: TimelineProps) {
  const { t, language } = useI18n();
  // 传输方式按 Run 状态分流：
  // - live（running/stopping）：常驻 SSE，边流边推。
  // - snapshot（已终态）：一次性取回。已完成 Run 的事件不可变，用 SSE 会让每个历史回合
  //   各占一条长连接——浏览器同源只有 6 条并发额度，长会话打开时历史连接会把正在流式的
  //   Run 挤出队列。且 `?live=0` 的回放结束会让 EventSource 自动重连（无限刷请求），
  //   所以这里换的是传输方式，不是给 SSE 传 live=false。
  const isLive = run?.status === 'running' || run?.status === 'stopping';
  const { events, streamedText } = useEventStream(
    optimistic ? null : (run?.runId ?? null),
    isLive ? 'live' : 'snapshot',
    !optimistic && run?.status === 'running' ? onRunTerminal : undefined,
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const getScrollContainer = useCallback(() => findScrollContainer(scrollRef.current), []);

  const onScroll = useCallback(() => {
    const el = getScrollContainer();
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    autoScrollRef.current = atBottom;
  }, [getScrollContainer]);

  // Embedded turns share App's session scroller and its follow state.
  // Only standalone Timelines manage their own scroll position here.
  useEffect(() => {
    if (embedded) return;
    const el = getScrollContainer();
    if (!el) return;
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [embedded, getScrollContainer, onScroll]);

  // Scroll once per rendered batch, immediately. Repeated smooth scrolling
  // queues animations and makes a fast stream visibly lag behind the text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events 是"每渲染一批滚动一次"的批次触发器，刻意不在回调体内引用
  useEffect(() => {
    if (embedded) return;
    if (!autoScrollRef.current) return;
    const el = getScrollContainer();
    if (!el) return;
    const frame = window.requestAnimationFrame(() => {
      if (autoScrollRef.current) el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [embedded, events, getScrollContainer]);

  // ---- 答案派生：引用稳定时跳过全串正则（stripThinkTags 是剩余最大单点成本）----
  // rawFinalAnswer：优先级与 buildStructure 原逻辑一致（final_answer > run_completed.result
  // > run.result > 流式增量全文）。流式中其引用 = streamedText 引用，仅在 delta 帧变化。
  const rawFinalAnswer = useMemo(
    () => (run ? deriveRawFinalAnswer(run, events, streamedText) : null),
    [run, events, streamedText],
  );
  const finalAnswerText = rawFinalAnswer?.text ?? null;
  // 当前显示的"答案"只是流式兜底 → 它是本步正在写的中间叙述，运行期间按过程折叠，
  // 否则十几轮下来会把整屏铺满（参考实现把这一段收在「分析」里）。
  const rawAnswerIsStreamingFallback = rawFinalAnswer?.streamedFallback ?? false;
  // stripThinkTags 三趟全串正则只随 rawFinalAnswer 引用变化重算：
  // context_usage/tool 等非 delta 帧不触碰 streamedText → 这里跳过，避免每帧 O(全文) 正则。
  const finalParsed = useMemo(
    () => (finalAnswerText ? stripThinkTags(finalAnswerText) : null),
    [finalAnswerText],
  );

  const structure = useMemo(() => {
    if (!run) return null;
    return buildStructure(
      run,
      events,
      finalAnswerText,
      finalParsed,
      language,
      rawAnswerIsStreamingFallback,
    );
  }, [run, events, finalAnswerText, finalParsed, language, rawAnswerIsStreamingFallback]);

  // 计划清单：从事件派生（取 revision 最大的一条），无计划事件 → null。
  // 面板不再画在对话流里：这里只把派生结果上抛给宿主（输入栏上方的"当前计划"），
  // 且只有最新一轮 Run 会拿到 onPlan —— 下一轮开始后旧计划自然不再展示。
  const plan = useMemo(() => derivePlan(events), [events]);
  useEffect(() => {
    onPlan?.(plan);
  }, [onPlan, plan]);

  const runActive = run?.status === 'running' || run?.status === 'stopping';

  // 上下文预算环形指示器：取最新一条 context_usage（压缩/紧急裁剪状态随之可见）。
  // 即使当前 Run 尚未加载完成也要无条件调用 Hook，保证组件每次渲染顺序一致。
  const latestContextUsage = findLatestContextUsage(events);
  useEffect(() => {
    onContextUsage?.(latestContextUsage);
  }, [onContextUsage, latestContextUsage]);

  if (!run || !structure) {
    return (
      <div ref={scrollRef} className={styles.timelineWrap}>
        <div className={styles.empty}>{t('timeline.empty')}</div>
      </div>
    );
  }

  const {
    runStarted,
    finalAnswer,
    answerIsStreamingFallback,
    finalTimestamp,
    finalError,
    lastStepRunning,
    toolSteps,
    globalThinking,
  } = structure;

  // 用户主动停止的 Run 不显示那条红色错误（对齐 DSH：只显示"已停止 · 用时 X"）。
  // "Aborted" 来自 AbortSignal 的 DOMException，是"停止"的正常产物而不是故障，
  // 状态行已经说清楚了，再挂一条红的是噪音。
  // 进程重启导致的 interrupted 仍然显示 —— 那不是用户干的，值得知晓。
  const showError = finalError !== null && run.status !== 'stopped';

  // 首个 token 等待期：运行中且最后一条事件是 llm_call_started（任何后续事件都意味着等待结束）。
  // 父组件 running 期间每 1.2s tick，秒数随之实时刷新。
  const modelWait = run.status === 'running' ? deriveModelWaitState(events, Date.now()) : null;
  // Has any work actually been performed? (tools + visible reasoning + final answer).
  // running 时强制渲染：首条事件（reasoning/tool）到达前的空窗期也要立刻给出
  // 「正在执行 · 正在分析」反馈，否则发消息后有几秒完全无响应的观感。
  const hasAnyWork =
    toolSteps.some(
      (g) =>
        g.tools.length > 0 || (g.reasoning && (g.reasoning.visible || g.reasoning.thinkingDetail)),
    ) ||
    !!finalAnswer ||
    !!globalThinking ||
    !!finalError ||
    run.status !== 'stopping';

  // 本条消息的附件。图片附件的判定与下面渲染分支保持一致（走缩略图链接，
  // 其余走 FileAttachment 文件卡片）：kind 非 text 且 mimeType 是 image/*。
  const attachments = runStarted?.type === 'run_started' ? runStarted.attachments : undefined;
  const imageCount =
    attachments?.filter((att) => att.kind !== 'text' && att.mimeType.startsWith('image/')).length ??
    0;
  // compact：附件多于 1 个 —— 图片不再按原图尺寸铺开，一律降级 64px 方格。
  // 注意判定用的是**附件总数**而不是图片数：1 张图 + 1 个文档时那张图也是方格。
  const attachmentsCompact = (attachments?.length ?? 0) > 1;

  return (
    <div
      id={run ? `run-${run.runId}` : undefined}
      ref={scrollRef}
      className={`${styles.timelineWrap} ${embedded ? styles.embedded : ''}`}
    >
      <div className={styles.timeline}>
        <article className={styles.userBlock}>
          {/* 排列顺序：附件（文件 / 图片）在用户文字消息**之前** —— 先看到"带了什么"，
              再读到"要它做什么"；时间戳与复制按钮仍在最底下的页脚行。
              图片的显示尺寸由 MessageImage 的三个变体决定（见 message-image.ts），
              与视图宽度无关。 */}
          {attachments && attachments.length > 0 && (
            <div className={styles.userAttachments}>
              {attachments.map((att) =>
                att.kind === 'text' || !att.mimeType.startsWith('image/') ? (
                  <FileAttachment
                    key={att.path}
                    runId={run.runId}
                    file={att}
                    onOpenPreview={onOpenPreview}
                  />
                ) : (
                  <MessageImage
                    key={att.path}
                    href={workspaceFileUrl(run.runId, att.path)}
                    name={att.name}
                    compact={attachmentsCompact}
                    count={imageCount}
                    width={att.width}
                    height={att.height}
                  />
                ),
              )}
            </div>
          )}
          {/* 用户消息与助手正文共用 MarkdownText：手打的 **加粗**、# 标题、列表、代码块
              都按 Markdown 渲染。这里不做模型输出那套畸形 fence 修复 —— 不改写用户原文。 */}
          <div className={styles.userText}>
            <MarkdownText text={run.task} />
          </div>
          <div className={styles.userMeta}>
            <time className={styles.time}>
              {formatTime(runStarted?.timestamp ?? run.createdAt, language)}
            </time>
            {/* 复制用户自己发出的原文：与时间戳同一页脚行、低调的纯图标按钮 */}
            <CopyButton text={run.task} iconOnly />
          </div>
        </article>

        {hasAnyWork ? (
          <section className={styles.agentBlock}>
            <TimelineApprovals
              events={events}
              runId={run.runId}
              runActive={runActive}
              onRetryCommand={onRetryCommand}
            />
            <ExecutionPanel
              groups={toolSteps}
              thinking={globalThinking}
              running={lastStepRunning}
              modelWait={modelWait}
              startedAt={runStarted?.timestamp ?? run.createdAt}
              status={run.status}
              finishedAt={finalTimestamp}
              runId={run.runId}
              stopReason={run.stopReason}
              deliveryOutcome={run.deliveryOutcome}
              onOpenPreview={onOpenPreview}
            />

            {/* Final result — exactly once, no card, no success badge. */}
            {finalAnswer &&
              (lastStepRunning && answerIsStreamingFallback ? (
                // 运行中且还没有终态答案：这时显示的其实是"当前这一步正在写的内容"
                // （多半是中间叙述）。按过程收成一行预览——以前直接整段铺开，长任务
                // 十几轮下来会把整屏占满（参考实现把这一段收在「分析」里）。
                // 一旦出现真正的终态答案（final_answer / run_completed / run.result），
                // 下面那个分支会把它按答案完整展示。
                <div className={styles.finalBlock}>
                  <ThinkBlock
                    text={finalAnswer}
                    label={t('timeline.streaming.label')}
                    ariaLabel={t('timeline.streaming.ariaLabel')}
                  />
                </div>
              ) : (
                <div className={styles.finalBlock}>
                  <CollapsibleText text={finalAnswer} streaming={lastStepRunning} />
                  {showError && <div className={styles.finalError}>{finalError}</div>}
                </div>
              ))}
            {!finalAnswer && showError && <div className={styles.finalError}>{finalError}</div>}

            <RunUsage run={run} events={events} modelLabel={modelFallback} />
          </section>
        ) : (
          // Empty agent section: reserved vertical rhythm so input isn't jumpy.
          <section className={styles.agentBlock} aria-hidden="true" />
        )}
      </div>
    </div>
  );
});
