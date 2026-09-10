// 计划清单面板：Run 运行中展开显示"要做什么 / 做到哪"，终态自动折叠为一行摘要。
// 数据来自 plan-state.derivePlan（事件派生，无本地状态）；面板本身不持有计划状态。

import { memo, useState } from 'react';
import { ChevronDownIcon } from '../icons';
import styles from './PlanPanel.module.css';
import type { PlanItemStatus, PlanView } from './plan-state';

const STATUS_MARK: Record<PlanItemStatus, string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✓',
};

const STATUS_TEXT: Record<PlanItemStatus, string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
};

export const PlanPanel = memo(function PlanPanel({
  plan,
  running,
}: {
  plan: PlanView;
  running: boolean;
}) {
  // 默认跟随 Run 状态（运行中展开、结束后折叠）；用户点过之后以用户选择为准。
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? running;
  const percent = plan.total > 0 ? Math.round((plan.completed / plan.total) * 100) : 0;

  return (
    <section className={styles.panel} aria-label="任务计划">
      <button
        type="button"
        className={styles.header}
        onClick={() => setUserToggled(!expanded)}
        aria-expanded={expanded}
      >
        <span className={styles.title}>计划</span>
        <span className={styles.count}>
          {plan.completed}/{plan.total}
        </span>
        <span className={styles.bar} aria-hidden="true">
          <span
            className={`${styles.barFill} ${plan.allDone ? styles.barFillDone : ''}`}
            style={{ width: `${percent}%` }}
          />
        </span>
        {!expanded && <span className={styles.summary}>{summarize(plan)}</span>}
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
              <span className={styles.statusText}>{STATUS_TEXT[item.status]}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
});

function summarize(plan: PlanView): string {
  if (plan.allDone) return `全部完成（${plan.total} 项）`;
  const active = plan.items.find((item) => item.status === 'in_progress');
  return active ? `进行中：${active.title}` : `待办 ${plan.total - plan.completed} 项`;
}
