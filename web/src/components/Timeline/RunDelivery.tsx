// 展示 Host 的交付投影；不在浏览器重新解释 Trace 或判断检查是否通过。
import { useEffect, useState } from 'react';
import type { RunDelivery as Delivery, DeliveryFile } from '../../../../src/host/run-delivery';
import {
  fetchRunDelivery,
  downloadWorkspaceFile,
  openFileInDefaultBrowser,
  workspaceFileUrl,
} from '../../api';
import { useI18n } from '../../i18n';
import type { HostEvent } from '../../types';
import { FileModal } from '../FileModal';
import styles from './RunDelivery.module.css';

export function RunDelivery({
  runId,
  status,
  events,
}: {
  runId: string;
  status: string;
  events: HostEvent[];
}) {
  const { t } = useI18n();
  const [data, setData] = useState<Delivery>();
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [file, setFile] = useState<DeliveryFile>();
  const [actionError, setActionError] = useState(false);
  const terminal = status !== 'running' && status !== 'stopping';
  useEffect(() => {
    if (!terminal) return;
    let active = true;
    setFailed(false);
    fetchRunDelivery(runId)
      .then((value) => {
        if (active) setData(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [runId, terminal, events.length, refresh]);
  // 空状态不占用回复空间；统计数和运行终态本身不是需要展示的交付信息。
  if (
    !terminal ||
    !data ||
    !(data.files.length || data.checks.length || data.unfinished.length || data.diagnostics.length)
  )
    return null;
  async function act(action: () => Promise<unknown>) {
    setActionError(false);
    try {
      await action();
    } catch {
      setActionError(true);
    }
    setRefresh((value) => value + 1);
  }
  return (
    <div className={styles.delivery}>
      {failed && <p role="alert">{t('delivery.loadFailed')}</p>}
      {(data.files.length > 0 || failed) && (
        <button type="button" onClick={() => setRefresh((value) => value + 1)}>
          {t('delivery.refresh')}
        </button>
      )}
      {data && (
        <>
          {data.files.length > 0 && (
            <div>
              <strong>{t('delivery.files')}</strong>
              <ul>
                {data.files.map((item) => (
                  <li key={item.name}>
                    <span className={styles.name}>{item.name}</span>
                    <small>
                      {t(item.source === 'tool' ? 'delivery.recorded' : 'delivery.reported')} ·{' '}
                      {t(`delivery.${item.status}`)}
                    </small>
                    {item.status !== 'unavailable' && (
                      <span className={styles.actions}>
                        <button type="button" onClick={() => setFile(item)}>
                          {t('timeline.files.view')}
                        </button>
                        {/\.html?$/i.test(item.name) && (
                          <button
                            type="button"
                            onClick={() =>
                              void act(() => openFileInDefaultBrowser(runId, item.name))
                            }
                          >
                            {t('timeline.files.open')}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void act(() => downloadWorkspaceFile(runId, item.name))}
                        >
                          {t('composer.attachment.download')}
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <small>{t('delivery.currentFiles')}</small>
            </div>
          )}
          {data.checks.length > 0 && (
            <details>
              <summary>
                {t('delivery.evidence')} · {data.checks.length}
              </summary>
              <p>{t('delivery.checkNote')}</p>
              <ul>
                {data.checks.map((check, i) => (
                  <li key={i}>
                    <strong>{t(`delivery.${check.status}`)}</strong> ·{' '}
                    {t('delivery.step', { step: check.step })}
                    <code>{check.command}</code>
                    <TraceRecord events={events} step={check.step} />
                  </li>
                ))}
              </ul>
            </details>
          )}
          {data.unfinished.length > 0 && (
            <details>
              <summary>
                {t('delivery.unfinished')} · {data.unfinished.length}
              </summary>
              <ul>
                {data.unfinished.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </details>
          )}
          {data.diagnostics.length > 0 && (
            <details>
              <summary>
                {t('delivery.diagnostics')} · {data.diagnostics.length}
              </summary>
              <p>
                {t('delivery.stats', {
                  calls: data.stats.toolCalls,
                  seconds: (data.stats.toolMs / 1000).toFixed(1),
                  tokens: data.stats.tokens,
                })}
              </p>
              <p>{t('delivery.diagnosticNote')}</p>
              <ul>
                {data.diagnostics.map((item, i) => (
                  <li key={i}>
                    {t(`delivery.${item.kind}`)} · {item.tool} ·{' '}
                    {t('delivery.step', { step: item.step })}
                    <TraceRecord events={events} step={item.step} />
                    {item.durationMs !== undefined && ` · ${(item.durationMs / 1000).toFixed(1)}s`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {actionError && <p role="alert">{t('delivery.actionFailed')}</p>}
      {file &&
        (/\.(png|jpe?g|gif|webp)$/i.test(file.name) ? (
          <div>
            <button type="button" onClick={() => setFile(undefined)}>
              {t('common.close')}
            </button>
            <img
              className={styles.image}
              src={workspaceFileUrl(runId, file.name)}
              alt={file.name}
            />
          </div>
        ) : /\.(pdf|docx?|xlsx?|pptx?|zip)$/i.test(file.name) ? (
          <p>
            {t('delivery.binary')}{' '}
            <button type="button" onClick={() => setFile(undefined)}>
              {t('common.close')}
            </button>
          </p>
        ) : (
          <FileModal runId={runId} file={file} onClose={() => setFile(undefined)} />
        ))}
    </div>
  );
}

function TraceRecord({ events, step }: { events: HostEvent[]; step: number }) {
  const { t } = useI18n();
  const index = events.findIndex((event) => event.type === 'tool_call' && event.step === step);
  if (index < 0) return null;
  const call = events[index];
  if (call.type !== 'tool_call') return null;
  const end = events.findIndex((event, i) => i > index && event.type === 'tool_call');
  const outcomes = events
    .slice(index + 1, end < 0 ? undefined : end)
    .filter(
      (event) =>
        (event.type === 'tool_result' || event.type === 'tool_error') && event.tool === call.tool,
    );
  return (
    <details>
      <summary>{t('delivery.record')}</summary>
      <pre>{JSON.stringify(call.args, null, 2)}</pre>
      {outcomes.map((event, i) => (
        <pre key={i}>
          {event.type === 'tool_result'
            ? event.result
            : event.type === 'tool_error'
              ? event.error
              : ''}
        </pre>
      ))}
    </details>
  );
}
