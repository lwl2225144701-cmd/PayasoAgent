import { useState } from 'react';
import type { ToolCallData } from './index';
import { formatDurationMs, previewArgs, TOOL_STATUS_LABELS } from '../../format';
import { ChevronRightIcon } from '../icons';
import styles from './Timeline.module.css';

interface ToolActionRowProps {
  data: ToolCallData;
}

/**
 * Extremely light, document-flow tool row.  No borders, no cards by default.
 * Renders as one single line in the main body:
 *
 *   ✓ 读取 package.json                         ›
 *   ○ 正在搜索 "AgentRuntime"…                   ›
 *   × 未找到 input/big.txt                       ›
 *
 * Click expands an inline "技术详情" section with tool name / args / result /
 * error / duration / operationKey / reasoning.
 */
export function ToolActionRow({ data }: ToolActionRowProps) {
  const [open, setOpen] = useState(false);
  const toolName = displayToolName(data.tool);
  const argsPreview = previewArgs(data.args);
  const statusLabel = TOOL_STATUS_LABELS[data.status];
  const statusClass =
    data.status === 'running' ? styles.trRunning :
    data.status === 'failed' ? styles.trFailed : styles.trDone;

  return (
    <li className={`${styles.toolRow} ${statusClass}`}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className={styles.toolRowClickable}
        aria-label={`${toolName}：${argsPreview}，${statusLabel}`}
      >
        <span className={styles.toolCallSummary}>
          <span className={styles.toolName}>{toolName}</span>
          {argsPreview && <code className={styles.toolArgs}>{argsPreview}</code>}
        </span>

        {data.status !== 'completed' && (
          <span className={styles.toolStatus}>
            <span className={styles[`toolStatus${data.status[0].toUpperCase()}${data.status.slice(1)}`]} aria-hidden="true" />
            <span>{statusLabel}</span>
          </span>
        )}

        <span className={styles.trChevron}>
          <ChevronRightIcon size={14} className={`${styles.chev} ${open ? styles.chevOpen : ''}`} />
        </span>
      </button>

      {open && (
        <div className={styles.toolDetail}>
          {data.args != null && (
            <DetailRow label="参数">
              <pre className={styles.pre}>
                {typeof data.args === 'string' ? data.args : JSON.stringify(data.args, null, 2)}
              </pre>
            </DetailRow>
          )}
          {data.result != null && (
            <DetailRow label="结果">
              <pre className={styles.pre}>{prettyResult(data.result)}</pre>
            </DetailRow>
          )}
          {data.error != null && (
            <DetailRow label="错误">
              <pre className={styles.preErr}>
                {typeof data.error === 'string' ? data.error : String(data.error)}
              </pre>
            </DetailRow>
          )}
          <div className={styles.detailMeta}>
            <span>{TOOL_STATUS_LABELS[data.status]}</span>
            {typeof data.durationMs === 'number' && <span>{formatDurationMs(data.durationMs)}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

function displayToolName(tool: string): string {
  const normalized = tool.toLowerCase();
  if (/(exec|run|shell|command|bash)/.test(normalized)) return 'Shell';
  if (/(read|file)/.test(normalized)) return 'Read';
  if (/(write|save)/.test(normalized)) return 'Write';
  if (/(list|dir|glob)/.test(normalized)) return 'List';
  if (/(search|query)/.test(normalized)) return 'Search';
  if (/(calculate|calc|compute)/.test(normalized)) return 'Calculator';
  return tool;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <div className={styles.detailLabel}>{label}</div>
      <div className={styles.detailValue}>{children}</div>
    </div>
  );
}

function prettyResult(result: unknown): string {
  if (typeof result === 'string') {
    if (result.length > 1200) return `${result.slice(0, 1200)}\n\n…（已截断，完整内容请查看日志）`;
    return result;
  }
  try {
    const s = JSON.stringify(result, null, 2);
    return s.length > 1200 ? `${s.slice(0, 1200)}\n\n…（已截断，完整内容请查看日志）` : s;
  } catch {
    return String(result);
  }
}
