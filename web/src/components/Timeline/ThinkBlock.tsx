import { useState } from 'react';
import { useI18n } from '../../i18n';
import { ChevronDownIcon, ThinkIcon } from '../icons';
import styles from './ThinkBlock.module.css';

interface ThinkBlockProps {
  text: string;
  /**
   * 行首标签。默认「思考过程」。
   * 同一个形状也用于**每步的分析叙述**（Timeline 里 group.reasoning.visible）——
   * 那里传「分析」，把原先每步铺 520 字正文的写法收成一行预览，避免十几轮下来
   * 堆成一堵墙（参考实现的「已完成分析」就是这个位置）。
   */
  label?: string;
  /** aria-label，默认「模型思考」。 */
  ariaLabel?: string;
}

export function ThinkBlock({ text, label, ariaLabel }: ThinkBlockProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, ' ').trim();
  const shortPreview = preview.length > 180 ? `${preview.slice(0, 180)}…` : preview;

  return (
    <section className={styles.block} aria-label={ariaLabel ?? t('timeline.think.ariaLabel')}>
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={styles.iconSlot} aria-hidden="true">
          <ThinkIcon size={16} className={styles.atomIcon} />
          <ChevronDownIcon size={14} className={styles.hoverIcon} />
        </span>
        <span className={styles.label}>{label ?? t('timeline.think.label')}</span>
        {!open && (
          <>
            <span className={styles.separator}>·</span>
            <span className={styles.preview}>{shortPreview}</span>
          </>
        )}
      </button>

      {open && <div className={styles.content}>{text}</div>}
    </section>
  );
}
