// 模块: Timeline 审批与工具链准备卡片 —— JIT 网络批准 / 工具链缺失准备 / 准备完成重试
// 职责边界：自包含组件——派生（pending/prepared/phases）与交互状态（resolving）都在内部，
//   父级只传事件流与 runId。三类卡片都要求"用户显式动作"，没有任何自动路径。

import { useMemo, useRef, useState } from 'react';
import {
  cancelToolchainPreparation,
  resolveApproval,
  resolveToolchainPreparation,
} from '../../api';
import { useI18n } from '../../i18n';
import { translate } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
import type {
  ApprovalRequestedEvent,
  HostEvent,
  ToolchainPreparationPhase,
  ToolchainPreparationRequestedEvent,
} from '../../types';
import { composeToolchainRetryMessage, findLastFailedShellCommand } from './preparation-retry';
import styles from './Timeline.module.css';

function preparationPhaseLabel(phase: ToolchainPreparationPhase, language: LanguageMode): string {
  switch (phase) {
    case 'checking':
      return translate(language, 'timeline.preparation.checking');
    case 'installing':
      return translate(language, 'timeline.preparation.installing');
    case 'verifying':
      return translate(language, 'timeline.preparation.verifying');
  }
}

export function TimelineApprovals({
  events,
  runId,
  runActive,
  onRetryCommand,
}: {
  events: HostEvent[];
  runId: string;
  /** Run 仍在运行：准备完成后的"重新执行"入口禁用（等本轮结束）。 */
  runActive: boolean;
  // v1.6 工具链闭环②：准备成功后用户显式重试 —— 以新会话轮次发起
  // （新轮次拥有全新 side-effect 身份空间；Runtime 不自动重放）
  onRetryCommand?: (message: string) => void;
}) {
  const { t, language } = useI18n();

  // ---- v2.0.1 JIT Approval：收集未裁决的批准请求，用户点击后回传 Host ----
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const resolvedIdsRef = useRef<Set<string>>(new Set());
  const pendingApprovals = useMemo(() => {
    if (!events.length) return [];
    // 已裁决的（approval_resolved）不显示
    const resolved = new Set(
      events
        .filter(
          (e): e is Extract<HostEvent, { type: 'approval_resolved' }> =>
            e.type === 'approval_resolved',
        )
        .map((e) => e.requestId),
    );
    return events.filter(
      (e): e is ApprovalRequestedEvent =>
        e.type === 'approval_requested' && !resolved.has(e.requestId),
    );
  }, [events]);

  const handleApproval = async (ev: ApprovalRequestedEvent, approved: boolean) => {
    setResolvingIds((prev) => new Set(prev).add(ev.requestId));
    try {
      await resolveApproval(runId, ev.requestId, approved);
      resolvedIdsRef.current.add(ev.requestId);
    } catch {
      // 网络失败：保留卡片让用户重试
      setResolvingIds((prev) => {
        const next = new Set(prev);
        next.delete(ev.requestId);
        return next;
      });
    }
  };

  const [resolvingPreparationIds, setResolvingPreparationIds] = useState<Set<string>>(new Set());
  const pendingPreparations = useMemo(() => {
    if (!events.length) return [];
    const resolved = new Set(
      events
        .filter(
          (e): e is Extract<HostEvent, { type: 'toolchain_preparation_resolved' }> =>
            e.type === 'toolchain_preparation_resolved',
        )
        .map((e) => e.requestId),
    );
    return events.filter(
      (e): e is ToolchainPreparationRequestedEvent =>
        e.type === 'toolchain_preparation_requested' && !resolved.has(e.requestId),
    );
  }, [events]);

  const preparationPhases = useMemo(() => {
    const phases = new Map<string, ToolchainPreparationPhase>();
    for (const event of events) {
      if (event.type === 'toolchain_preparation_started') {
        phases.set(event.requestId, event.phase);
      } else if (event.type === 'toolchain_preparation_progress') {
        phases.set(event.requestId, event.phase);
      }
    }
    return phases;
  }, [events]);

  // v1.6 工具链闭环②：prepared 的准备请求 → 展示"重新执行刚才的命令"入口。
  // 点击以新会话轮次发起（全新 side-effect 身份空间），由用户显式触发。
  const preparedResolutions = useMemo(() => {
    if (!events.length) return [];
    return events.filter(
      (e): e is Extract<HostEvent, { type: 'toolchain_preparation_resolved' }> =>
        e.type === 'toolchain_preparation_resolved' && e.approved === true && e.prepared === true,
    );
  }, [events]);
  const retryCommand = useMemo(() => findLastFailedShellCommand(events), [events]);

  const handleToolchainPreparation = async (
    ev: ToolchainPreparationRequestedEvent,
    action: 'approve' | 'deny' | 'cancel',
  ) => {
    setResolvingPreparationIds((prev) => new Set(prev).add(ev.requestId));
    try {
      if (action === 'cancel') {
        await cancelToolchainPreparation(runId, ev.requestId);
      } else {
        await resolveToolchainPreparation(runId, ev.requestId, action === 'approve');
      }
    } catch {
      // Keep the card visible so the user can retry when the Host is reachable.
    } finally {
      setResolvingPreparationIds((prev) => {
        const next = new Set(prev);
        next.delete(ev.requestId);
        return next;
      });
    }
  };

  return (
    <>
      {pendingApprovals.length > 0 && (
        <div className={styles.approvalList}>
          {pendingApprovals.map((ev) => (
            <div key={ev.requestId} className={styles.approvalCard}>
              <div className={styles.approvalTitle}>{t('timeline.approval.networkTitle')}</div>
              <div className={styles.approvalBody}>
                <code>{ev.toolName}</code> {t('timeline.approval.networkBody')}
                <span className={styles.approvalArgs}>
                  {JSON.stringify(ev.args ?? {}).slice(0, 120)}
                </span>
              </div>
              <div className={styles.approvalActions}>
                <button
                  type="button"
                  className={styles.approvalAllow}
                  disabled={resolvingIds.has(ev.requestId)}
                  onClick={() => void handleApproval(ev, true)}
                >
                  {resolvingIds.has(ev.requestId)
                    ? t('timeline.approval.submitting')
                    : t('timeline.approval.allow')}
                </button>
                <button
                  type="button"
                  className={styles.approvalDeny}
                  disabled={resolvingIds.has(ev.requestId)}
                  onClick={() => void handleApproval(ev, false)}
                >
                  {t('timeline.approval.deny')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {pendingPreparations.length > 0 && (
        <div className={styles.approvalList}>
          {pendingPreparations.map((ev) => (
            <div key={ev.requestId} className={styles.approvalCard}>
              <div className={styles.approvalTitle}>{t('timeline.preparation.title')}</div>
              <div className={styles.approvalBody}>
                {t('timeline.preparation.missingPrefix')} <code>{ev.toolName}</code>
                {t('timeline.preparation.missingSuffix')}
                <span className={styles.approvalArgs}>
                  {t('timeline.preparation.detail', {
                    source: ev.source,
                    packageName: ev.packageName,
                  })}
                </span>
                {preparationPhases.has(ev.requestId) && (
                  <span className={styles.approvalProgress}>
                    {preparationPhaseLabel(preparationPhases.get(ev.requestId)!, language)}
                  </span>
                )}
              </div>
              <div className={styles.approvalActions}>
                {preparationPhases.has(ev.requestId) ? (
                  <button
                    type="button"
                    className={styles.approvalDeny}
                    disabled={resolvingPreparationIds.has(ev.requestId)}
                    onClick={() => void handleToolchainPreparation(ev, 'cancel')}
                  >
                    {resolvingPreparationIds.has(ev.requestId)
                      ? t('timeline.preparation.cancelling')
                      : t('timeline.preparation.cancel')}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.approvalAllow}
                      disabled={resolvingPreparationIds.has(ev.requestId)}
                      onClick={() => void handleToolchainPreparation(ev, 'approve')}
                    >
                      {resolvingPreparationIds.has(ev.requestId)
                        ? t('timeline.approval.submitting')
                        : t('timeline.preparation.approve')}
                    </button>
                    <button
                      type="button"
                      className={styles.approvalDeny}
                      disabled={resolvingPreparationIds.has(ev.requestId)}
                      onClick={() => void handleToolchainPreparation(ev, 'deny')}
                    >
                      {t('timeline.approval.deny')}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {preparedResolutions.length > 0 && (
        <div className={styles.approvalList}>
          {preparedResolutions.map((ev) => (
            <div key={`prepared-${ev.requestId}`} className={styles.approvalCard}>
              <div className={styles.approvalTitle}>{t('timeline.prepared.title')}</div>
              <div className={styles.approvalBody}>
                {t('timeline.prepared.body')}
                {!retryCommand && (
                  <span className={styles.approvalArgs}>
                    {t('timeline.prepared.noFailedCommand')}
                  </span>
                )}
              </div>
              <div className={styles.approvalActions}>
                <button
                  type="button"
                  className={styles.approvalAllow}
                  disabled={runActive || !retryCommand || !onRetryCommand}
                  title={
                    runActive
                      ? t('timeline.prepared.retryBlockedRunning')
                      : !retryCommand
                        ? t('timeline.prepared.retryBlockedNoCommand')
                        : undefined
                  }
                  onClick={() => {
                    if (retryCommand && onRetryCommand) {
                      onRetryCommand(composeToolchainRetryMessage(retryCommand, language));
                    }
                  }}
                >
                  {t('timeline.prepared.retry')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
