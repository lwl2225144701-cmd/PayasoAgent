import { useState } from 'react';
import { workspaceFileUrl } from '../../api';
import { formatDurationMs, previewArgs, toolStatusLabel } from '../../format';
import { useI18n } from '../../i18n';
import { translate } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
import {
  ChartIcon,
  ChevronRightIcon,
  FileIcon,
  ListIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from '../icons';
import type { ToolCallData } from './index';
import styles from './Timeline.module.css';

interface ToolActionRowProps {
  data: ToolCallData;
  runId: string;
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
export function ToolActionRow({ data, runId }: ToolActionRowProps) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const toolName = displayToolName(data.tool);
  const argsPreview = previewArgs(data.args);
  const statusLabel = toolStatusLabel(data.status, language);
  const statusClass =
    data.status === 'running'
      ? styles.trRunning
      : data.status === 'failed'
        ? styles.trFailed
        : styles.trDone;

  return (
    <li className={`${styles.toolRow} ${statusClass}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={styles.toolRowClickable}
        aria-label={t('timeline.tool.ariaLabel', {
          tool: toolName,
          args: argsPreview,
          status: statusLabel,
        })}
      >
        <span className={styles.toolIcon} aria-hidden="true">
          <ToolIcon tool={data.tool} />
        </span>
        <span className={styles.toolCallSummary}>
          <span className={styles.toolName}>{toolName}</span>
          {argsPreview && <code className={styles.toolArgs}>{argsPreview}</code>}
        </span>

        {data.status !== 'completed' && (
          <span className={styles.toolStatus}>
            <span
              className={styles[`toolStatus${data.status[0].toUpperCase()}${data.status.slice(1)}`]}
              aria-hidden="true"
            />
            <span>{statusLabel}</span>
          </span>
        )}

        <span className={styles.trChevron}>
          <ChevronRightIcon size={14} className={`${styles.chev} ${open ? styles.chevOpen : ''}`} />
        </span>
      </button>

      {data.status === 'running' && data.liveOutput && (
        <div className={styles.toolLiveOutput}>
          <span className={styles.toolLiveOutputLabel}>{t('timeline.tool.liveOutput')}</span>
          {data.liveOutput}
        </div>
      )}

      {data.images && data.images.length > 0 && (
        <div className={styles.toolImageStrip}>
          {data.images.map((img) => (
            <a
              key={img.path}
              href={workspaceFileUrl(runId, img.path)}
              target="_blank"
              rel="noreferrer"
              title={img.path}
              className={styles.toolImageLink}
            >
              <img
                src={workspaceFileUrl(runId, img.path)}
                alt={img.path}
                loading="lazy"
                className={styles.toolImage}
              />
            </a>
          ))}
        </div>
      )}

      {open && (
        <div className={styles.toolDetail}>
          {data.args != null && (
            <DetailRow label={t('timeline.tool.args')}>
              <pre className={styles.pre}>
                {typeof data.args === 'string' ? data.args : JSON.stringify(data.args, null, 2)}
              </pre>
            </DetailRow>
          )}
          {data.result != null && (
            <DetailRow label={t('timeline.tool.result')}>
              <pre className={styles.pre}>{prettyResult(data.result, language)}</pre>
            </DetailRow>
          )}
          {data.error != null && (
            <DetailRow label={t('timeline.tool.error')}>
              <pre className={styles.preErr}>
                {typeof data.error === 'string' ? data.error : String(data.error)}
              </pre>
            </DetailRow>
          )}
          <div className={styles.detailMeta}>
            <span>{statusLabel}</span>
            {typeof data.durationMs === 'number' && (
              <span>{formatDurationMs(data.durationMs, language)}</span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function ToolIcon({ tool }: { tool: string }) {
  const normalized = tool.toLowerCase();
  if (/(exec|run|shell|command|bash)/.test(normalized)) return <TerminalIcon size={15} />;
  if (/(read|write|edit|file|move|delete)/.test(normalized)) return <FileIcon size={15} />;
  if (/(list|dir|glob)/.test(normalized)) return <ListIcon size={15} />;
  if (/(search|query|grep)/.test(normalized)) return <SearchIcon size={15} />;
  if (/(calculate|calc|compute)/.test(normalized)) return <ChartIcon size={15} />;
  return <WrenchIcon size={15} />;
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

function prettyResult(result: unknown, language: LanguageMode): string {
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
