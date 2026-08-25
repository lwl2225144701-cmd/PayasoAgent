import { useState } from 'react';
import type { ToolCallData } from './index';
import { describeTool, formatDurationMs, TOOL_STATUS_LABELS } from '../../format';
import { ChevronRightIcon } from '../icons';
import styles from './Timeline.module.css';

interface ToolActionRowProps {
  data: ToolCallData;
  /** If the step-level reasoning bucket contains detail thinking, attach it to disclosure. */
  reasoning: string | null;
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
export function ToolActionRow({ data, reasoning }: ToolActionRowProps) {
  const [open, setOpen] = useState(false);
  const description = describeTool(data.tool, data.args);
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
        aria-label={`${TOOL_STATUS_LABELS[data.status]}：${description}`}
      >
        <span className={`${styles.trIcon} ${styles[`tri${data.status[0].toUpperCase()}${data.status.slice(1)}`]}`}>
          <StatusGlyph status={data.status} />
        </span>

        <span className={styles.trDesc}>
          {/* For running state, turn description into "正在…" prose. */}
          {data.status === 'running' ? (
            <>
              <span className={styles.trDescRunningLead}>正在</span>
              <span>{stripLeadingAction(description)}</span>
              <span className={styles.trEllipsis}>…</span>
            </>
          ) : data.status === 'failed' ? (
            <>
              <span className={styles.trDescFailedLead}>未完成 · </span>
              <span>{description}</span>
            </>
          ) : (
            description
          )}
        </span>

        {/* User-level inline failure hint. Light text. */}
        {data.status === 'failed' && <UserHint error={data.error} />}

        <span className={styles.trChevron}>
          <ChevronRightIcon size={14} className={`${styles.chev} ${open ? styles.chevOpen : ''}`} />
        </span>
      </button>

      {open && (
        <div className={styles.toolDetail}>
          <DetailRow label="工具">{data.tool}</DetailRow>
          {data.args != null && (
            <DetailRow label="参数">
              <pre className={styles.pre}>
                {typeof data.args === 'string' ? data.args : JSON.stringify(data.args, null, 2)}
              </pre>
            </DetailRow>
          )}
          <DetailRow label="状态">{TOOL_STATUS_LABELS[data.status]}</DetailRow>
          {typeof data.durationMs === 'number' && (
            <DetailRow label="耗时">{formatDurationMs(data.durationMs)}</DetailRow>
          )}
          {typeof data.operationKey === 'string' && (
            <DetailRow label="操作键"><code className={styles.kbd}>{data.operationKey}</code></DetailRow>
          )}
          {reasoning && (
            <DetailRow label="思考过程">
              <pre className={styles.pre}>{reasoning}</pre>
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
        </div>
      )}
    </li>
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

function StatusGlyph({ status }: { status: ToolCallData['status'] }) {
  if (status === 'completed') {
    // BLUE check (not green)
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
  }
  // running: animated blue ring.
  return (
    <span className={styles.trSpinner} aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    </span>
  );
}

function UserHint({ error }: { error: unknown }) {
  const raw = (typeof error === 'string' ? error : String(error ?? '')).trim();
  if (!raw) return null;
  const firstLine = raw.split(/\r?\n/)[0].slice(0, 80);
  const cleaned = firstLine.replace(/^(Error|Exception|TypeError|ReferenceError|SyntaxError|RuntimeError|ENOENT|EACCES|EPERM)[^a-zA-Z\u4e00-\u9fa5]*/i, '');
  if (!cleaned) return null;
  const truncated = cleaned.length >= 80 ? `${cleaned.slice(0, 78)}…` : cleaned;
  return <span className={styles.trHint}>{truncated}</span>;
}

/**
 * For a running state we want "读取 package.json" → "读取 package.json"
 * rephrased as "正在读取 package.json…".  The leading verb is duplicated
 * if we prepend "正在" blindly (e.g. 正在正在读取…).  Strip the leading
 * action verb produced by describeTool() so we can re-compose cleanly.
 */
function stripLeadingAction(desc: string): string {
  // 读取 / 写入 / 检查 / 获取 / 执行 / 查询 / 计算 / 搜索 / 解析 / 生成图表 / 创建 / 删除 / 复制 / 移动 / 转换 / 调用
  return desc.replace(/^(读取|写入|检查|获取|执行|查询|计算|搜索|解析|生成图表|创建|删除|复制|移动|转换|调用)\s*/, '');
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
