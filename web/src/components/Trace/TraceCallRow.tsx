// 模块: TraceCallRow —— 轨迹里的单条调用行（模型调用 / 工具调用共用）
// 职责边界：只做展示与展开交互；数据（状态 / 耗时 / 合并文本）由 trace-structure.ts
//   派生后传入。展开状态是本组件的本地 state：App 侧两个内容页都保持挂载，
//   切换「对话 / 轨迹」标签不会丢。

import { useState } from 'react';
import { formatDurationMs } from '../../format';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/messages';
import { translate } from '../../i18n/translate';
import { AlertIcon, ChatIcon, ChevronRightIcon, ThinkIcon, WrenchIcon } from '../icons';
import { MarkdownText } from '../MarkdownText';
import { MessageImage } from '../Timeline/MessageImage';
import styles from './Trace.module.css';
import { stopReasonKey, type TraceCall } from './trace-structure';

const CALL_STATUS_KEY: Record<string, MessageKey> = {
  running: 'common.status.running',
  completed: 'common.status.completed',
  failed: 'common.status.failed',
  interrupted: 'trace.call.status.interrupted',
};

const DOT_CLASS: Record<string, string> = {
  running: styles.statusDotRunning,
  completed: styles.statusDotCompleted,
  failed: styles.statusDotFailed,
  interrupted: styles.statusDotInterrupted,
};

const STATUS_CLASS: Record<string, string> = {
  running: '',
  completed: '',
  failed: styles.groupStatusFailed,
  interrupted: styles.groupStatusInterrupted,
};

function toolDisplayName(tool: string): string {
  const normalized = tool.toLowerCase();
  if (/(exec|run|shell|command|bash)/.test(normalized)) return 'Shell';
  if (/(read|file)/.test(normalized)) return 'Read';
  if (/(write|save)/.test(normalized)) return 'Write';
  if (/(list|dir|glob)/.test(normalized)) return 'List';
  if (/(search|query|grep)/.test(normalized)) return 'Search';
  if (/(calculate|calc|compute)/.test(normalized)) return 'Calculator';
  return tool;
}

function modelCallName(
  call: Extract<TraceCall, { kind: 'model' }>,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
  if (call.purpose) return t(`trace.model.purpose.${call.purpose}`);
  if (call.iteration !== undefined) {
    return t('trace.model.nameWithRound', { iteration: call.iteration });
  }
  return t('trace.model.name');
}

/** 参数预览：与 ToolActionRow 一致的窄行截断 */
function previewArgs(args: unknown): string {
  if (args && typeof args === 'object') {
    const vals = Object.values(args as Record<string, unknown>).filter(
      (v): v is string | number => typeof v === 'string' || typeof v === 'number',
    );
    if (vals.length > 0) {
      const first = String(vals[0]).replace(/\s+/g, ' ').trim();
      return first.length > 80 ? `${first.slice(0, 80)}...` : first;
    }
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function prettyResult(result: unknown, language: 'zh-CN' | 'en-US'): string {
  const truncated = (text: string): string =>
    `${text.slice(0, 1200)}\n\n${translate(language, 'timeline.tool.truncated')}`;
  if (typeof result === 'string') {
    return result.length > 1200 ? truncated(result) : result;
  }
  try {
    const s = JSON.stringify(result, null, 2);
    return s.length > 1200 ? truncated(s) : s;
  } catch {
    return String(result);
  }
}

/** skippedReason / 错误码 → 展示文本；已知码给文案，未知显示原文 */
function errorText(raw: string, language: 'zh-CN' | 'en-US'): string {
  const key = stopReasonKey(raw);
  return key ? translate(language, key) : raw;
}

export function TraceCallRow({ call, runId }: { call: TraceCall; runId: string }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);

  const isModel = call.kind === 'model';
  const name = isModel
    ? modelCallName(call, t)
    : toolDisplayName((call as Extract<TraceCall, { kind: 'tool' }>).tool);
  const statusLabel = t(CALL_STATUS_KEY[call.status]);
  const durationLabel = call.durationRecorded
    ? formatDurationMs(call.durationMs ?? 0, language)
    : t('trace.duration.unrecorded');
  const argsPreview = call.kind === 'tool' ? previewArgs(call.args) : '';
  const tool = call.kind === 'tool' ? call : null;
  const model = call.kind === 'model' ? call : null;

  return (
    <li className={`${styles.callRow} ${STATUS_CLASS[call.status]}`}>
      <button
        type="button"
        className={styles.callButton}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t('trace.call.ariaLabel', { name, status: statusLabel })}
      >
        <span className={styles.callIcon} aria-hidden="true">
          {call.status === 'failed' ? (
            <AlertIcon size={14} />
          ) : isModel ? (
            <ThinkIcon size={14} />
          ) : (
            <WrenchIcon size={14} />
          )}
        </span>
        <span className={styles.callName}>{name}</span>
        {argsPreview && <code className={styles.callPreview}>{argsPreview}</code>}
        {!argsPreview && isModel && model?.streamedText && (
          <span className={styles.callPreview}>{model.streamedText.slice(0, 80)}</span>
        )}
        {/* 终态调用显示有记录依据的耗时；未记录如实标注，运行中只显示状态 */}
        {call.status !== 'running' && (
          <span
            className={`${styles.callDuration} ${call.durationRecorded ? '' : styles.callDurationUnrecorded}`}
          >
            {durationLabel}
          </span>
        )}
        <span className={styles.callStatus}>
          <span className={`${styles.statusDot} ${DOT_CLASS[call.status]}`} aria-hidden="true" />
          <span>{statusLabel}</span>
        </span>
        <ChevronRightIcon
          size={13}
          className={`${styles.callChevron} ${open ? styles.callChevronOpen : ''}`}
        />
      </button>

      {open && (
        <div className={styles.callDetail}>
          {model && <ModelDetail call={model} runId={runId} />}
          {tool && <ToolDetail call={tool} runId={runId} language={language} />}
        </div>
      )}
    </li>
  );
}

function ModelDetail({ call }: { call: Extract<TraceCall, { kind: 'model' }>; runId: string }) {
  const { t } = useI18n();
  const streaming = call.status === 'running';
  const usage = call.usage;
  return (
    <>
      {call.reasoningText && (
        <div className={styles.detailBlock}>
          <div className={styles.detailLabel}>{t('trace.model.reasoning')}</div>
          <pre className={styles.detailText}>{call.reasoningText}</pre>
        </div>
      )}
      <div className={styles.detailBlock}>
        <div className={styles.detailLabel}>{t('trace.model.output')}</div>
        {call.streamedText ? (
          <div className={styles.detailMarkdown}>
            {/* 流式增量已合并为一份文本：同一次调用始终只渲染这一个块 */}
            <MarkdownText text={call.streamedText} />
          </div>
        ) : streaming ? (
          <div className={styles.waitingHint}>
            <ChatIcon size={13} />
            <span>{t('trace.model.waiting')}</span>
          </div>
        ) : (
          <pre className={styles.detailText}>{t('trace.call.noResult')}</pre>
        )}
      </div>
      {call.transportError && (
        <div className={styles.detailBlock}>
          <div className={styles.detailLabel}>{t('timeline.tool.error')}</div>
          <pre className={`${styles.detailText} ${styles.detailError}`}>
            {t('trace.model.transportFailed', { reason: call.transportError })}
          </pre>
        </div>
      )}
      <div className={styles.detailMeta}>
        {usage && (
          <span>
            {t('trace.model.usage')}:{' '}
            {t('trace.model.usageValues', {
              input: usage.inputTokens,
              output: usage.outputTokens,
            })}
            {usage.cacheReadTokens
              ? ` · ${t('trace.model.cacheRead', { count: usage.cacheReadTokens })}`
              : ''}
            {usage.cacheWriteTokens
              ? ` · ${t('trace.model.cacheWrite', { count: usage.cacheWriteTokens })}`
              : ''}
          </span>
        )}
        {call.messageCount !== undefined && (
          <span>{t('trace.model.messages', { count: call.messageCount })}</span>
        )}
        {call.stopReason && call.stopReason !== 'stop' && <span>stop: {call.stopReason}</span>}
      </div>
    </>
  );
}

function ToolDetail({
  call,
  runId,
  language,
}: {
  call: Extract<TraceCall, { kind: 'tool' }>;
  runId: string;
  language: 'zh-CN' | 'en-US';
}) {
  const { t } = useI18n();
  return (
    <>
      {call.args != null && (
        <div className={styles.detailBlock}>
          <div className={styles.detailLabel}>{t('timeline.tool.args')}</div>
          <pre className={styles.detailText}>
            {typeof call.args === 'string' ? call.args : JSON.stringify(call.args, null, 2)}
          </pre>
        </div>
      )}
      {call.liveOutput && (
        <div className={styles.detailBlock}>
          <div className={styles.detailLabel}>{t('timeline.tool.liveOutput')}</div>
          <pre className={styles.detailText}>{call.liveOutput}</pre>
        </div>
      )}
      {call.result != null && (
        <div className={styles.detailBlock}>
          <div className={styles.detailLabel}>{t('timeline.tool.result')}</div>
          <pre className={styles.detailText}>{prettyResult(call.result, language)}</pre>
        </div>
      )}
      {call.error && (
        <div className={styles.detailBlock}>
          <div className={styles.detailLabel}>{t('timeline.tool.error')}</div>
          <pre className={`${styles.detailText} ${styles.detailError}`}>
            {errorText(call.error, language)}
          </pre>
        </div>
      )}
      {call.images && call.images.length > 0 && (
        <div className={styles.callImageStrip}>
          {call.images.map((img) => (
            <MessageImage
              key={img.path}
              thumbnail
              count={1}
              href={`/runs/${runId}/files/${encodeURIComponent(img.path)}`}
              name={img.path}
            />
          ))}
        </div>
      )}
      <div className={styles.detailMeta}>
        {call.durationRecorded && typeof call.durationMs === 'number'
          ? formatDurationMs(call.durationMs, language)
          : t('trace.duration.unrecorded')}
      </div>
    </>
  );
}

// re-export 类型别名，避免组件文件直接依赖事件 union 的可辨识成员收窄细节
export type { TraceCall };
