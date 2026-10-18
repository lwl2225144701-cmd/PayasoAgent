// 模块: Timeline 执行详情面板 —— 可折叠的"正在执行"摘要 + 分组工具步骤
// 职责边界：只负责运行态/阶段化文案与工具步骤的呈现；数据聚合（groups）由
//   index.tsx 经 timeline-structure.ts 派生后传入。时钟下沉到本组件（见下），
//   避免父级 Timeline 每 tick 拖整棵子树重渲。

import { useEffect, useRef, useState } from 'react';
import { formatDurationMs } from '../../format';
import { useI18n } from '../../i18n';
import type { HostRunStatus, RunDeliveryOutcome, RunStopReason } from '../../types';
import { AlertIcon, CheckIcon, ChevronRightIcon, ScissorsIcon, ThinkIcon } from '../icons';
import type { ModelWaitState } from './context-gauge';
import { ThinkBlock } from './ThinkBlock';
import styles from './Timeline.module.css';
import { ToolActionRow } from './ToolActionRow';
import { elapsedSeconds, type ToolStepGroup } from './timeline-structure';

export function ExecutionPanel({
  groups,
  thinking,
  running,
  modelWait,
  startedAt,
  status,
  finishedAt,
  runId,
  stopReason,
  deliveryOutcome,
  onOpenPreview,
}: {
  groups: ToolStepGroup[];
  thinking: string;
  running: boolean;
  /** 非 null = 正在等待模型首 token（llm_call_started 之后无任何后续事件） */
  modelWait: ModelWaitState | null;
  startedAt: string | undefined;
  status: HostRunStatus;
  finishedAt: string;
  runId: string;
  /** v2.6：稳定停止原因（终态；预算耗尽与用户主动停止必须分开陈述）。 */
  stopReason?: RunStopReason;
  /** v2.6：交付结果（与 status 正交）。 */
  deliveryOutcome?: RunDeliveryOutcome;
  /** M4：工具行的"在预览面板中打开"入口（缺省不显示）。 */
  onOpenPreview?: (path: string, name: string, runId: string) => void;
}) {
  // 执行详情默认收起，避免每次发送消息都把页面撑开；用户仍可手动展开。
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  // 时钟下沉：运行中每秒强制 ExecutionPanel 自身重渲一次，刷新执行时长 /
  // 阶段化文案 / 首 token 等待秒数。不再依赖父级 Timeline 的全局 tick——
  // 否则每 1.2s 会拖整棵 Timeline（含 finalAnswer/CollapsibleText 子树）重渲。
  const [, setClockTick] = useState(0);
  const wasRunning = useRef(running);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setClockTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const tools = groups.flatMap((group) => group.tools);
  const failedCount = tools.filter((tool) => tool.status === 'failed').length;
  // v2.4 前台 shell 实时输出：详情默认收起是有意为之（避免每次发消息都把页面撑开），
  // 但 ToolActionRow 只在 open 时才挂载 —— 面板不展开，"逐行出现"就永远看不到。
  // 折中：首个实时增量出现时自动展开一次；用户中途手动收起后不再抢焦点（autoOpened
  // 记得住），Run 结束时仍由下方既有逻辑统一收起。
  const hasLiveOutput = tools.some((tool) => tool.status === 'running' && Boolean(tool.liveOutput));
  const autoOpenedForLiveRef = useRef(false);
  const elapsed = running && startedAt ? elapsedSeconds(startedAt) : 0;
  const startMs = startedAt ? new Date(startedAt).getTime() : NaN;
  const endMs = running ? Date.now() : new Date(finishedAt).getTime();
  const durationMs =
    Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
  const durationLabel =
    durationMs >= 1000
      ? formatDurationMs(durationMs, language)
      : t('timeline.duration.underOneSecond');
  // 阶段化文案：随等待时间演进，避免静态文字的呆滞感
  const thinkingPhase =
    elapsed < 6
      ? t('timeline.wait.thinking')
      : elapsed < 20
        ? t('timeline.wait.analyzing')
        : t('timeline.wait.complexTask');
  // 等待模型首 token 的实时秒数（父组件 running 期间每 1.2s tick 一次，随渲染刷新）
  // 已发出 Provider 请求（llm_request_sent）后从 requestSentAt 起算；否则从 llm_call_started 起算。
  const modelWaitSeconds = modelWait
    ? Math.max(
        0,
        Math.round(
          (Date.now() - Date.parse(modelWait.requestSentAt ?? modelWait.startedAt)) / 1000,
        ),
      )
    : 0;
  // 大上下文时提示 prefill 慢的根因与出路（≥100K 才提示，避免噪音）
  const modelWaitTitle =
    modelWait?.estimatedInputTokens !== undefined && modelWait.estimatedInputTokens >= 100_000
      ? t('timeline.wait.largeContextHint', {
          k: Math.round(modelWait.estimatedInputTokens / 1000),
        })
      : undefined;
  const bodyEmpty =
    !thinking &&
    tools.length === 0 &&
    !groups.some((g) => g.reasoning?.visible || g.compactionNote || g.planNote);
  const hasDetails =
    Boolean(thinking) ||
    tools.length > 0 ||
    groups.some((group) => group.reasoning?.visible) ||
    groups.some((group) => group.compactionNote) ||
    groups.some((group) => group.planNote);
  const statusTitle = running
    ? t('timeline.execution.statusRunning')
    : status === 'failed'
      ? t('timeline.execution.statusFailed')
      : status === 'stopping'
        ? t('timeline.execution.statusStopping')
        : status === 'stopped'
          ? t('timeline.execution.statusStopped')
          : status === 'interrupted'
            ? t('timeline.execution.statusInterrupted')
            : t('timeline.execution.statusDone');
  // v2.6 终态语义：停止原因与交付结果分别陈述——"执行已结束"不等于"目标已完成"，
  // 预算耗尽更不是用户主动停止。进行中的 Run 两者都缺省，不显示这一行。
  const terminal = !running && status !== 'stopping';
  const stopReasonLabel =
    terminal && stopReason ? t(`timeline.execution.stopReason.${stopReason}`) : undefined;
  const deliveryLabel =
    terminal && deliveryOutcome ? t(`timeline.execution.delivery.${deliveryOutcome}`) : undefined;

  useEffect(() => {
    if (!running && wasRunning.current) setOpen(false);
    wasRunning.current = running;
  }, [running]);

  // 实时输出出现即展开一次（见上方 hasLiveOutput 处说明）。依赖项用布尔量，
  // 避免 tools 每次渲染新建数组导致 effect 反复触发。
  useEffect(() => {
    if (!running) {
      autoOpenedForLiveRef.current = false;
      return;
    }
    if (hasLiveOutput && !autoOpenedForLiveRef.current) {
      autoOpenedForLiveRef.current = true;
      setOpen(true);
    }
  }, [running, hasLiveOutput]);

  if (!hasDetails && !running && status !== 'failed' && status !== 'interrupted') return null;

  return (
    <section className={`${styles.executionPanel} ${open ? styles.executionPanelOpen : ''}`}>
      <button
        type="button"
        className={styles.executionSummary}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span
          className={`${styles.executionStateIcon} ${running ? styles.executionStateRunning : ''} ${failedCount > 0 || status === 'failed' ? styles.executionStateFailed : ''}`}
        >
          {running ? (
            <ThinkIcon size={16} />
          ) : failedCount > 0 || status === 'failed' ? (
            <AlertIcon size={16} />
          ) : (
            <CheckIcon size={16} />
          )}
        </span>
        <span className={styles.executionTitle}>{statusTitle}</span>
        <span className={styles.executionMeta}>
          {tools.length > 0 && (
            <span>{t('timeline.execution.toolCount', { count: tools.length })}</span>
          )}
          {running && (modelWait || tools.length === 0) && (
            <span className={styles.thinkingText} title={modelWaitTitle}>
              {modelWait
                ? modelWait.requestSentAt
                  ? `${t('timeline.wait.firstPacket', { iteration: modelWait.iteration, seconds: modelWaitSeconds })}${
                      modelWait.attempt && modelWait.attempt > 1
                        ? t('timeline.wait.attemptSuffix', { attempt: modelWait.attempt })
                        : ''
                    }`
                  : t('timeline.wait.preparing', {
                      iteration: modelWait.iteration,
                      seconds: modelWaitSeconds,
                    })
                : thinkingPhase}
              <span className={styles.thinkDots} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </span>
          )}
          <span className={styles.executionDuration}>
            {' · '}
            {t('timeline.execution.duration', { duration: durationLabel })}
          </span>
          {failedCount > 0 && (
            <span className={styles.executionFailed}>
              {' · '}
              {t('timeline.execution.failedCount', { count: failedCount })}
            </span>
          )}
          {stopReasonLabel && (
            <span className={styles.executionFailed}>
              {' · '}
              {t('timeline.execution.stopReasonLabel')}: {stopReasonLabel}
            </span>
          )}
          {deliveryLabel && (
            <span className={styles.executionMeta}>
              {' · '}
              {t('timeline.execution.deliveryLabel')}: {deliveryLabel}
            </span>
          )}
        </span>
        <ChevronRightIcon
          size={15}
          className={`${styles.executionChevron} ${open ? styles.executionChevronOpen : ''}`}
        />
      </button>

      {open && (
        <div className={styles.executionBody}>
          {bodyEmpty && running && (
            <div className={styles.skeletonLines} aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          )}
          {thinking && <ThinkBlock text={thinking} />}
          {groups.map((group) => (
            <div key={`process-${group.step}`} className={styles.processStep}>
              {group.compactionNote && (
                <div className={styles.compactionNote}>
                  <ScissorsIcon size={12} />
                  <span>{group.compactionNote}</span>
                </div>
              )}
              {group.planNote && (
                <div
                  className={`${styles.planNote} ${styles[`planNote_${group.planNote.kind}`] ?? ''}`}
                >
                  <span>{group.planNote.text}</span>
                </div>
              )}
              {group.tools.length > 0 && (
                <ul className={styles.toolList} aria-label={t('timeline.tools.ariaLabel')}>
                  {group.tools.map((tool) => (
                    <ToolActionRow
                      key={tool.operationKey ?? `${tool.tool}-${tool.startedAt}`}
                      data={tool}
                      runId={runId}
                      onOpenPreview={onOpenPreview}
                    />
                  ))}
                </ul>
              )}
              {group.reasoning?.visible && (
                // 每步的分析叙述收成折叠行（与思考块同形状）：以前这里用
                // CollapsibleText 每步铺 520 字正文，十几轮下来就是一堵墙。
                // 终态答案另有位置（finalAnswer），这里只是中间过程。
                <ThinkBlock
                  text={group.reasoning.visible}
                  label={t('timeline.analysis.label')}
                  ariaLabel={t('timeline.analysis.ariaLabel')}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
