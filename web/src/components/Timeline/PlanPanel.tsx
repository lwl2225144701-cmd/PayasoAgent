// 计划清单面板：Run 运行中展开显示"要做什么 / 做到哪"，终态自动折叠为一行摘要。
// 数据来自 plan-state.derivePlan（事件派生，无本地状态）；面板本身不持有计划状态。

import { memo, useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/messages';
import { translate } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
import { ChevronDownIcon } from '../icons';
import styles from './PlanPanel.module.css';
import type { PlanItemStatus, PlanView } from './plan-state';

const STATUS_MARK: Record<PlanItemStatus, string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✓',
};

// 用户可见的「计划项状态」按语言取的 key：状态词本体在 common 消息表（跨领域复用）。
const STATUS_TEXT_KEY: Record<PlanItemStatus, MessageKey> = {
  pending: 'common.status.pending',
  in_progress: 'common.status.inProgress',
  completed: 'common.status.completed',
};

export const PlanPanel = memo(function PlanPanel({
  plan,
  running,
}: {
  plan: PlanView;
  running: boolean;
}) {
  const { t, language } = useI18n();
  // 默认跟随 Run 状态（运行中展开、结束后折叠）；用户点过之后以用户选择为准。
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? running;
  const percent = plan.total > 0 ? Math.round((plan.completed / plan.total) * 100) : 0;

  return (
    <section className={styles.panel} aria-label={t('timeline.plan.ariaLabel')}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setUserToggled(!expanded)}
        aria-expanded={expanded}
      >
        <span className={styles.title}>{t('timeline.plan.title')}</span>
        <span className={styles.count}>
          {plan.completed}/{plan.total}
        </span>
        <span className={styles.bar} aria-hidden="true">
          <span
            className={`${styles.barFill} ${plan.allDone ? styles.barFillDone : ''}`}
            style={{ width: `${percent}%` }}
          />
        </span>
        {!expanded && <span className={styles.summary}>{summarize(plan, running, language)}</span>}
        <ChevronDownIcon size={14} className={expanded ? styles.chevronOpen : styles.chevron} />
      </button>

      {expanded && (
        <ol className={styles.list} aria-live="polite">
          {plan.items.map((item) => (
            <li key={item.id} className={`${styles.item} ${styles[item.status]}`}>
              <span className={styles.mark} aria-hidden="true">
                {STATUS_MARK[item.status]}
              </span>
              <span className={styles.itemTitle}>{item.title}</span>
              <span className={styles.statusText}>{t(STATUS_TEXT_KEY[item.status])}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
});

function summarize(plan: PlanView, running: boolean, language: LanguageMode): string {
  if (plan.allDone) {
    return translate(language, 'timeline.plan.summaryAllDone', { count: plan.total });
  }
  // 终态仍有未完成项：如实说明（对应 trace 里的 plan_incomplete_at_finish 审计事件）。
  if (!running) {
    return translate(language, 'timeline.plan.summaryIncomplete', {
      count: plan.total - plan.completed,
    });
  }
  const active = plan.items.find((item) => item.status === 'in_progress');
  return active
    ? translate(language, 'timeline.plan.summaryActive', { title: active.title })
    : translate(language, 'timeline.plan.summaryPending', { count: plan.total - plan.completed });
}
