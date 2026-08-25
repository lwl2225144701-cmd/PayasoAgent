import { useState } from 'react';
import type { ToolCallData } from '../Timeline';
import { describeTool, formatDurationMs, previewArgs, TOOL_STATUS_LABELS } from '../../format';
import { ChevronDownIcon } from '../icons';
import styles from '../Timeline/Timeline.module.css';

interface ToolCardProps {
  data: ToolCallData;
}

function ErrorPreview({ data }: { data: ToolCallData }) {
  if (data.status !== 'failed') return null;
  // Show a friendly, single-line user error — hide stacktrace/detail from default view.
  const msg = (typeof data.error === 'string' ? data.error : String(data.error ?? '')).trim();
  if (!msg) return null;
  const firstLine = msg.split(/\r?\n/)[0].slice(0, 100);
  const final = firstLine.endsWith('.') ? firstLine : `${firstLine}${firstLine.length >= 100 ? '…' : ''}`;
  // De-tech: strip common prefixes like "Error: ", prefixes such as "ENOENT"
  const cleaned = final.replace(/^(Error|Exception|TypeError|ReferenceError|SyntaxError|RuntimeError|ENOENT|EACCES|EPERM)[^a-zA-Z\u4e00-\u9fa5]*/i, '');
  if (!cleaned) return <span className={styles.toolErrMsg}>{'操作失败'}</span>;
  return <span className={styles.toolErrMsg}>{cleaned}</span>;
}

function StatusIcon({ status }: { status: ToolCallData['status'] }) {
  if (status === 'completed') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
  }
  // running
  return (
    <span className={styles.runSpinner} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    </span>
  );
}

export function ToolCard({ data }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const statusLabel = TOOL_STATUS_LABELS[data.status];
  const statusClass =
    data.status === 'running' ? styles.toolRowRunning :
    data.status === 'failed' ? styles.toolRowFailed : styles.toolRowDone;
  const description = describeTool(data.tool, data.args);
  const hasDetail = true; // always allow toggling for toolname/args/duration/raw

  return (
    <div className={`${styles.toolCard} ${statusClass}`}>
      <button
        type="button"
        className={styles.toolRow}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        aria-label={`${statusLabel}：${description}`}
      >
        <span className={`${styles.toolIcon} ${styles[`toolIcon${data.status[0].toUpperCase()}${data.status.slice(1)}`]}`}>
          <StatusIcon status={data.status} />
        </span>

        <span className={styles.toolDesc}>{description}</span>

        {data.status === 'failed' && <ErrorPreview data={data} />}

        {/* Duration shown only when complete/fail; too detailed for main row but light */}
        {typeof data.durationMs === 'number' && data.status !== 'running' && (
          <span className={styles.toolDur}>{formatDurationMs(data.durationMs)}</span>
        )}

        {hasDetail && (
          <span className={styles.toolToggle}>
            <span className={styles.toolToggleText}>{open ? '收起' : '查看详情'}</span>
            <ChevronDownIcon size={13} className={`${styles.toolChevron} ${open ? styles.open : ''}`} />
          </span>
        )}
      </button>

      {open && (
        <div className={styles.toolDetail}>
          <DetailRow label="工具名称">
            <code className={styles.kbd}>{data.tool}</code>
          </DetailRow>
          {data.args != null && (
            <DetailRow label="参数">
              <pre className={styles.pre}>{typeof data.args === 'string' ? data.args : JSON.stringify(data.args, null, 2)}</pre>
            </DetailRow>
          )}
          <DetailRow label="状态">
            <span>{statusLabel}</span>
          </DetailRow>
          {typeof data.durationMs === 'number' && (
            <DetailRow label="用时">
              <span>{formatDurationMs(data.durationMs)}</span>
            </DetailRow>
          )}
          {typeof data.operationKey === 'string' && (
            <DetailRow label="操作键">
              <code className={styles.kbd}>{data.operationKey}</code>
            </DetailRow>
          )}
          {data.result != null && (
            <DetailRow label="结果">
              {typeof data.result === 'string' && isLikelyFileRef(data.result) ? (
                <pre className={styles.pre}>{data.result}</pre>
              ) : typeof data.result === 'string' ? (
                <pre className={styles.pre}>{truncateForDetail(data.result, 800)}</pre>
              ) : (
                <pre className={styles.pre}>{truncateForDetail(JSON.stringify(data.result, null, 2), 800)}</pre>
              )}
            </DetailRow>
          )}
          {data.error != null && (
            <DetailRow label="错误">
              <pre className={styles.preErr}>
                {typeof data.error === 'string' ? data.error : String(data.error)}
              </pre>
            </DetailRow>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <div className={styles.detailLabel}>{label}</div>
      <div className={styles.detailValue}>{children}</div>
    </div>
  );
}

function isLikelyFileRef(s: string) {
  // file://, http(s)://, or just a path-looking thing
  return /^(file|https?):\/\//.test(s) || s.startsWith('/') || /^\.?\.?\//.test(s);
}

function truncateForDetail(s: string, max: number) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…（已截断，完整内容请查看运行日志）`;
}

// Unused re-export to avoid unused import warnings in some bundlers.
export const _previewArgs = previewArgs;
